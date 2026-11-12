//! Redact external content before storage without changing protocol identities.
use latte_work_protocol::EventKind;
use serde_json::Value;
use std::collections::BTreeSet;

const MASK: &str = "[redacted]";

// Decode one ordinary JSON string layer, retaining source offsets so masking
// never rewrites unrelated prose. This accepts mixed escapes and either hex case
// without enumerating exponentially many spellings of each secret.
struct Decoded {
    text: String,
    offsets: Vec<(usize, usize)>,
    partial: Option<usize>,
}
impl Decoded {
    fn new(source: &str) -> Self {
        let mut value = Self {
            text: String::new(),
            offsets: Vec::new(),
            partial: None,
        };
        let mut at = 0;
        while at < source.len() {
            let rest = &source[at..];
            let ch = rest.chars().next().expect("nonempty suffix");
            if ch == '\\' {
                match json_escape(rest) {
                    Escape::Character(ch, size) => {
                        value.text.push(ch);
                        at += size;
                        value.offsets.push((value.text.len(), at));
                        continue;
                    }
                    Escape::Partial => {
                        value.partial = Some(at);
                        break;
                    }
                    Escape::Invalid => {}
                }
            }
            value.text.push(ch);
            at += ch.len_utf8();
        }
        value
    }

    fn source_offset(&self, offset: usize) -> usize {
        let index = self
            .offsets
            .partition_point(|(decoded, _)| *decoded <= offset);
        self.offsets
            .get(index.wrapping_sub(1))
            .map_or(offset, |(decoded, source)| offset + source - decoded)
    }

    /// Re-decoding a retained suffix must start before a whole escape, not
    /// inside a backslash pair, Unicode escape, or surrogate pair.
    fn source_boundary(&self, offset: usize) -> usize {
        if let Some(start) = self.partial.filter(|start| *start < offset) {
            return start;
        }
        let index = self.offsets.partition_point(|(_, end)| *end <= offset);
        if let Some((decoded_end, _)) = self.offsets.get(index) {
            let width = self.text[..*decoded_end]
                .chars()
                .next_back()
                .expect("decoded escape")
                .len_utf8();
            let start = self.source_offset(decoded_end - width);
            if start < offset {
                return start;
            }
        }
        offset
    }

    fn source_boundary_after(&self, offset: usize, source_len: usize) -> usize {
        if self.source_boundary(offset) == offset {
            return offset;
        }
        let index = self.offsets.partition_point(|(_, end)| *end < offset);
        // Closed values can consume an incomplete escape through EOF. Streaming
        // defers such matches until the whole token arrives.
        self.offsets.get(index).map_or(source_len, |(_, end)| *end)
    }
}
enum Escape {
    Character(char, usize),
    Partial,
    Invalid,
}
fn json_escape(text: &str) -> Escape {
    let bytes = text.as_bytes();
    let Some(&kind) = bytes.get(1) else {
        return Escape::Partial;
    };
    let short = match kind {
        b'"' => '"',
        b'\\' => '\\',
        b'/' => '/',
        b'b' => '\u{8}',
        b'f' => '\u{c}',
        b'n' => '\n',
        b'r' => '\r',
        b't' => '\t',
        b'u' => {
            let hex = |start: usize| -> Option<u16> {
                let digits = bytes.get(start..start + 4)?;
                digits.iter().try_fold(0u16, |n, digit| {
                    Some(n * 16 + (*digit as char).to_digit(16)? as u16)
                })
            };
            if bytes[2..bytes.len().min(6)]
                .iter()
                .any(|b| !b.is_ascii_hexdigit())
            {
                return Escape::Invalid;
            }
            if bytes.len() < 6 {
                return Escape::Partial;
            }
            let Some(first) = hex(2) else {
                return Escape::Invalid;
            };
            if (0xd800..=0xdbff).contains(&first) {
                let second = &bytes[6..bytes.len().min(12)];
                if second.iter().enumerate().any(|(i, b)| match i {
                    0 => *b != b'\\',
                    1 => *b != b'u',
                    _ => !b.is_ascii_hexdigit(),
                }) {
                    return Escape::Invalid;
                }
                if bytes.len() < 12 {
                    return Escape::Partial;
                }
                let Some(last) = hex(8).filter(|n| (0xdc00..=0xdfff).contains(n)) else {
                    return Escape::Invalid;
                };
                let code = 0x10000 + ((u32::from(first) - 0xd800) << 10) + u32::from(last) - 0xdc00;
                return Escape::Character(char::from_u32(code).expect("surrogate pair"), 12);
            }
            return char::from_u32(u32::from(first))
                .map_or(Escape::Invalid, |ch| Escape::Character(ch, 6));
        }
        _ => return Escape::Invalid,
    };
    Escape::Character(short, 2)
}

struct Pattern {
    text: String,
    prefixes: Vec<usize>,
}
pub struct Redactor {
    patterns: Vec<Pattern>,
}
impl Redactor {
    pub fn new(values: impl IntoIterator<Item = String>) -> Self {
        let patterns: BTreeSet<_> = values.into_iter().filter(|v| !v.is_empty()).collect();
        Self {
            patterns: patterns
                .into_iter()
                .map(|text| {
                    let bytes = text.as_bytes();
                    let mut prefixes = vec![0; bytes.len()];
                    for i in 1..bytes.len() {
                        let mut length = prefixes[i - 1];
                        while length > 0 && bytes[i] != bytes[length] {
                            length = prefixes[length - 1];
                        }
                        if bytes[i] == bytes[length] {
                            length += 1;
                        }
                        prefixes[i] = length;
                    }
                    Pattern { text, prefixes }
                })
                .collect(),
        }
    }

    /// Merge all overlapping raw/decoded matches at whole escape boundaries.
    /// The third offset bounds emission when a raw match touches an unfinished
    /// escape: streaming must wait for that token before replacing the match.
    /// Metadata is bounded by the input record, not the number of matches.
    fn complete(&self, text: &str, streaming: bool) -> (String, usize, usize) {
        if self.patterns.is_empty() {
            return (String::new(), 0, text.len());
        }
        let decoded = text.contains('\\').then(|| Decoded::new(text));
        let limit = decoded
            .as_ref()
            .filter(|_| streaming)
            .and_then(|decoded| {
                let partial = decoded.partial?;
                self.patterns
                    .iter()
                    .filter_map(|pattern| {
                        // Only this bounded tail can contain a raw match that
                        // extends into the incomplete token.
                        let from = partial.saturating_sub(pattern.text.len() - 1);
                        pattern
                            .matches(&text.as_bytes()[from..])
                            .find(|(_, end)| from + end > partial)
                            .map(|(start, _)| decoded.source_boundary(from + start))
                    })
                    .min()
            })
            .unwrap_or(text.len());
        let mut matches = Vec::new();
        for pattern in &self.patterns {
            let raw: Box<dyn Iterator<Item = (usize, usize)>> =
                Box::new(pattern.matches(text.as_bytes()).map(|(start, end)| {
                    decoded.as_ref().map_or((start, end), |decoded| {
                        (
                            decoded.source_boundary(start),
                            decoded.source_boundary_after(end, text.len()),
                        )
                    })
                }));
            matches.push(raw.peekable());
            if let Some(decoded) = &decoded {
                let escaped: Box<dyn Iterator<Item = (usize, usize)>> = Box::new(
                    pattern
                        .matches(decoded.text.as_bytes())
                        .map(|(start, end)| {
                            (decoded.source_offset(start), decoded.source_offset(end))
                        }),
                );
                matches.push(escaped.peekable());
            }
        }
        let mut output = String::new();
        let mut end = 0;
        loop {
            let next = matches
                .iter_mut()
                .filter_map(|m| m.peek().copied())
                .min_by_key(|(start, end)| (*start, std::cmp::Reverse(*end)));
            let Some((start, next_end)) = next else { break };
            if start >= limit {
                break;
            }
            output.push_str(&text[end..start]);
            output.push_str(MASK);
            end = next_end.min(limit);
            loop {
                let previous = end;
                for matches in &mut matches {
                    while matches.peek().is_some_and(|(start, _)| *start < end) {
                        let (_, next_end) = matches.next().expect("peeked match");
                        end = end.max(next_end.min(limit));
                    }
                }
                if end == previous {
                    break;
                }
            }
        }
        (output, end, limit)
    }

    pub fn text(&self, text: &str) -> String {
        let (mut output, end, _) = self.complete(text, false);
        output.push_str(&text[end..]);
        output
    }

    /// Withhold possible secret prefixes at JSON escape boundaries. KMP bounds
    /// suffix matching; retained bytes are at most six times the longest secret
    /// plus one incomplete escape (12 bytes), independent of stream length.
    pub fn fragment(&self, text: &str, pending: &mut String) -> String {
        let mut input = std::mem::take(pending);
        input.push_str(text);
        let (mut output, end, limit) = self.complete(&input, true);
        let remaining = &input[end..];
        let max = self
            .patterns
            .iter()
            .map(|p| p.text.len())
            .max()
            .unwrap_or(0);
        if max == 0 {
            output.push_str(remaining);
            return output;
        }
        // Decode from the actual content boundary. A raw byte window can cut
        // into an arbitrarily long backslash run and reverse escape pairing.
        // KMP still scans only a pattern-sized suffix of the decoded content.
        let decoded = Decoded::new(remaining);
        let mut tail = decoded.partial.map_or(0, |at| remaining.len() - at);
        for pattern in &self.patterns {
            tail = tail.max(pattern.suffix_prefix(remaining));
            let length = pattern.suffix_prefix(&decoded.text);
            if length > 0 {
                tail =
                    tail.max(remaining.len() - decoded.source_offset(decoded.text.len() - length));
            }
        }
        let safe = decoded
            .source_boundary(remaining.len() - tail)
            .min(limit - end);
        output.push_str(&remaining[..safe]);
        pending.push_str(&remaining[safe..]);
        debug_assert!(pending.len() <= max.saturating_mul(6).saturating_add(12));
        output
    }

    /// Native records/pages have independent lifetimes. Never persist an
    /// unfinished prefix in either their events or a durable read cursor.
    pub fn event_at_boundary(&self, event: EventKind) -> EventKind {
        if let EventKind::Text { text } = event {
            let mut pending = String::new();
            let mut text = self.fragment(&text, &mut pending);
            if !pending.is_empty() {
                text.push_str(MASK);
            }
            EventKind::Text { text }
        } else {
            self.event(event)
        }
    }

    fn json(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(items) => items.iter_mut().for_each(|v| self.json(v)),
            Value::Object(fields) => fields.values_mut().for_each(|v| self.json(v)),
            _ => {}
        }
    }

    pub fn event(&self, mut event: EventKind) -> EventKind {
        match &mut event {
            EventKind::Text { text }
            | EventKind::Notice { text }
            | EventKind::User { text, .. }
            | EventKind::QueuedMessageSent { text, .. } => *text = self.text(text),
            EventKind::Tool { input, .. } | EventKind::Approval { input, .. } => {
                self.json(input);
            }
            EventKind::ToolResult { content, .. } => {
                if let Value::Array(blocks) = content {
                    for block in blocks {
                        // Preserve only the known block envelope. Native extra
                        // fields remain untrusted content and must be redacted.
                        let envelope: &[&str] = match block["type"].as_str() {
                            Some("text") => &["type"],
                            Some("image") => &["type", "mime_type", "data_base64"],
                            _ => &[],
                        };
                        if let Value::Object(fields) = block {
                            for (key, value) in fields {
                                if !envelope.contains(&key.as_str()) {
                                    self.json(value);
                                }
                            }
                        } else {
                            self.json(block);
                        }
                    }
                } else {
                    self.json(content);
                }
            }
            EventKind::Subagent { update } => {
                for text in [&mut update.title, &mut update.summary]
                    .into_iter()
                    .flatten()
                {
                    *text = self.text(text);
                }
            }
            EventKind::Question { questions, .. } => {
                for question in questions {
                    question.header = self.text(&question.header);
                    question.text = self.text(&question.text);
                    for option in &mut question.options {
                        option.label = self.text(&option.label);
                        option.description = self.text(&option.description);
                    }
                }
            }
            EventKind::QuestionResolved { answers, .. } => {
                for answer in answers.iter_mut().flatten() {
                    if let Some(text) = &mut answer.text {
                        *text = self.text(text);
                    }
                }
            }
            EventKind::State { message, .. } => {
                if let Some(text) = message {
                    *text = self.text(text);
                }
            }
            EventKind::TurnChanges { changes } => {
                if let Some(text) = &mut changes.summary.unavailable {
                    *text = self.text(text);
                }
            }
            EventKind::Progress { .. }
            | EventKind::Usage { .. }
            | EventKind::ApprovalResolved { .. } => {}
        }
        event
    }
}

impl Pattern {
    fn matches<'a>(&'a self, text: &'a [u8]) -> impl Iterator<Item = (usize, usize)> + 'a {
        let bytes = self.text.as_bytes();
        let mut at = 0;
        let mut length = 0;
        std::iter::from_fn(move || {
            while let Some(&byte) = text.get(at) {
                at += 1;
                while length > 0 && byte != bytes[length] {
                    length = self.prefixes[length - 1];
                }
                if byte == bytes[length] {
                    length += 1;
                }
                if length == bytes.len() {
                    // Keep the matched suffix so the next occurrence may
                    // overlap this one, unlike str::match_indices.
                    length = self.prefixes[length - 1];
                    return Some((at - bytes.len(), at));
                }
            }
            None
        })
    }

    fn suffix_prefix(&self, text: &str) -> usize {
        let bytes = self.text.as_bytes();
        let suffix = text.as_bytes();
        let mut length = 0;
        for &byte in &suffix[suffix.len().saturating_sub(bytes.len() - 1)..] {
            while length > 0 && byte != bytes[length] {
                length = self.prefixes[length - 1];
            }
            if byte == bytes[length] {
                length += 1;
            }
        }
        length
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_matches_cover_every_overlapping_secret() {
        for (secrets, source) in [
            (["xab", "aba", "bab"], "xababa!"),
            (["中ab", "aba", "bab"], "中ababa!"),
            (["xab", "aba", "bab"], r"x\u0061baba!"),
            (["abc", "cde", "efg"], "abcdefg!"),
        ] {
            let redactor = Redactor::new(secrets.map(str::to_owned));
            let assert_safe = |output: &str| {
                assert!(output.contains(MASK), "{source:?}: {output:?}");
                for secret in secrets {
                    assert!(!output.contains(secret), "{source:?}: {output:?}");
                    let decoded: String = serde_json::from_str(&format!("\"{output}\"")).unwrap();
                    assert!(!decoded.contains(secret), "decoded {source:?}: {output:?}");
                }
            };
            let output = redactor.text(source);
            assert_safe(&output);
            assert_eq!(output, "[redacted]!");
            for split in (0..=source.len()).filter(|at| source.is_char_boundary(*at)) {
                let mut pending = String::new();
                let mut output = redactor.fragment(&source[..split], &mut pending);
                output.push_str(&redactor.fragment(&source[split..], &mut pending));
                assert!(pending.is_empty());
                assert_safe(&output);
            }
        }
    }

    #[test]
    fn complete_raw_matches_preserve_json_escape_pairing() {
        for (secret, source) in [
            (r"\n\", r#"{"secret":"\n\\u005cn\u005c"}"#),
            ("cAB", r#"{"secret":"\u005cAB"}"#),
            ("1Z", r#"{"secret":"\uD83D\uDD11Z"}"#),
            (r"A\u", r#"{"secret":"A\u0042"}"#),
        ] {
            assert!(source.contains(secret));
            let redactor = Redactor::new([secret.to_owned()]);
            let assert_safe = |output: &str| {
                assert!(!output.contains(secret), "raw {output:?}");
                let decoded: Value = serde_json::from_str(output).unwrap();
                let value = decoded["secret"].as_str().unwrap();
                assert!(!value.contains(secret), "recoverable credential: {value:?}");
                assert!(value.contains(MASK));
            };
            assert_safe(&redactor.text(source));
            for split in 0..=source.len() {
                let mut pending = String::new();
                let mut output = redactor.fragment(&source[..split], &mut pending);
                assert!(pending.len() <= secret.len() * 6 + 12);
                output.push_str(&redactor.fragment(&source[split..], &mut pending));
                assert!(pending.is_empty());
                assert_safe(&output);
            }
            for width in 1..=8 {
                let mut pending = String::new();
                let mut output = String::new();
                for chunk in source.as_bytes().chunks(width) {
                    output.push_str(
                        &redactor.fragment(std::str::from_utf8(chunk).unwrap(), &mut pending),
                    );
                    assert!(pending.len() <= secret.len() * 6 + 12);
                }
                assert!(pending.is_empty());
                assert_safe(&output);
            }
        }
    }

    #[test]
    fn raw_and_decoded_credentials_are_absent_in_an_independent_json_matrix() {
        let tokens = [
            r"\\",
            r"\n",
            r"\u005c",
            r"\u006e",
            r"\uD83D\uDD11",
            "n",
            "u005c",
        ];
        for first in tokens {
            for second in tokens {
                for third in tokens {
                    let body = format!("{first}{second}{third}");
                    let source = format!("\"{body}\"");
                    let value: String = serde_json::from_str(&source).unwrap();
                    let mut secrets = BTreeSet::new();
                    for value in [&body, &value] {
                        for (start, _) in value.char_indices() {
                            for end in start + 1..=(start + 4).min(value.len()) {
                                if value.is_char_boundary(end) && !MASK.contains(&value[start..end])
                                {
                                    secrets.insert(value[start..end].to_owned());
                                }
                            }
                        }
                    }
                    for secret in secrets {
                        let redactor = Redactor::new([secret.clone()]);
                        let assert_safe = |output: &str| {
                            assert!(!output.contains(&secret), "{secret:?} in {output:?}");
                            let decoded: String = serde_json::from_str(output).unwrap();
                            assert!(
                                !decoded.contains(&secret),
                                "{source:?} restores {secret:?} from {output:?}"
                            );
                        };
                        assert_safe(&redactor.text(&source));
                        for width in [1, 3] {
                            let mut pending = String::new();
                            let mut output = String::new();
                            for chunk in source.as_bytes().chunks(width) {
                                output.push_str(
                                    &redactor.fragment(
                                        std::str::from_utf8(chunk).unwrap(),
                                        &mut pending,
                                    ),
                                );
                                assert!(pending.len() <= secret.len() * 6 + 12);
                            }
                            assert!(pending.is_empty());
                            assert_safe(&output);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn stream_window_never_changes_backslash_pairing() {
        // A 24-byte window drops the first of 18 backslashes here. Its
        // remaining 17 decode as eight backslashes and a newline, so the old
        // window misses the literal backslash+n credential prefix.
        let secret = r"\nAB";
        let redactor = Redactor::new([secret.into()]);
        let first = format!("{{\"secret\":\"{}n\\u0041", "\\".repeat(18));
        let second = "B\"}";
        let original = format!("{first}{second}");
        let decoded: Value = serde_json::from_str(&original).unwrap();
        assert!(decoded["secret"].as_str().unwrap().ends_with(secret));
        let mut pending = String::new();
        let before = redactor.fragment(&first, &mut pending);
        let after = redactor.fragment(second, &mut pending);
        let replay: Value = serde_json::from_str(&format!("{before}{after}")).unwrap();
        assert!(!replay["secret"].as_str().unwrap().contains(secret));
        assert!(replay["secret"].as_str().unwrap().contains(MASK));
        assert!(pending.is_empty());
    }

    #[test]
    fn retained_suffixes_preserve_escape_boundaries_for_every_stream_split() {
        for secret in [r"\nAB", "\nAB", "a&b", "中文🔑"] {
            let redactor = Redactor::new([secret.to_owned()]);
            for count in [0, 1, 7, 8, 9, 10, 11, 12, 127, 8192] {
                let source = serde_json::to_string(&format!("{}{secret}", "\\".repeat(count)))
                    .unwrap()
                    .replace('A', r"\u0041")
                    .replace('&', r"\u0026");
                let expected = redactor.text(&source);
                assert!(expected.contains(MASK));
                let assert_safe = |output: &str| {
                    assert!(!output.contains(secret));
                    let decoded: String = serde_json::from_str(output).unwrap();
                    assert!(!decoded.contains(secret), "recoverable from {output:?}");
                };
                assert_safe(&expected);
                let splits: Vec<_> = if count < 8192 {
                    (0..=source.len())
                        .filter(|at| source.is_char_boundary(*at))
                        .collect()
                } else {
                    // Keep the long-run regression bounded while cutting on
                    // both sides of the escape and former byte-window edges.
                    (source.len().saturating_sub(64)..=source.len())
                        .filter(|at| source.is_char_boundary(*at))
                        .collect()
                };
                for split in splits {
                    let mut pending = String::new();
                    let first = redactor.fragment(&source[..split], &mut pending);
                    assert!(pending.len() <= secret.len() * 6 + 12);
                    let second = redactor.fragment(&source[split..], &mut pending);
                    assert_safe(&format!("{first}{second}"));
                    assert_eq!(
                        format!("{first}{second}"),
                        expected,
                        "{secret:?}, {count} slashes, split {split}"
                    );
                    assert!(pending.is_empty());
                }
                if count < 8192 {
                    for width in 1..=8 {
                        let mut pending = String::new();
                        let mut output = String::new();
                        let mut at = 0;
                        while at < source.len() {
                            let mut end = (at + width).min(source.len());
                            while !source.is_char_boundary(end) {
                                end += 1;
                            }
                            output.push_str(&redactor.fragment(&source[at..end], &mut pending));
                            assert!(pending.len() <= secret.len() * 6 + 12);
                            at = end;
                        }
                        assert_eq!(
                            output, expected,
                            "{secret:?}, {count} slashes, chunks of {width}"
                        );
                        assert_safe(&output);
                        assert!(pending.is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn suffix_cuts_keep_json_escape_tokens_whole() {
        for source in [
            r"\\\n\u0041",
            r"\\\uD83D\uDD11",
            r#"a\t中\u0041\""#,
            r"\\\uD83D\uDD",
        ] {
            let decoded = Decoded::new(source);
            for cut in (0..=source.len()).filter(|at| source.is_char_boundary(*at)) {
                let boundary = decoded.source_boundary(cut);
                assert!(boundary <= cut && cut - boundary < 12);
                let after = decoded.source_boundary_after(cut, source.len());
                assert!(after >= cut && after - cut < 12);
                if decoded.partial.is_some_and(|start| start < cut) {
                    assert_eq!(after, source.len());
                } else {
                    assert_eq!(decoded.source_boundary(after), after);
                }
                let prefix = Decoded::new(&source[..boundary]);
                let suffix = Decoded::new(&source[boundary..]);
                assert!(prefix.partial.is_none());
                assert_eq!(format!("{}{}", prefix.text, suffix.text), decoded.text);
            }
        }
    }

    #[test]
    fn escaped_values_and_every_stream_split_are_redacted() {
        for secret in [
            "fixture-environment-secret",
            "abc\"def",
            "a\\b\nc",
            "中文🔑",
        ] {
            let redactor = Redactor::new([secret.to_owned()]);
            let encoded = serde_json::to_string(secret).unwrap();
            for value in [secret, &encoded[1..encoded.len() - 1]] {
                for split in (0..=value.len()).filter(|i| value.is_char_boundary(*i)) {
                    let mut pending = String::new();
                    let first =
                        redactor.fragment(&format!("before {}", &value[..split]), &mut pending);
                    assert!(
                        pending.len()
                            <= redactor
                                .patterns
                                .iter()
                                .map(|p| p.text.len() * 6 + 12)
                                .max()
                                .unwrap()
                    );
                    let second =
                        redactor.fragment(&format!("{} after", &value[split..]), &mut pending);
                    assert_eq!(format!("{first}{second}"), "before [redacted] after");
                    assert!(pending.is_empty());
                }
            }
        }
        let redactor = Redactor::new(["中文🔑".into(), "http://user:pwd@host".into()]);
        assert_eq!(redactor.text(r"\u4e2d\u6587\ud83d\udd11"), MASK);
        assert_eq!(redactor.text(r"http:\/\/user:pwd@host"), MASK);
    }

    #[test]
    fn short_secrets_do_not_change_protocol_tags_or_correlation_ids() {
        let redactor = Redactor::new(["text".into(), "running".into(), "approval".into()]);
        let cases = [
            serde_json::json!({"kind":"text","text":"OK"}),
            serde_json::json!({"kind":"tool","id":"text","name":"approval","input":{"body":"text"}}),
            serde_json::json!({"kind":"tool_result","id":"text","content":[{"type":"text","text":"text","extra":{"value":"text"}}],"is_error":false}),
            serde_json::json!({"kind":"state","status":"running","message":"text"}),
            serde_json::json!({"kind":"approval_resolved","request_id":"approval","allow":true}),
        ];
        for value in cases {
            let event: EventKind = serde_json::from_value(value.clone()).unwrap();
            let redacted = serde_json::to_value(redactor.event(event)).unwrap();
            assert_eq!(redacted["kind"], value["kind"]);
            for key in ["id", "name", "request_id", "status"] {
                assert_eq!(redacted[key], value[key]);
            }
            if value["kind"] == "tool_result" {
                assert_eq!(redacted["content"][0]["type"], "text");
                assert_eq!(redacted["content"][0]["text"], MASK);
                assert_eq!(redacted["content"][0]["extra"]["value"], MASK);
            }
        }
    }

    #[test]
    fn json_equivalent_spellings_and_partial_escapes_are_masked_at_every_split() {
        let mut cases = vec![
            ("a&b".to_owned(), r"a\u0026b".to_owned()),
            (
                "A<&>/z".to_owned(),
                r"\u0041\u003c&\u003E\/\u007a".to_owned(),
            ),
            ("中文🔑".to_owned(), r"\u4E2d文\uD83D\uDd11".to_owned()),
            (
                "a\"\\\n\t".to_owned(),
                r"\u0061\u0022\u005c\u000A\t".to_owned(),
            ),
            (r"a\u0026b".to_owned(), r"a\\u0026b".to_owned()),
        ];
        for byte in 32..=126u8 {
            cases.push((
                format!("start{}end", byte as char),
                format!("start\\u{byte:04X}end"),
            ));
        }
        for (secret, encoded) in cases {
            assert_eq!(
                serde_json::from_str::<String>(&format!("\"{encoded}\"")).unwrap(),
                secret
            );
            let redactor = Redactor::new([secret.clone()]);
            let input = format!(r"prefix \u004fK {encoded} !");
            assert_eq!(redactor.text(&input), r"prefix \u004fK [redacted] !");
            for split in (0..=input.len()).filter(|i| input.is_char_boundary(*i)) {
                let mut pending = String::new();
                let first = redactor.fragment(&input[..split], &mut pending);
                assert!(pending.len() <= secret.len() * 6 + 12);
                let second = redactor.fragment(&input[split..], &mut pending);
                assert_eq!(
                    format!("{first}{second}"),
                    r"prefix \u004fK [redacted] !",
                    "{encoded} at {split}"
                );
                assert!(pending.is_empty());
            }
            let mut pending = String::new();
            let output: String = input
                .chars()
                .map(|ch| redactor.fragment(&ch.to_string(), &mut pending))
                .collect();
            assert_eq!(output, r"prefix \u004fK [redacted] !");
            assert!(pending.is_empty());
        }
        // Malformed escapes remain ordinary content; valid surrogate pairs
        // decode once, without treating an escaped backslash as a new escape.
        let redactor = Redactor::new(["&".into(), "🔑".into()]);
        for text in [r"\u00xz", r"\uD83D\u0041", r"\\u0026"] {
            assert_eq!(redactor.text(text), text);
        }
        assert_eq!(Redactor::new([]).text(r"a\u0026b"), r"a\u0026b");
    }

    #[test]
    fn overlapping_secrets_and_markers_do_not_leave_a_complete_secret() {
        let redactor = Redactor::new(["abc".into(), "bcde".into(), "redacted".into()]);
        let mut pending = String::new();
        assert_eq!(redactor.fragment("abc", &mut pending), MASK);
        assert_eq!(redactor.fragment("de", &mut pending), "de");
        assert!(pending.is_empty());
        assert_eq!(redactor.text("abc redacted"), "[redacted] [redacted]");
    }
}

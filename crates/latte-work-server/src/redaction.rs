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

    /// Merge raw/decoded matches with one iterator per pattern. Offset metadata
    /// is bounded by the input record, rather than the number of secret matches.
    fn complete(&self, text: &str) -> (String, usize) {
        if self.patterns.is_empty() {
            return (String::new(), 0);
        }
        let decoded = text.contains('\\').then(|| Decoded::new(text));
        let mut matches = Vec::new();
        for pattern in &self.patterns {
            let raw: Box<dyn Iterator<Item = (usize, usize)>> = Box::new(
                text.match_indices(&pattern.text)
                    .map(|(start, value)| (start, start + value.len())),
            );
            matches.push(raw.peekable());
            if let Some(decoded) = &decoded {
                let escaped: Box<dyn Iterator<Item = (usize, usize)>> = Box::new(
                    decoded
                        .text
                        .match_indices(&pattern.text)
                        .map(|(start, value)| {
                            (
                                decoded.source_offset(start),
                                decoded.source_offset(start + value.len()),
                            )
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
            output.push_str(&text[end..start]);
            output.push_str(MASK);
            end = next_end;
            for matches in &mut matches {
                while matches.peek().is_some_and(|(start, _)| *start < end) {
                    matches.next();
                }
            }
        }
        (output, end)
    }

    pub fn text(&self, text: &str) -> String {
        let (mut output, end) = self.complete(text);
        output.push_str(&text[end..]);
        output
    }

    /// Withhold only the longest suffix that can still become a secret. KMP
    /// bounds work and retained bytes by the configured patterns, not the stream.
    pub fn fragment(&self, text: &str, pending: &mut String) -> String {
        let mut input = std::mem::take(pending);
        input.push_str(text);
        let (mut output, end) = self.complete(&input);
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
        let mut start = remaining.len().saturating_sub(max.saturating_mul(6));
        while !remaining.is_char_boundary(start) {
            start += 1;
        }
        let suffix = &remaining[start..];
        let decoded = Decoded::new(suffix);
        let mut tail = decoded.partial.map_or(0, |at| suffix.len() - at);
        for pattern in &self.patterns {
            tail = tail.max(pattern.suffix_prefix(remaining));
            let length = pattern.suffix_prefix(&decoded.text);
            if length > 0 {
                tail = tail.max(suffix.len() - decoded.source_offset(decoded.text.len() - length));
            }
        }
        let safe = remaining.len() - tail;
        output.push_str(&remaining[..safe]);
        pending.push_str(&remaining[safe..]);
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
                                .map(|p| p.text.len() * 6)
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
                assert!(pending.len() <= secret.len() * 6);
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

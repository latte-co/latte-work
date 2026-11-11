//! Redact external content before storage without changing protocol identities.
use latte_work_protocol::EventKind;
use serde_json::Value;
use std::collections::BTreeSet;

const MASK: &str = "[redacted]";

struct Pattern {
    text: String,
    prefixes: Vec<usize>,
}
pub struct Redactor {
    patterns: Vec<Pattern>,
}
impl Redactor {
    pub fn new(values: impl IntoIterator<Item = String>) -> Self {
        let mut patterns = BTreeSet::new();
        for value in values.into_iter().filter(|v| !v.is_empty()) {
            // A JSON document can itself be embedded in a text delta. At that
            // point its escaped strings have not been decoded by the adapter.
            let encoded = serde_json::to_string(&value).expect("string serialization");
            let escaped = &encoded[1..encoded.len() - 1];
            let mut ascii = String::new();
            for ch in escaped.chars() {
                if ch.is_ascii() {
                    ascii.push(ch);
                } else {
                    for code in ch.encode_utf16(&mut [0; 2]) {
                        use std::fmt::Write;
                        write!(ascii, "\\u{code:04x}").expect("string formatting");
                    }
                }
            }
            for text in [value.as_str(), escaped, &ascii] {
                patterns.insert(text.to_owned());
                patterns.insert(text.replace('/', "\\/"));
            }
        }
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

    /// Merge matches with one iterator per pattern; memory does not grow with
    /// the number of occurrences in an arbitrarily large native output record.
    fn complete(&self, text: &str) -> (String, usize) {
        let mut matches: Vec<_> = self
            .patterns
            .iter()
            .map(|p| text.match_indices(&p.text).peekable())
            .collect();
        let mut output = String::new();
        let mut end = 0;
        loop {
            let next = matches
                .iter_mut()
                .filter_map(|m| m.peek().map(|(start, text)| (*start, text.len())))
                .min_by_key(|(start, length)| (*start, std::cmp::Reverse(*length)));
            let Some((start, length)) = next else { break };
            output.push_str(&text[end..start]);
            output.push_str(MASK);
            end = start + length;
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
        let mut tail = 0;
        for pattern in &self.patterns {
            let bytes = pattern.text.as_bytes();
            let suffix = remaining.as_bytes();
            let mut length = 0;
            for &byte in &suffix[suffix.len().saturating_sub(bytes.len() - 1)..] {
                while length > 0 && byte != bytes[length] {
                    length = pattern.prefixes[length - 1];
                }
                if byte == bytes[length] {
                    length += 1;
                }
            }
            tail = tail.max(length);
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
                                .map(|p| p.text.len())
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
    fn overlapping_secrets_and_markers_do_not_leave_a_complete_secret() {
        let redactor = Redactor::new(["abc".into(), "bcde".into(), "redacted".into()]);
        let mut pending = String::new();
        assert_eq!(redactor.fragment("abc", &mut pending), MASK);
        assert_eq!(redactor.fragment("de", &mut pending), "de");
        assert!(pending.is_empty());
        assert_eq!(redactor.text("abc redacted"), "[redacted] [redacted]");
    }
}

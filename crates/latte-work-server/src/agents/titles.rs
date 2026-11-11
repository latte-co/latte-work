//! Bounded, visible conversation context for optional title generation.
const PROMPT_CHARS: usize = 2048;
const REPLY_CHARS: usize = 4096;

#[derive(Default)]
pub(super) struct Context {
    prompt: String,
    reply: String,
}

impl Context {
    pub(super) fn new(prompt: &str) -> Self {
        Self {
            prompt: prompt.chars().take(PROMPT_CHARS).collect(),
            reply: String::new(),
        }
    }

    pub(super) fn reply(&mut self, text: &str) {
        // Retain the latest visible prose, including the delivered result rather
        // than filling the budget with the initial acknowledgement.
        let tail: Vec<_> = text.chars().rev().take(REPLY_CHARS).collect();
        self.reply.extend(tail.into_iter().rev());
        let excess = self.reply.chars().count().saturating_sub(REPLY_CHARS);
        if excess > 0 {
            let offset = self.reply.char_indices().nth(excess).map_or(0, |(i, _)| i);
            self.reply.drain(..offset);
        }
    }

    pub(super) fn description(&self) -> String {
        format!("{}\n\nAssistant reply:\n{}", self.prompt, self.reply)
    }
}

pub(super) fn valid(title: &str) -> Option<&str> {
    let title = title.trim();
    (!title.is_empty() && title.chars().count() <= 100 && !title.chars().any(char::is_control))
        .then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_context_keeps_the_request_and_latest_visible_reply() {
        let mut context = Context::new(&"中🙂".repeat(2000));
        context.reply(&"旧".repeat(5000));
        context.reply("完成：修复拖入附件失败");
        assert_eq!(context.prompt.chars().count(), PROMPT_CHARS);
        assert_eq!(context.reply.chars().count(), REPLY_CHARS);
        assert!(context.description().ends_with("完成：修复拖入附件失败"));
        assert!(valid("  修复附件拖入  ").is_some());
        for invalid in ["", "a\nb", &"中".repeat(101)] {
            assert!(valid(invalid).is_none());
        }
    }
}

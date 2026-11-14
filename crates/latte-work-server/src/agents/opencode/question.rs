use latte_work_protocol::{QuestionAnswer, QuestionOption, UserQuestion};
use serde_json::{Map, Value};

pub(super) struct Form {
    pub wire_id: Value,
    fields: Vec<Field>,
}

pub(super) fn native_questions(prompts: &Value) -> Option<Vec<UserQuestion>> {
    let prompts = prompts.as_array()?;
    if !(1..=16).contains(&prompts.len()) {
        return None;
    }
    prompts
        .iter()
        .enumerate()
        .map(|(index, prompt)| {
            let options = prompt["options"].as_array()?;
            if !(1..=32).contains(&options.len()) {
                return None;
            }
            Some(UserQuestion {
                id: index.to_string(),
                header: bounded(&prompt["header"], 120).unwrap_or_default(),
                text: bounded(&prompt["question"], 2000)?,
                options: options
                    .iter()
                    .map(|option| {
                        Some(QuestionOption {
                            label: bounded(&option["label"], 500)?,
                            description: bounded(&option["description"], 2000).unwrap_or_default(),
                        })
                    })
                    .collect::<Option<Vec<_>>>()?,
                multi_select: prompt["multiple"] == true,
            })
        })
        .collect()
}

pub(super) fn native_answers(
    questions: &[UserQuestion],
    answers: Vec<QuestionAnswer>,
) -> Vec<Vec<String>> {
    questions
        .iter()
        .map(|question| {
            let answer = answers
                .iter()
                .find(|answer| answer.question_id == question.id)
                .expect("validated");
            answer
                .option_indices
                .iter()
                .map(|&index| question.options[index as usize].label.clone())
                .chain(answer.text.clone())
                .collect()
        })
        .collect()
}

struct Field {
    key: String,
    options: Vec<String>,
    custom: String,
    multiple: bool,
}

impl Form {
    pub fn parse(wire_id: &Value, params: &Value) -> Option<(Self, Vec<UserQuestion>)> {
        if params["mode"] != "form" || params["requestedSchema"]["type"] != "object" {
            return None;
        }
        let properties = params["requestedSchema"]["properties"].as_object()?;
        // The shared question card always supports free-form answers. Accept
        // OpenCode's question-tool schema, which explicitly allows custom input.
        if !(2..=32).contains(&properties.len()) || properties.len() % 2 != 0 {
            return None;
        }
        let mut questions = Vec::new();
        let mut fields = Vec::new();
        for index in 0..properties.len() / 2 {
            let key = format!("q{index}");
            let schema = properties.get(&key)?;
            let custom = format!("{key}_custom");
            if properties.get(&custom)?["type"] != "string" {
                return None;
            }
            let (options, multiple) = match schema["type"].as_str()? {
                "string" => (schema["oneOf"].as_array()?, false),
                "array" => (schema["items"]["anyOf"].as_array()?, true),
                _ => return None,
            };
            if !(1..=32).contains(&options.len()) {
                return None;
            }
            let header = bounded(&schema["title"], 120).unwrap_or_default();
            let text = bounded(&schema["description"], 2000)?;
            let mut values = Vec::new();
            let mut choices = Vec::new();
            for option in options {
                let value = bounded(&option["const"], 500)?;
                choices.push(QuestionOption {
                    label: bounded(&option["title"], 500).unwrap_or_else(|| value.clone()),
                    description: bounded(&option["description"], 2000).unwrap_or_default(),
                });
                values.push(value);
            }
            questions.push(UserQuestion {
                id: key.clone(),
                header,
                text,
                options: choices,
                multi_select: multiple,
            });
            fields.push(Field {
                key,
                options: values,
                custom,
                multiple,
            });
        }
        Some((
            Self {
                wire_id: wire_id.clone(),
                fields,
            },
            questions,
        ))
    }

    pub fn answer(&self, answers: Vec<QuestionAnswer>) -> Value {
        let mut content = Map::new();
        for answer in answers {
            let Some(field) = self
                .fields
                .iter()
                .find(|field| field.key == answer.question_id)
            else {
                continue;
            };
            let mut values = answer
                .option_indices
                .into_iter()
                .filter_map(|index| field.options.get(index as usize).cloned())
                .map(Value::String);
            if field.multiple {
                content.insert(field.key.clone(), Value::Array(values.collect()));
            } else if let Some(value) = values.next() {
                content.insert(field.key.clone(), value);
            }
            if let Some(text) = answer.text {
                content.insert(field.custom.clone(), Value::String(text));
            }
        }
        Value::Object(content)
    }
}

fn bounded(value: &Value, limit: usize) -> Option<String> {
    let value = value.as_str()?;
    (!value.is_empty() && value.len() <= limit).then(|| value.into())
}

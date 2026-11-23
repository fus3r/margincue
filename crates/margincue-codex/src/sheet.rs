use crate::state::State;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ElicitRequestParams,
    ElicitResult, ElicitationAction, ElicitationSchema, EnumSchema, JsonObject, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    ToolAnnotations,
};
use rmcp::service::{RequestContext, ServiceError};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::time::{Duration, Instant};

const NO_ANSWER: &str = "No answer, decide yourself.";
const DELEGATE: &str = "Decide for me";
const TOOL: &str = "margincue";
const MAX_QUESTION_LENGTH: usize = 120;
const MAX_OPTION_LENGTH: usize = 80;
/// A decline faster than this came from Codex, not from a person: under
/// `approval_policy = "never"` Codex refuses every form before drawing it (about 1 ms).
const REFUSAL_WINDOW: Duration = Duration::from_millis(300);
const FALLBACK: &str = "Codex did not show the MarginCue form in this session. Ask the same \
questions in your reply instead: copy the block below exactly, then end your turn without \
reading files, running commands or building. When the user answers, apply their choices, \
decide anything left to you and say what you chose, then carry out the original request.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sheet {
    questions: Vec<Question>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    question: String,
    options: Vec<String>,
}

fn concise(text: &str, limit: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= limit && !text.chars().any(char::is_control)
}

fn distinct<'a>(mut values: impl Iterator<Item = &'a str> + Clone) -> bool {
    while let Some(value) = values.next() {
        if values
            .clone()
            .any(|other| value.eq_ignore_ascii_case(other))
        {
            return false;
        }
    }
    true
}

impl Sheet {
    fn parse(arguments: Option<JsonObject>) -> Result<Self, &'static str> {
        let mut sheet: Self = serde_json::from_value(Value::Object(arguments.unwrap_or_default()))
            .map_err(|_| "Send a questions array with a question and options for each entry.")?;
        if !(1..=5).contains(&sheet.questions.len()) {
            return Err("Send one to five questions.");
        }
        for entry in &mut sheet.questions {
            entry.question = entry.question.trim().into();
            for option in &mut entry.options {
                *option = option.trim().into();
            }
            if !concise(&entry.question, MAX_QUESTION_LENGTH)
                || !(2..=4).contains(&entry.options.len())
                || entry.options.iter().any(|option| {
                    !concise(option, MAX_OPTION_LENGTH) || option.eq_ignore_ascii_case(DELEGATE)
                })
                || !distinct(entry.options.iter().map(String::as_str))
            {
                return Err(
                    "Use a short question and two to four distinct, concrete options each.",
                );
            }
        }
        if !distinct(sheet.questions.iter().map(|entry| entry.question.as_str())) {
            return Err("Ask each question only once.");
        }
        Ok(sheet)
    }

    fn schema(&self) -> ElicitationSchema {
        let mut builder = ElicitationSchema::builder();
        for (index, entry) in self.questions.iter().enumerate() {
            let mut options = entry.options.clone();
            options.push(DELEGATE.into());
            let schema = EnumSchema::builder(options)
                .title(entry.question.clone())
                .build();
            builder = builder.optional_enum_schema(field(index), schema);
        }
        builder.build().expect("validated MarginCue form")
    }

    fn decisions(&self, response: ElicitResult) -> (String, usize) {
        let Some(Value::Object(answers)) = response.content else {
            return (NO_ANSWER.into(), 0);
        };
        let mut decisions = Vec::new();
        for (index, entry) in self.questions.iter().enumerate() {
            if let Some(picked) = answers.get(&field(index)).and_then(Value::as_str)
                && entry.options.iter().any(|option| option == picked)
            {
                decisions.push(format!("{} — {picked}", entry.question));
            }
        }
        let count = decisions.len();
        if count == 0 {
            (NO_ANSWER.into(), count)
        } else {
            (decisions.join("\n"), count)
        }
    }

    /// `quick`: the reply came within `REFUSAL_WINDOW` of the request.
    fn result(&self, response: Result<ElicitResult, ServiceError>, quick: bool) -> Outcome {
        match response {
            Ok(response) => match response.action {
                ElicitationAction::Accept => {
                    let (text, count) = self.decisions(response);
                    Outcome {
                        event: "answered",
                        text,
                        count: Some(count),
                    }
                }
                // The person pressed Escape: they leave the decisions to the agent.
                ElicitationAction::Cancel => Outcome::unanswered("dismissed"),
                // Codex refused the form without drawing it: ask in the conversation instead.
                ElicitationAction::Decline if quick => self.fallback("form_refused"),
                // A person's decline, or an action this version does not know.
                _ => Outcome::unanswered("declined"),
            },
            Err(ServiceError::Timeout { .. }) => Outcome::unanswered("timeout"),
            // The client could not show a form at all.
            Err(_) => self.fallback("form_unavailable"),
        }
    }

    fn fallback(&self, event: &'static str) -> Outcome {
        Outcome {
            event,
            text: format!("{FALLBACK}\n\n{}", self.chat_block()),
            count: None,
        }
    }

    /// The questions as the agent writes them in its reply when no form can be shown.
    /// The hook's chat-mode instruction describes the same layout.
    fn chat_block(&self) -> String {
        let count = self.questions.len();
        let example: Vec<&str> = ["2", "1", "3", "1", "2"][..count].to_vec();
        let mut block = format!(
            "**Before I start, {count} quick decision{}.** Reply with one digit per question, \
for example `{}`, or `0` to let me decide everything.\n",
            if count == 1 { "" } else { "s" },
            example.join(" "),
        );
        for (index, entry) in self.questions.iter().enumerate() {
            let options: Vec<String> = entry
                .options
                .iter()
                .map(String::as_str)
                .chain([DELEGATE])
                .enumerate()
                .map(|(number, option)| format!("({}) {option}", number + 1))
                .collect();
            block.push_str(&format!(
                "\n{}. {} {}",
                index + 1,
                entry.question,
                options.join(" ")
            ));
        }
        block
    }
}

struct Outcome {
    event: &'static str,
    text: String,
    count: Option<usize>,
}

impl Outcome {
    fn unanswered(event: &'static str) -> Self {
        Self {
            event,
            text: NO_ANSWER.into(),
            count: None,
        }
    }
}

fn field(index: usize) -> String {
    format!("q{}", index + 1)
}

struct Server(State);

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        // The Codex 0.171 client uses server-initiated elicitation during tools/call.
        Cow::Borrowed(&[ProtocolVersion::V_2025_11_25])
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let schema = json!({
            "type": "object",
            "required": ["questions"],
            "additionalProperties": false,
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "required": ["question", "options"],
                        "additionalProperties": false,
                        "properties": {
                            "question": {"type": "string", "minLength": 1, "maxLength": MAX_QUESTION_LENGTH},
                            "options": {"type": "array", "minItems": 2, "maxItems": 4,
                                "items": {"type": "string", "minLength": 1, "maxLength": MAX_OPTION_LENGTH}}
                        }
                    }
                }
            }
        });
        let tool = Tool::new(
            TOOL,
            "Ask the user to pick consequential kick-off decisions. Use only when the MarginCue hook asks you to on this turn.",
            schema.as_object().unwrap().clone(),
        )
        .with_annotations(ToolAnnotations::new().read_only(true).destructive(false).open_world(false));
        Ok(ListToolsResult::with_all_items(vec![tool]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name != TOOL {
            return Err(ErrorData::invalid_params("Unknown MarginCue tool.", None));
        }
        let started = Instant::now();
        self.0.event("tool_called", started, None);
        if !self.0.enabled() {
            return Ok(CallToolResult::success(vec![ContentBlock::text(NO_ANSWER)]).into());
        }
        let sheet = match Sheet::parse(request.arguments) {
            Ok(sheet) => sheet,
            Err(message) => {
                self.0.event("malformed", started, None);
                return Ok(CallToolResult::error(vec![ContentBlock::text(message)]).into());
            }
        };
        let form = ElicitRequestParams::FormElicitationParams {
            meta: None,
            message: "MarginCue".into(),
            requested_schema: sheet.schema(),
        };
        self.0
            .event("questions_shown", started, Some(sheet.questions.len()));
        let asked = Instant::now();
        let response = context
            .peer
            .create_elicitation_with_timeout(form, self.0.timeout())
            .await;
        let outcome = sheet.result(response, asked.elapsed() < REFUSAL_WINDOW);
        self.0.event(outcome.event, started, outcome.count);
        Ok(CallToolResult::success(vec![ContentBlock::text(outcome.text)]).into())
    }
}

pub async fn serve(state: State) -> Result<(), Box<dyn std::error::Error>> {
    let running = Server(state).serve(rmcp::transport::stdio()).await?;
    running.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sheet() -> Sheet {
        let arguments = json!({"questions": [
            {"question": "Where should it run?", "options": ["Local", "Hosted"]},
            {"question": "Who has access?", "options": ["Members", "Organizers"]},
            {"question": "Where is it stored?", "options": ["Device", "Spreadsheet"]}
        ]});
        Sheet::parse(arguments.as_object().cloned()).unwrap()
    }

    #[test]
    fn answers_only_contain_recognized_choices_in_question_order() {
        let sheet = sheet();
        let form = serde_json::to_value(sheet.schema()).unwrap();
        assert_eq!(
            form["properties"]["q1"]["enum"],
            json!(["Local", "Hosted", DELEGATE])
        );
        let response = ElicitResult::new(ElicitationAction::Accept).with_content(json!({
            "q1": "Hosted", "q2": DELEGATE, "q3": "Invented option", "q99": "Other"
        }));
        let result = sheet.result(Ok(response), false);
        assert_eq!(result.text, "Where should it run? — Hosted");
        assert_eq!(result.count, Some(1));
    }

    #[test]
    fn escape_a_slow_decline_and_an_empty_accept_delegate() {
        let sheet = sheet();
        let cancel = ElicitResult::new(ElicitationAction::Cancel).with_content(json!({"q1": "Local"}));
        for (response, quick, event) in [
            (cancel.clone(), false, "dismissed"),
            (cancel, true, "dismissed"),
            (ElicitResult::new(ElicitationAction::Decline), false, "declined"),
        ] {
            let result = sheet.result(Ok(response), quick);
            assert_eq!(result.event, event);
            assert_eq!(result.text, NO_ANSWER);
        }
        let result = sheet.result(Ok(ElicitResult::new(ElicitationAction::Accept)), false);
        assert_eq!(result.text, NO_ANSWER);
        assert_eq!(result.count, Some(0));
    }

    #[test]
    fn a_form_codex_refuses_or_cannot_show_becomes_questions_in_the_reply() {
        let sheet = sheet();
        let block = "**Before I start, 3 quick decisions.** Reply with one digit per question, \
for example `2 1 3`, or `0` to let me decide everything.\n\
\n1. Where should it run? (1) Local (2) Hosted (3) Decide for me\
\n2. Who has access? (1) Members (2) Organizers (3) Decide for me\
\n3. Where is it stored? (1) Device (2) Spreadsheet (3) Decide for me";
        for (response, event) in [
            (Ok(ElicitResult::new(ElicitationAction::Decline)), "form_refused"),
            (Err(ServiceError::TransportClosed), "form_unavailable"),
        ] {
            let result = sheet.result(response, true);
            assert_eq!(result.event, event);
            assert!(result.text.starts_with(FALLBACK));
            assert!(result.text.ends_with(block), "{}", result.text);
        }
    }

    #[test]
    fn timeout_is_a_separate_event_and_delegates() {
        let result = sheet().result(
            Err(ServiceError::Timeout {
                timeout: Duration::from_secs(90),
            }),
            false,
        );
        assert_eq!(result.event, "timeout");
        assert_eq!(result.text, NO_ANSWER);
    }

    #[test]
    fn rejects_malformed_tool_arguments() {
        assert!(Sheet::parse(None).is_err());
        for arguments in [
            json!({"questions": []}),
            json!({"questions": [{}]}),
            json!({"questions": [{"question": "Who uses it?", "options": ["Members"]}]}),
            json!({"questions": [{"question": " ", "options": ["Members", "Organizers"]}]}),
            json!({"questions": [{"question": "Who uses it?", "options": ["Members ", "members"]}]}),
            json!({"questions": [{"question": "Who uses it?", "options": ["Members", DELEGATE]}]}),
        ] {
            assert!(
                Sheet::parse(arguments.as_object().cloned()).is_err(),
                "{arguments}"
            );
        }
    }
}

mod kickoff;
mod sheet;
mod state;

use crate::state::State;
use serde::Deserialize;
use serde_json::json;
use std::io;
use std::time::Instant;

/// When Codex can draw a form: the questions go through the MarginCue tool.
const FORM_INSTRUCTION: &str = "MarginCue, for this user prompt only. It starts something new. \
Before reading any file, running any command or building, call mcp__margincue__margincue with \
1–5 consequential decisions the request leaves open: who uses it and who has access, where it \
runs, where its data comes from and is kept, what it includes or leaves out. Use short English \
questions and 2–4 short, concrete options each. Skip the call only if the request already \
settles all of these. If the tool says the form could not be shown, do what it says. Otherwise \
use the answers, decide anything left open yourself and say what you chose, and carry out the \
user's request.";

/// When Codex refuses forms (`approval_policy = "never"`): the questions go in the reply.
/// The layout is the one the tool's fallback produces (`sheet::Sheet::chat_block`).
const CHAT_INSTRUCTION: &str = "MarginCue, for this user prompt only. It starts something new. \
Before reading any file, running any command or building, ask the user about 1–5 consequential \
decisions the request leaves open: who uses it and who has access, where it runs, where its \
data comes from and is kept, what it includes or leaves out. Write them in your reply in exactly \
this layout, with short English questions, 2–4 short concrete options each and Decide for me as \
the last option, then end your turn without doing anything else:\n\n\
**Before I start, N quick decisions.** Reply with one digit per question, for example `2 1 3`, \
or `0` to let me decide everything.\n\n\
1. <question> (1) <option> (2) <option> (3) Decide for me\n\
2. <question> (1) <option> (2) <option> (3) <option> (4) Decide for me\n\n\
Skip the questions and carry out the request only if it already settles all of these. When the \
user answers, apply their choices, decide anything left to you and say what you chose, then \
carry out the original request.";

/// When Codex's own question picker is available (`default_mode_request_user_input`): it is
/// interactive and no approval policy blocks it, but it takes at most three questions.
const PICKER_INSTRUCTION: &str = "MarginCue, for this user prompt only. It starts something new. \
Before reading any file, running any command or building, call request_user_input with 1–3 \
consequential decisions the request leaves open, most costly to change first: who uses it and who \
has access, where it runs, where its data comes from and is kept, what it includes or leaves out. \
Use short English questions, each with 2–3 short concrete options followed by a last option \
labelled Decide for me. Skip the call only if the request already settles all of these. Then use \
the answers; for any question answered Decide for me or left unanswered, decide yourself and say \
what you chose; then carry out the user's request.";

#[derive(Deserialize)]
#[serde(tag = "hook_event_name")]
enum HookInput {
    SessionStart {
        session_id: String,
        source: String,
    },
    UserPromptSubmit {
        session_id: String,
        prompt: String,
        agent_id: Option<String>,
        permission_mode: Option<String>,
    },
}

fn run_hook(state: &State) {
    let started = Instant::now();
    let Ok(input) = serde_json::from_reader(io::stdin().lock()) else {
        return;
    };
    match input {
        HookInput::SessionStart { session_id, source } => {
            if matches!(source.as_str(), "resume" | "fork") {
                state.first_prompt(&session_id);
            }
        }
        HookInput::UserPromptSubmit {
            session_id,
            prompt,
            agent_id: None,
            permission_mode,
        } => {
            let first = state.first_prompt(&session_id);
            if state.enabled() && kickoff::starts_something_new(&prompt, first) {
                let mode = state::question_mode();
                state.event_with(
                    "trigger_passed",
                    started,
                    Some(json!({ "mode": mode.name(), "permission_mode": permission_mode })),
                );
                let instruction = match mode {
                    state::Mode::Form => FORM_INSTRUCTION,
                    state::Mode::Picker => PICKER_INSTRUCTION,
                    state::Mode::Chat => CHAT_INSTRUCTION,
                };
                println!(
                    "{}",
                    json!({
                        "hookSpecificOutput": {
                            "hookEventName": "UserPromptSubmit",
                            "additionalContext": instruction,
                        },
                    })
                );
            }
        }
        HookInput::UserPromptSubmit { .. } => {}
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    let state = State::from_env()?;
    match args.as_slice() {
        ["hook"] => run_hook(&state),
        ["serve"] => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(sheet::serve(state))?,
        ["on"] => state.set_enabled(true)?,
        ["off"] => state.set_enabled(false)?,
        ["status"] => {
            state.print_status();
            state::print_mode_hint();
        }
        ["timeout", seconds] => state.set_timeout(seconds.parse()?)?,
        _ => {
            eprintln!("Usage: margincue on|off|status|timeout SECONDS");
            std::process::exit(2);
        }
    }
    Ok(())
}

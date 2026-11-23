use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_TIMEOUT_SECONDS: u32 = 90;

pub struct State(PathBuf);

impl State {
    pub fn from_env() -> io::Result<Self> {
        if let Some(path) = absolute_env_path("MARGINCUE_CODEX_STATE_DIR") {
            return Ok(Self(path));
        }
        let local_state = absolute_env_path("XDG_STATE_HOME")
            .or_else(|| absolute_env_path("HOME").map(|home| home.join(".local/state")))
            .ok_or_else(|| io::Error::other("MarginCue needs a state directory."))?;
        Ok(Self(local_state.join("margincue/codex")))
    }

    pub fn enabled(&self) -> bool {
        !self.0.join("off").exists()
    }

    pub fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        let flag = self.0.join("off");
        if enabled {
            match fs::remove_file(flag) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        } else {
            fs::create_dir_all(&self.0)?;
            fs::write(flag, [])?;
        }
        self.print_status();
        Ok(())
    }

    pub fn set_timeout(&self, seconds: u32) -> io::Result<()> {
        fs::create_dir_all(&self.0)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.0)?;
        writeln!(file, "{seconds}")?;
        file.persist(self.0.join("timeout"))?;
        self.print_status();
        Ok(())
    }

    fn timeout_seconds(&self) -> u32 {
        fs::read_to_string(self.0.join("timeout"))
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
    }

    pub fn timeout(&self) -> Option<Duration> {
        match self.timeout_seconds() {
            0 => None,
            seconds => Some(Duration::from_secs(seconds.into())),
        }
    }

    pub fn print_status(&self) {
        let enabled = if self.enabled() { "on" } else { "off" };
        let timeout = match self.timeout_seconds() {
            0 => "unlimited".into(),
            seconds => format!("{seconds} seconds"),
        };
        println!("MarginCue is {enabled}. Answer timeout is {timeout}.");
    }

    pub fn first_prompt(&self, session_id: &str) -> bool {
        if session_id.is_empty()
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return false;
        }
        let sessions = self.0.join("sessions");
        fs::create_dir_all(&sessions).is_ok()
            && OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(sessions.join(session_id))
                .is_ok()
    }

    pub fn event(&self, event: &'static str, began: Instant, count: Option<usize>) {
        let fields = count.map(|count| json!({ "count": count }));
        self.event_with(event, began, fields);
    }

    /// One log row: the event, its time, its duration, and any extra fields given.
    /// Callers never pass prompt text.
    pub fn event_with(&self, event: &'static str, began: Instant, fields: Option<serde_json::Value>) {
        if fs::create_dir_all(&self.0).is_err() {
            return;
        }
        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.0.join("events.jsonl"))
        else {
            return;
        };
        let mut row = json!({
            "event": event,
            "time_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "elapsed_ms": began.elapsed().as_millis(),
        });
        if let Some(serde_json::Value::Object(fields)) = fields {
            for (key, value) in fields {
                row[key] = value;
            }
        }
        let _ = file.write_all(format!("{row}\n").as_bytes());
    }
}

/// How the agent puts its questions to the user in this session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The MarginCue MCP tool shows Codex's form (approval policies that allow MCP forms).
    Form,
    /// Codex's own question picker, `request_user_input`, which no approval policy blocks
    /// but which Codex 0.171 offers outside plan mode only behind a feature flag.
    Picker,
    /// Questions in the agent's reply, answered with digits: works everywhere.
    Chat,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::Form => "form",
            Mode::Picker => "picker",
            Mode::Chat => "chat",
        }
    }
}

/// The mode for this session, as far as a hook can tell from the user's Codex configuration.
/// MARGINCUE_MODE (form, picker or chat) overrides it; `margincue run` sets it to form and
/// starts Codex without its daemon so that the hook inherits it. A wrong guess is caught
/// downstream: a refused form makes the tool hand the agent the questions for its reply.
pub fn question_mode() -> Mode {
    match std::env::var("MARGINCUE_MODE").as_deref() {
        Ok("form") => return Mode::Form,
        Ok("picker") => return Mode::Picker,
        Ok("chat") => return Mode::Chat,
        _ => {}
    }
    let Some(home) = absolute_env_path("CODEX_HOME")
        .or_else(|| absolute_env_path("HOME").map(|home| home.join(".codex")))
    else {
        return Mode::Form;
    };
    match fs::read_to_string(home.join("config.toml")) {
        Ok(config) => mode_for(&config),
        Err(_) => Mode::Form,
    }
}

/// Codex's own picker is the best of the three where it is on: native, answered with one digit
/// per question, unaffected by the approval policy. Outside plan mode it needs
/// `default_mode_request_user_input`. Without it, the MarginCue form, unless the policy is
/// `never`, under which Codex refuses every MCP form before drawing it.
fn mode_for(config: &str) -> Mode {
    if picker_enabled(config) {
        Mode::Picker
    } else if !refuses_forms(config) {
        Mode::Form
    } else {
        Mode::Chat
    }
}

/// A top-level `approval_policy = "never"`. Keys after the first table header belong to tables.
fn refuses_forms(config: &str) -> bool {
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        if let Some(value) = assigned(line, "approval_policy") {
            return value.starts_with("\"never\"") || value.starts_with("'never'");
        }
    }
    false
}

/// What `margincue status` says about where questions will appear, and how to change it.
pub fn print_mode_hint() {
    match question_mode() {
        Mode::Form => println!("Questions appear in Codex's form. Codex's own picker is cleaner: margincue picker on"),
        Mode::Picker => println!("Questions appear in Codex's own picker."),
        Mode::Chat => println!(
            "Your Codex refuses forms (approval_policy = \"never\"), so questions appear in the agent's reply.\n\
For questions you answer with one key, without changing the approval policy: margincue picker on"
        ),
    }
}

/// `default_mode_request_user_input = true` in `[features]`, or as a dotted top-level key.
fn picker_enabled(config: &str) -> bool {
    let mut table = String::new();
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            table = line.trim_matches(|c| c == '[' || c == ']').trim().to_string();
            continue;
        }
        let value = match table.as_str() {
            "" => assigned(line, "features.default_mode_request_user_input"),
            "features" => assigned(line, "default_mode_request_user_input"),
            _ => None,
        };
        if let Some(value) = value {
            return value.starts_with("true");
        }
    }
    false
}

/// The value assigned to exactly `key` on this line, trimmed, if the line assigns it.
fn assigned<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(key)?;
    Some(rest.trim_start().strip_prefix('=')?.trim())
}

fn absolute_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_first_submission_per_session() {
        let folder = tempfile::tempdir().unwrap();
        let state = State(folder.path().into());
        assert!(state.first_prompt("session-1"));
        assert!(!state.first_prompt("session-1"));
        assert!(state.first_prompt("session-2"));
    }

    #[test]
    fn settings_default_on_and_support_unlimited() {
        let folder = tempfile::tempdir().unwrap();
        let state = State(folder.path().into());
        assert!(state.enabled());
        assert_eq!(state.timeout(), Some(Duration::from_secs(90)));
        state.set_enabled(false).unwrap();
        assert!(!state.enabled());
        state.set_enabled(true).unwrap();
        assert!(state.enabled());
        state.set_timeout(0).unwrap();
        assert_eq!(state.timeout(), None);
    }

    #[test]
    fn only_a_top_level_never_policy_refuses_forms() {
        assert!(refuses_forms("model = \"gpt-6.2-sol\"\napproval_policy = \"never\"\n"));
        assert!(refuses_forms("approval_policy='never'"));
        assert!(!refuses_forms("approval_policy = \"on-request\"\n"));
        assert!(!refuses_forms(
            "approval_policy = { granular = { mcp_elicitations = true } }\n"
        ));
        assert!(!refuses_forms("approval_policy_note = 1\n"));
        assert!(!refuses_forms("[profiles.fast]\napproval_policy = \"never\"\n"));
        assert!(!refuses_forms(""));
    }

    #[test]
    fn the_mode_follows_the_policy_and_the_picker_flag() {
        let never = "approval_policy = \"never\"\n";
        assert_eq!(mode_for(""), Mode::Form);
        assert_eq!(mode_for("approval_policy = \"on-request\"\n[features]\ndefault_mode_request_user_input = true\n"), Mode::Picker);
        assert_eq!(mode_for("approval_policy = \"on-request\"\n"), Mode::Form);
        assert_eq!(mode_for(never), Mode::Chat);
        assert_eq!(mode_for(&format!("{never}[features]\nmemories = true\n")), Mode::Chat);
        assert_eq!(mode_for(&format!("{never}[features]\nmemories = true\ndefault_mode_request_user_input = true\n")), Mode::Picker);
        assert_eq!(mode_for(&format!("{never}features.default_mode_request_user_input = true\n")), Mode::Picker);
        assert_eq!(mode_for(&format!("{never}[features]\ndefault_mode_request_user_input = false\n")), Mode::Chat);
        assert_eq!(mode_for(&format!("{never}[profiles.x]\ndefault_mode_request_user_input = true\n")), Mode::Chat);
    }
}

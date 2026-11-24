//! The relay's write path into the prompt box: Codex's own external-editor
//! handoff (Ctrl+G). The relay arms one request, presses Ctrl+G, and this
//! binary, started by Codex as the editor, applies it to the draft file and
//! exits. A Ctrl+G the person presses finds no request and opens their editor
//! (MarginCue's full card) as before.

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::host::Host;

const DIRECTORY: &str = "MARGINCUE_RELAY_EDITOR_DIR";
const BASE_EDITOR: &str = "MARGINCUE_RELAY_BASE_EDITOR";
const BASE_VISUAL: &str = "MARGINCUE_RELAY_BASE_VISUAL";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Trailing whitespace of the draft is dropped, then the text is added.
    Append,
    /// The text becomes the whole draft.
    Replace,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Replace => "replace",
        }
    }
}

pub struct Editor {
    directory: tempfile::TempDir,
}

impl Editor {
    pub fn install(host: Host, command: &mut Command) -> io::Result<Option<Self>> {
        if host.editor_key().is_none() {
            return Ok(None);
        }
        let directory = tempfile::Builder::new().prefix("mcue-").tempdir()?;
        let binary = env::current_exe()?;
        let binary = binary
            .to_str()
            .ok_or_else(|| io::Error::other("non-UTF-8 executable path"))?;
        let quoted = shlex::try_quote(binary).map_err(io::Error::other)?;
        let editor = format!("{quoted} --editor");
        command
            .env("EDITOR", &editor)
            .env("VISUAL", &editor)
            .env(DIRECTORY, directory.path());
        for (source, destination) in [("EDITOR", BASE_EDITOR), ("VISUAL", BASE_VISUAL)] {
            command.env_remove(destination);
            if let Some(value) = env::var_os(source) {
                command.env(destination, value);
            }
        }
        Ok(Some(Self { directory }))
    }

    pub fn arm(&self, mode: Mode, text: &str) -> io::Result<()> {
        self.cancel();
        let path = self.directory.path().join("request.tmp");
        fs::write(&path, format!("{}\n{text}", mode.name()))?;
        fs::rename(path, self.directory.path().join("request"))
    }

    pub fn cancel(&self) {
        for name in ["request", "request.tmp", "report", "report.tmp"] {
            let _ = fs::remove_file(self.directory.path().join(name));
        }
    }

    /// The draft as the editor left it, once.
    pub fn report(&self) -> Option<String> {
        let path = self.directory.path().join("report");
        let contents = fs::read_to_string(&path).ok()?;
        let _ = fs::remove_file(path);
        Some(contents)
    }
}

pub fn invoke(args: Vec<OsString>) -> io::Result<()> {
    if let [arg] = args.as_slice()
        && let Some(dir) = env::var_os(DIRECTORY).map(PathBuf::from)
        && let Ok(metadata) = fs::symlink_metadata(arg)
        && metadata.is_file()
        && let Ok(path) = fs::canonicalize(arg)
        && prompt_path(&path)
        && let Ok(request) = fs::read_to_string(dir.join("request"))
    {
        // Consume once even if the host starts its editor more than once.
        match fs::remove_file(dir.join("request")) {
            Ok(()) => {
                let (mode, text) = request.split_once('\n').unwrap_or((&request, ""));
                let mode = match mode {
                    "append" => Mode::Append,
                    "replace" => Mode::Replace,
                    _ => return Err(io::Error::other("unknown request")),
                };
                let result = apply(&path, mode, text)?;
                fs::write(dir.join("report.tmp"), result)?;
                fs::rename(dir.join("report.tmp"), dir.join("report"))?;
                return Ok(());
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    delegate(args)
}

fn apply(path: &Path, mode: Mode, text: &str) -> io::Result<String> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::other(
            "the prompt editor did not receive a regular temp file",
        ));
    }
    let mut draft = String::new();
    file.read_to_string(&mut draft)?;
    let result = match mode {
        Mode::Append => format!("{}{text}", draft.trim_end()),
        Mode::Replace => text.to_owned(),
    };
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(result.as_bytes())?;
    file.sync_data()?;
    Ok(result)
}

/// Codex writes the draft to `$CODEX_HOME/editor/.tmp*.md`.
fn prompt_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    name.starts_with(".tmp")
        && name.ends_with(".md")
        && [
            env::var_os("CODEX_HOME").map(PathBuf::from),
            env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")),
            env::current_dir().ok().map(|cwd| cwd.join(".codex")),
        ]
        .into_iter()
        .flatten()
        .filter_map(|base| base.join("editor").canonicalize().ok())
        .any(|dir| path.parent() == Some(dir.as_path()))
}

fn delegate(args: Vec<OsString>) -> io::Result<()> {
    let editor = env::var(BASE_VISUAL)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| env::var(BASE_EDITOR).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "vi".into());
    let words =
        shlex::split(&editor).ok_or_else(|| io::Error::other("could not parse original editor"))?;
    let (program, flags) = words
        .split_first()
        .ok_or_else(|| io::Error::other("empty original editor"))?;
    let mut command = Command::new(program);
    command
        .args(flags)
        .args(args)
        .env_remove("EDITOR")
        .env_remove("VISUAL");
    if let Some(value) = env::var_os(BASE_EDITOR) {
        command.env("EDITOR", value);
    }
    if let Some(value) = env::var_os(BASE_VISUAL) {
        command.env("VISUAL", value);
    }
    Err(command.exec())
}

//! One-shot external-editor handoff. A normal user Ctrl+G still invokes their
//! original editor, and no new prompt is submitted by the wrapper.

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use crate::host::Host;

const DIRECTORY: &str = "MARGINCUE_SPIKE_EDITOR_DIR";
const HOST: &str = "MARGINCUE_SPIKE_EDITOR_HOST";
const BASE_EDITOR: &str = "MARGINCUE_SPIKE_BASE_EDITOR";
const BASE_VISUAL: &str = "MARGINCUE_SPIKE_BASE_VISUAL";

pub const DECISIONS: [&str; 3] = [
    "Export covers all rows.",
    "Export covers the filtered rows.",
    "Export covers the selected rows.",
];

pub fn suffix(option: u8) -> String {
    format!("\n\nDecisions:\n- {}", DECISIONS[usize::from(option - 1)])
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
            .env(DIRECTORY, directory.path())
            .env(HOST, host.name());
        for (source, destination) in [("EDITOR", BASE_EDITOR), ("VISUAL", BASE_VISUAL)] {
            command.env_remove(destination);
            if let Some(value) = env::var_os(source) {
                command.env(destination, value);
            }
        }
        Ok(Some(Self { directory }))
    }

    pub fn arm(&self, text: &str) -> io::Result<()> {
        self.cancel();
        fs::write(self.directory.path().join("request"), text)
    }

    pub fn cancel(&self) {
        for name in ["request", "report", "report.tmp"] {
            let _ = fs::remove_file(self.directory.path().join(name));
        }
    }

    pub fn report(&self) -> Option<String> {
        let contents = fs::read_to_string(self.directory.path().join("report")).ok()?;
        let _ = fs::remove_file(self.directory.path().join("report"));
        Some(contents)
    }
}

pub fn invoke(args: Vec<OsString>) -> io::Result<()> {
    let start = Instant::now();
    if let [arg] = args.as_slice()
        && let Some(host) = env::var(HOST).ok().as_deref().and_then(Host::parse)
        && let Some(dir) = env::var_os(DIRECTORY).map(PathBuf::from)
        && let Ok(metadata) = fs::symlink_metadata(arg)
        && metadata.is_file()
        && let Ok(path) = fs::canonicalize(arg)
        && prompt_path(host, &path)
        && let Ok(request) = fs::read(dir.join("request"))
    {
        // Consume once even if the host starts its editor more than once.
        match fs::remove_file(dir.join("request")) {
            Ok(()) => {
                let mut file = OpenOptions::new()
                    .append(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&path)?;
                let metadata = file.metadata()?;
                if !metadata.is_file() || metadata.nlink() != 1 {
                    return Err(io::Error::other(
                        "the prompt editor did not receive a regular temp file",
                    ));
                }
                file.write_all(&request)?;
                drop(file);
                let report = format!("{}\t{}", start.elapsed().as_micros(), path.display());
                fs::write(dir.join("report.tmp"), report)?;
                fs::rename(dir.join("report.tmp"), dir.join("report"))?;
                return Ok(());
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    delegate(args)
}

fn prompt_path(host: Host, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    match host {
        Host::Codex => {
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
        Host::Claude => {
            name.starts_with("claude-prompt-")
                && (name.ends_with(".md") || name.ends_with(".txt"))
                && [
                    Some(env::temp_dir()),
                    env::var_os("CLAUDE_CODE_TMPDIR").map(PathBuf::from),
                    Some(PathBuf::from("/tmp")),
                ]
                .into_iter()
                .flatten()
                .filter_map(|base| base.canonicalize().ok())
                .any(|dir| path.starts_with(dir))
        }
        Host::Generic => false,
    }
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

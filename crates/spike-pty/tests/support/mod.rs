#![allow(dead_code)]

use std::fs;
use std::io::{self, Read, Write as _};
use std::num::NonZeroU16;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::time::{Duration, Instant};

use spike_pty::io::{PtyChild, Size, event, poll};

pub const WRAPPER: &str = env!("CARGO_BIN_EXE_spike-pty");
pub const CRATE: &str = env!("CARGO_MANIFEST_DIR");

pub struct Terminal {
    pub process: PtyChild,
    pub parser: vt100::Parser<Replies>,
    pub bytes: Vec<u8>,
    pub reads: Vec<(usize, Instant, bool)>,
    pub size: Size,
    pub ended: bool,
}

#[derive(Default)]
pub struct Replies {
    pending: Vec<u8>,
    kitty: bool,
    kitty_flags: Vec<u16>,
    pub size: Option<Size>,
    pub sync_frames: usize,
}

impl Terminal {
    pub fn spawn(command: Command, size: Size, kitty: bool, cursor: (u16, u16)) -> Self {
        let process = PtyChild::spawn(command, size, None).expect("open outer PTY");
        let replies = Replies {
            kitty,
            size: Some(size),
            ..Replies::default()
        };
        let mut parser = vt100::Parser::new_with_callbacks(
            NonZeroU16::new(size.rows).unwrap(),
            NonZeroU16::new(size.cols).unwrap(),
            2000,
            replies,
        );
        parser.process(format!("\x1b[{};{}H", cursor.0, cursor.1).as_bytes());
        Self {
            process,
            parser,
            bytes: Vec::new(),
            reads: Vec::new(),
            size,
            ended: false,
        }
    }

    pub fn send(&mut self, mut bytes: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !bytes.is_empty() {
            match self.process.master.write(bytes) {
                Ok(0) => panic!("outer PTY write returned zero"),
                Ok(n) => bytes = &bytes[n..],
                Err(err)
                    if err.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    poll(
                        &mut [event(self.process.master.as_raw_fd(), libc::POLLOUT)],
                        50,
                    )
                    .unwrap();
                }
                Err(err) => panic!("outer PTY write: {err}"),
            }
        }
    }

    pub fn read(&mut self, wait: Duration) -> bool {
        if self.ended {
            return false;
        }
        let fd = self.process.master.as_raw_fd();
        if poll(&mut [event(fd, libc::POLLIN)], wait.as_millis() as i32).unwrap() == 0 {
            return false;
        }
        let mut buffer = [0; 32768];
        let count = match self.process.master.read(&mut buffer) {
            Ok(count) => count,
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => return false,
            Err(err) if err.raw_os_error() == Some(libc::EIO) => 0,
            Err(err) => panic!("outer PTY read: {err}"),
        };
        if count == 0 {
            self.ended = true;
            return false;
        }
        self.bytes.extend_from_slice(&buffer[..count]);
        self.parser.process(&buffer[..count]);
        self.reads.push((
            self.bytes.len(),
            Instant::now(),
            self.parser.screen().alternate_screen(),
        ));
        let reply = std::mem::take(&mut self.parser.callbacks_mut().pending);
        if !reply.is_empty() && self.process.child.try_wait().unwrap().is_none() {
            self.send(&reply);
        }
        true
    }

    pub fn until(&mut self, wait: Duration, mut ready: impl FnMut(&Self) -> bool) -> Duration {
        let start = Instant::now();
        while !ready(self) && !self.ended && start.elapsed() < wait {
            self.read(
                wait.saturating_sub(start.elapsed())
                    .min(Duration::from_millis(100)),
            );
        }
        assert!(ready(self), "condition timed out\n{}", self.dump());
        start.elapsed()
    }

    pub fn wait_text(&mut self, text: &str) -> Duration {
        self.until(Duration::from_secs(6), |term| term.contains(text))
    }

    pub fn settle(&mut self, duration: Duration) {
        let start = Instant::now();
        while !self.ended && start.elapsed() < duration {
            self.read(
                duration
                    .saturating_sub(start.elapsed())
                    .min(Duration::from_millis(50)),
            );
        }
    }

    pub fn contains(&self, text: &str) -> bool {
        self.parser.screen().contents().contains(text)
    }

    pub fn band(&self, rows: u16) -> String {
        let cols: u16 = self.parser.screen().size().1.get();
        self.parser
            .screen()
            .rows(0, cols)
            .skip(usize::from(self.size.rows - rows))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn above(&self, rows: u16) -> String {
        let cols: u16 = self.parser.screen().size().1.get();
        self.parser
            .screen()
            .rows(0, cols)
            .take(usize::from(self.size.rows - rows))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn resize(&mut self, size: Size) {
        self.size = size;
        self.parser.set_size(
            NonZeroU16::new(size.rows).unwrap(),
            NonZeroU16::new(size.cols).unwrap(),
        );
        self.parser.callbacks_mut().size = Some(size);
        size.set(self.process.master.as_raw_fd()).unwrap();
    }

    pub fn dump(&self) -> String {
        let screen = self.parser.screen();
        let cursor = screen.cursor_position();
        let (rows, cols) = screen.size();
        let mut result = format!(
            "cursor={cursor:?}, hidden={}, alt={}, bytes={}\n",
            screen.hide_cursor(),
            screen.alternate_screen(),
            self.bytes.len()
        );
        for row in 0..rows.get() {
            let line = screen.rows(0, cols.get()).nth(usize::from(row)).unwrap();
            if !line.is_empty() {
                let styled = (0..cols.get())
                    .filter_map(|col| {
                        let cell = screen.cell(row, col)?;
                        ((col < 5 || col > cols.get().saturating_sub(5)) && cell.has_contents()
                            || cell.dim() && cell.has_contents() && col < 9)
                            .then(|| {
                                format!(
                                    "{col}:{:?}({:?}/{:?}{}{})",
                                    cell.contents(),
                                    cell.fgcolor(),
                                    cell.bgcolor(),
                                    if cell.bold() { " bold" } else { "" },
                                    if cell.dim() { " dim" } else { "" }
                                )
                            })
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                result.push_str(&format!("{row:>2}: {line}\n    {styled}\n"));
            }
        }
        result
    }

    pub fn hangup(&mut self) {
        if self.process.child.try_wait().unwrap().is_none() {
            unsafe { libc::kill(self.process.child.id() as i32, libc::SIGHUP) };
            self.wait_exit();
        }
    }

    pub fn wait_exit(&mut self) -> ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(status) = self.process.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "process did not exit"
            );
            if self.ended {
                // Closing the PTY and publishing waitpid status are separate.
                std::thread::sleep(Duration::from_millis(1));
            } else {
                self.read(Duration::from_millis(10));
            }
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        // Let the wrapper restore termios and dispose of its *own* child
        // before the test's PTY guard has to SIGKILL it.
        if self.process.child.try_wait().ok().flatten().is_none() {
            unsafe { libc::kill(self.process.child.id() as i32, libc::SIGHUP) };
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(200) {
                if self.process.child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

impl Replies {
    fn reply(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
    }
}

impl vt100::Callbacks for Replies {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        command: char,
    ) {
        let p = |index: usize| {
            params
                .get(index)
                .and_then(|values| values.first())
                .copied()
                .unwrap_or(0)
        };
        let size = self.size.unwrap();
        match (i1, i2, command) {
            (None | Some(b'?'), None, 'n') if p(0) == 6 => {
                let (row, col) = screen.cursor_position();
                let private = if i1 == Some(b'?') { "?" } else { "" };
                self.reply(
                    format!("\x1b[{private}{};{}R", row + 1, (col + 1).min(size.cols)).as_bytes(),
                );
            }
            (None, None, 'n') if p(0) == 5 => self.reply(b"\x1b[0n"),
            (None, None, 'c') => self.reply(b"\x1b[?64;1;2;6;9;15;18;21;22c"),
            (Some(b'>'), None, 'c') => self.reply(b"\x1b[>1;400;0c"),
            (Some(b'?'), None, 'u') if self.kitty => {
                let flag = self.kitty_flags.last().copied().unwrap_or(0);
                self.reply(format!("\x1b[?{flag}u").as_bytes());
            }
            (Some(b'>'), None, 'u') => self.kitty_flags.push(p(0)),
            (Some(b'<'), None, 'u') => {
                self.kitty_flags.truncate(
                    self.kitty_flags
                        .len()
                        .saturating_sub(usize::from(p(0).max(1))),
                );
            }
            (Some(b'?'), Some(b'$'), 'p') => {
                let value = match p(0) {
                    1007 => 2,
                    2026 => 2,
                    _ => 0,
                };
                self.reply(format!("\x1b[?{};{value}$y", p(0)).as_bytes());
            }
            (Some(b'?'), None, 'l') if p(0) == 2026 => self.sync_frames += 1,
            (None, None, 't') if p(0) == 14 && p(1) == 2 => self.reply(
                format!("\x1b[4;{};{}t", size.rows * 20 + 22, size.cols * 10 + 14).as_bytes(),
            ),
            (None, None, 't') if p(0) == 14 => {
                self.reply(format!("\x1b[4;{};{}t", size.rows * 20, size.cols * 10).as_bytes())
            }
            (None, None, 't') if p(0) == 16 => self.reply(b"\x1b[6;20;10t"),
            (None, None, 't') if p(0) == 18 => {
                self.reply(format!("\x1b[8;{};{}t", size.rows, size.cols).as_bytes())
            }
            (None, None, 't') if p(0) == 19 => self.reply(b"\x1b[9;60;200t"),
            _ => {}
        }
    }

    fn unhandled_osc(&mut self, _screen: &mut vt100::Screen, params: &[&[u8]]) {
        match params {
            [b"10", b"?"] => self.reply(b"\x1b]10;rgb:eeee/eeee/eeee\x1b\\"),
            [b"11", b"?"] => self.reply(b"\x1b]11;rgb:1515/1515/1515\x1b\\"),
            _ => {}
        }
    }
}

pub struct LiveCase {
    root: tempfile::TempDir,
    pub home: PathBuf,
    pub project: PathBuf,
    pub temp: PathBuf,
    pub metrics: PathBuf,
    pub editor_seed: PathBuf,
}

impl LiveCase {
    pub fn new() -> Self {
        let target = Path::new(CRATE).join("target");
        fs::create_dir_all(&target).unwrap();
        let root = tempfile::Builder::new()
            .prefix("live-")
            .tempdir_in(target)
            .unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        let temp = root.path().join("tmp");
        let metrics = root.path().join("metrics.tsv");
        let editor_seed = root.path().join("editor-seed.txt");
        for dir in [&home, &project, &temp] {
            fs::create_dir(dir).unwrap();
        }
        Self {
            root,
            home,
            project,
            temp,
            metrics,
            editor_seed,
        }
    }

    pub fn spawn(&self, host: &str, alt: bool, kitty: bool, size: Size) -> Terminal {
        let mut args: Vec<&str>;
        if host == "codex" {
            let codex_home = self.home.join(".codex");
            fs::create_dir_all(&codex_home).unwrap();
            fs::write(
                codex_home.join("auth.json"),
                r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-margincue-test-token"}"#,
            )
            .unwrap();
            fs::write(codex_home.join("config.toml"), format!(
                "cli_auth_credentials_store = \"file\"\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
                self.project.display()
            )).unwrap();
            args = vec!["codex", "--no-daemon", "-s", "read-only", "-a", "never"];
            if !alt {
                args.push("--no-alt-screen");
            }
        } else {
            fs::create_dir_all(self.home.join(".claude")).unwrap();
            fs::write(
                self.home.join(".claude.json"),
                r#"{
                "hasCompletedOnboarding": true,
                "lastOnboardingVersion": "2.1.330",
                "theme":"dark",
                "numStartups":20,
                "customApiKeyResponses":{"approved":["margincue-test-token"],"rejected":[]}
            }"#,
            )
            .unwrap();
            args = vec![
                "env",
                "-u",
                "CLAUDECODE",
                "claude",
                "--safe-mode",
                "--strict-mcp-config",
            ];
        }
        let mut command = Command::new(WRAPPER);
        command
            .args(["--host", host, "--metrics"])
            .arg(&self.metrics)
            .arg("--")
            .args(args)
            .current_dir(&self.project);
        // A new state directory for each real run. No resume flags or owner
        // settings, keys, project permissions, history or project sessions.
        for (key, _) in std::env::vars_os() {
            let key_text = key.to_string_lossy();
            if [
                "CLAUDE",
                "CODEX_",
                "OPENAI_",
                "ANTHROPIC_",
                "XDG_",
                "BASH_ENV",
                "ENV",
                "EDITOR",
                "VISUAL",
                "TMUX",
                "STY",
                "GHOSTTY",
                "KITTY",
            ]
            .iter()
            .any(|p| key_text.starts_with(p))
            {
                command.env_remove(key);
            }
        }
        let fixture = Path::new(CRATE).join("tests/tty_child.py");
        let fallback_editor = format!(
            "python3 {} editor-read {}",
            shlex::try_quote(fixture.to_str().unwrap()).unwrap(),
            shlex::try_quote(self.editor_seed.to_str().unwrap()).unwrap()
        );
        command
            .env("TERM", "xterm-256color")
            .env(
                "TERM_PROGRAM",
                if kitty { "ghostty" } else { "Apple_Terminal" },
            )
            .env_remove("TERM_PROGRAM_VERSION")
            .env("COLORTERM", "truecolor")
            .env("HOME", &self.home)
            .env("CODEX_HOME", self.home.join(".codex"))
            .env("XDG_CACHE_HOME", self.home.join(".cache"))
            .env("TMPDIR", &self.temp)
            .env("CLAUDE_CODE_TMPDIR", &self.temp)
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("DISABLE_AUTOUPDATER", "1")
            .env("DISABLE_TELEMETRY", "1")
            .env("EDITOR", &fallback_editor)
            .env("VISUAL", &fallback_editor);
        if host == "claude" {
            // An inert API-key fixture makes the install exercise its real
            // interactive UI without reading or updating the owner's keychain.
            command
                .env("ANTHROPIC_API_KEY", "sk-ant-margincue-test-token")
                .env("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
        } else {
            command
                .env("OPENAI_API_KEY", "sk-margincue-test-token")
                .env("OPENAI_BASE_URL", "http://127.0.0.1:9/v1");
        }
        Terminal::spawn(command, size, kitty, (if alt { 1 } else { size.rows }, 1))
    }

    pub fn metrics(&self) -> String {
        fs::read_to_string(&self.metrics)
            .unwrap_or_default()
            .replace(&self.root.path().display().to_string(), "$CASE")
    }
}

#[cfg(target_os = "macos")]
pub fn usage(pid: u32) -> libc::rusage_info_v2 {
    let mut stats: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let ret = unsafe {
        libc::proc_pid_rusage(
            pid as i32,
            libc::RUSAGE_INFO_V2,
            (&mut stats as *mut libc::rusage_info_v2).cast(),
        )
    };
    assert_eq!(ret, 0, "{}", std::io::Error::last_os_error());
    stats
}

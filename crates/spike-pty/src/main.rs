use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use spike_pty::editor::{self, DECISIONS, Editor};
use spike_pty::host::{Draft, Host};
use spike_pty::input::{Action, Geometry, Input};
use spike_pty::io::{PtyChild, RawTerminal, Size, event, has_event, poll};
use spike_pty::output::Output;
use unicode_width::UnicodeWidthChar;

const QUEUE_LIMIT: usize = 128 * 1024;
const CPR_TIMEOUT: Duration = Duration::from_millis(80);
const EDITOR_TIMEOUT: Duration = Duration::from_secs(2);

const USAGE: &str = "\
Usage: spike-pty [--band ROWS] [--host generic|codex|claude] [--metrics FILE] -- COMMAND [ARGS...]
Default band: 2 rows; auto-detect codex and claude by executable name.
Ctrl+] then 1–3 appends a demo decision through the host's editor.
Ctrl+] then p compares navigation + bracketed paste. n cycles options, d dismisses, t toggles.
Press the leader twice to forward it. Unrecognized chords fall through.
";

fn main() -> ExitCode {
    match entry() {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            eprintln!("spike-pty: {err}");
            ExitCode::FAILURE
        }
    }
}

fn entry() -> io::Result<u8> {
    let mut args = env::args_os().skip(1);
    let first = args.next();
    if first.as_deref().is_some_and(|arg| arg == "--editor") {
        editor::invoke(args.collect())?;
        return Ok(0);
    }
    let mut args = first.into_iter().chain(args);
    let mut band = 2;
    let mut host = None;
    let mut metrics = None;
    let program = loop {
        match args.next().as_deref().and_then(|arg| arg.to_str()) {
            Some("-h" | "--help") => {
                print!("{USAGE}");
                return Ok(0);
            }
            Some("--band") => {
                band = args
                    .next()
                    .and_then(|arg| arg.to_str()?.parse().ok())
                    .ok_or_else(|| io::Error::other("--band needs an unsigned row count"))?;
            }
            Some("--host") => {
                host = Some(
                    args.next()
                        .and_then(|arg| Host::parse(arg.to_str()?))
                        .ok_or_else(|| {
                            io::Error::other("expected --host generic, codex or claude")
                        })?,
                );
            }
            Some("--metrics") => {
                metrics = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| io::Error::other("--metrics needs a file"))?,
                ));
            }
            Some("--") => break args.next(),
            Some(command) if !command.starts_with('-') => break Some(OsString::from(command)),
            _ => return Err(io::Error::other(USAGE)),
        }
    }
    .ok_or_else(|| io::Error::other(USAGE))?;
    let host = host.unwrap_or_else(|| Host::detect(&program));
    let mut command = Command::new(program);
    command.args(args);
    let editor = Editor::install(host, &mut command)?;

    let signals = Signals::new()?;
    let mut tty = RawTerminal::open()?;
    let size = Size::read(tty.file.as_raw_fd())?;
    let mut terminal = Output::new(size, band);
    let mut screen = Queue::default();
    let mut keys = Queue::default();
    if terminal.inner().rows != size.rows {
        let (row, col) = initial_cursor(&mut tty.file, &mut keys.bytes)?;
        terminal.start(row, col, &mut screen.bytes);
    }
    let mut view = View::new(host, editor);
    terminal.paint(&view.label(size.cols), &mut screen.bytes);
    let mut child = PtyChild::spawn(command, terminal.inner(), Some(&tty.original))?;
    let mut perf = metrics.as_ref().map(|_| Perf::default());
    let result = relay(
        &mut tty.file,
        &mut child,
        signals,
        &mut terminal,
        &mut view,
        &mut keys,
        &mut screen,
        &mut perf,
    );
    terminal.finish(&mut screen.bytes);
    let _ = drain(&mut tty.file, &mut screen);
    drop(tty); // restore the outer termios before writing diagnostics
    if let (Some(perf), Some(file)) = (perf, metrics) {
        perf.write(file)?;
    }
    if let Some(signal) = result? {
        return Ok(128 + signal as u8);
    }
    let status = child.child.wait()?;
    Ok(status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)) as u8)
}

struct Signals {
    read: UnixStream,
    winch: Arc<AtomicBool>,
    term: Arc<AtomicBool>,
    hup: Arc<AtomicBool>,
    int: Arc<AtomicBool>,
    quit: Arc<AtomicBool>,
    child_exit: Arc<AtomicBool>,
}

impl Signals {
    fn new() -> io::Result<Self> {
        let (read, write) = UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        let instance = Self {
            read,
            winch: Arc::default(),
            term: Arc::default(),
            hup: Arc::default(),
            int: Arc::default(),
            quit: Arc::default(),
            child_exit: Arc::default(),
        };
        for (signal, flag) in [
            (libc::SIGWINCH, &instance.winch),
            (libc::SIGTERM, &instance.term),
            (libc::SIGHUP, &instance.hup),
            (libc::SIGINT, &instance.int),
            (libc::SIGQUIT, &instance.quit),
            (libc::SIGCHLD, &instance.child_exit),
        ] {
            signal_hook::flag::register(signal, Arc::clone(flag))?;
            signal_hook::low_level::pipe::register(signal, write.try_clone()?)?;
        }
        Ok(instance)
    }

    fn termination(&self) -> Option<i32> {
        [
            (libc::SIGTERM, &self.term),
            (libc::SIGHUP, &self.hup),
            (libc::SIGINT, &self.int),
            (libc::SIGQUIT, &self.quit),
        ]
        .into_iter()
        .find_map(|(signal, flag)| flag.load(Ordering::Relaxed).then_some(signal))
    }
}

#[derive(Default)]
struct Queue {
    bytes: Vec<u8>,
    consumed: usize,
}

impl Queue {
    fn pending(&self) -> usize {
        self.bytes.len() - self.consumed
    }

    fn flush(&mut self, writer: &mut File) -> io::Result<()> {
        while self.pending() > 0 {
            match writer.write(&self.bytes[self.consumed..]) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => self.consumed += count,
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(err),
            }
        }
        if self.pending() == 0 {
            self.bytes.clear();
            self.consumed = 0;
        } else if self.consumed >= QUEUE_LIMIT {
            self.bytes.drain(..self.consumed);
            self.consumed = 0;
        }
        Ok(())
    }
}

fn drain(tty: &mut File, queue: &mut Queue) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_millis(100);
    while queue.pending() > 0 && Instant::now() < deadline {
        queue.flush(tty)?;
        if queue.pending() > 0 {
            poll(
                &mut [event(tty.as_raw_fd(), libc::POLLOUT)],
                timeout(Some(deadline)),
            )?;
        }
    }
    Ok(())
}

fn initial_cursor(tty: &mut File, buffered: &mut Vec<u8>) -> io::Result<(u16, u16)> {
    let mut query = Queue {
        bytes: b"\x1b[6n".to_vec(),
        consumed: 0,
    };
    drain(tty, &mut query)?;
    let deadline = Instant::now() + CPR_TIMEOUT;
    let mut bytes = [0; 1024];
    while Instant::now() < deadline {
        let mut fd = [event(tty.as_raw_fd(), libc::POLLIN)];
        if poll(&mut fd, timeout(Some(deadline)))? == 0 {
            break;
        }
        if let Ok(count) = tty.read(&mut bytes) {
            if count == 0 {
                break;
            }
            buffered.extend_from_slice(&bytes[..count]);
            if let Some((start, end, row, col)) = cursor_reply(buffered) {
                buffered.drain(start..end);
                return Ok((row, col));
            }
        }
    }
    Ok((1, 1))
}

fn cursor_reply(bytes: &[u8]) -> Option<(usize, usize, u16, u16)> {
    for (start, window) in bytes.windows(2).enumerate() {
        if window != b"\x1b[" {
            continue;
        }
        let rest = &bytes[start + 2..];
        let Some(end) = rest
            .iter()
            .position(|byte| !byte.is_ascii_digit() && *byte != b';')
        else {
            continue;
        };
        if rest[end] == b'R'
            && let Ok(text) = std::str::from_utf8(&rest[..end])
            && let Some((row, col)) = text.split_once(';')
            && let (Ok(row), Ok(col)) = (row.parse::<u16>(), col.parse::<u16>())
            && row > 0
            && col > 0
        {
            return Some((start, start + end + 3, row, col));
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn relay(
    tty: &mut File,
    child: &mut PtyChild,
    mut signals: Signals,
    terminal: &mut Output,
    view: &mut View,
    keys: &mut Queue,
    display: &mut Queue,
    perf: &mut Option<Perf>,
) -> io::Result<Option<i32>> {
    let (tty_fd, child_fd) = (tty.as_raw_fd(), child.master.as_raw_fd());
    let mut bytes = [0; 32 * 1024];
    let mut input = Input::default();
    let mut child_exited = false;
    loop {
        keys.flush(&mut child.master).or_else(ignore_pty_eof)?;
        display.flush(tty)?;
        let mut fds = [
            event(
                tty_fd,
                (if keys.pending() < QUEUE_LIMIT {
                    libc::POLLIN
                } else {
                    0
                }) | (if display.pending() > 0 {
                    libc::POLLOUT
                } else {
                    0
                }),
            ),
            event(
                child_fd,
                (if display.pending() < QUEUE_LIMIT && keys.pending() < QUEUE_LIMIT {
                    libc::POLLIN
                } else {
                    0
                }) | (if keys.pending() > 0 { libc::POLLOUT } else { 0 }),
            ),
            event(signals.read.as_raw_fd(), libc::POLLIN),
        ];
        let deadline = input.deadline().into_iter().chain(view.deadline()).min();
        let wait = if child_exited { 0 } else { timeout(deadline) };
        poll(&mut fds, wait)?;
        if has_event(&fds[2], libc::POLLIN) {
            let _ = signals.read.read(&mut bytes);
            if let Some(signal) = signals.termination() {
                return Ok(Some(signal));
            }
            if signals.winch.swap(false, Ordering::Relaxed) {
                let size = Size::read(tty_fd)?;
                if size != terminal.outer() {
                    terminal.resize(size, &mut display.bytes);
                    view.update_pending = true;
                    terminal.inner().set(child_fd)?;
                }
            }
            if signals.child_exit.swap(false, Ordering::Relaxed) {
                child_exited = child.child.try_wait()?.is_some();
            }
        }
        let now = Instant::now();
        input.expire(now, &mut keys.bytes);
        if has_event(&fds[0], libc::POLLIN | libc::POLLHUP | libc::POLLERR) {
            let Some(count) = read_ready(tty, &mut bytes)? else {
                continue;
            };
            if count == 0 {
                return Ok(Some(libc::SIGHUP));
            }
            let started = perf.as_ref().map(|_| Instant::now());
            let geometry = Geometry {
                outer: terminal.outer(),
                inner: terminal.inner(),
                pixel_mouse: terminal.pixel_mouse(),
            };
            input.process(
                &bytes[..count],
                now,
                geometry,
                &mut keys.bytes,
                |action, keys| {
                    view.act(action, terminal, keys);
                },
            );
            keys.flush(&mut child.master).or_else(ignore_pty_eof)?;
            if let (Some(start), Some(perf)) = (started, perf.as_mut()) {
                perf.input.add(count, start.elapsed());
            }
        }
        let mut updated = false;
        let mut output_work = None;
        if child_exited || has_event(&fds[1], libc::POLLIN | libc::POLLHUP | libc::POLLERR) {
            let count = read_ready(&mut child.master, &mut bytes)?;
            if count == Some(0) || child_exited && count.is_none() {
                return Ok(None);
            }
            if let Some(count) = count {
                output_work = perf.as_ref().map(|_| (count, Instant::now()));
                terminal.process(&bytes[..count], &mut display.bytes, &mut keys.bytes);
                for query in terminal.pixel_queries() {
                    input.expect_pixel_reply(query);
                }
                terminal.settle_geometry(&mut display.bytes);
                if terminal.safe_to_inspect() {
                    updated = true;
                    view.observe(terminal, &mut keys.bytes, perf);
                    if let Some((action, until)) = view.deferred.take()
                        && Instant::now() < until
                    {
                        view.act(action, terminal, &mut keys.bytes);
                    }
                }
            }
        }
        if updated || !view.enabled || view.update_pending || view.deadline().is_some() {
            view.tick();
            if view.update_pending || updated {
                terminal.paint(&view.label(terminal.outer().cols), &mut display.bytes);
                view.update_pending = false;
            }
        }
        if let (Some((count, start)), Some(perf)) = (output_work, perf.as_mut()) {
            display.flush(tty)?;
            perf.output.add(count, start.elapsed());
        }
    }
}

fn timeout(deadline: Option<Instant>) -> i32 {
    deadline.map_or(-1, |at| {
        let remaining = at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            0
        } else {
            remaining.as_millis().min(i32::MAX as u128 - 1) as i32 + 1
        }
    })
}

fn read_ready(file: &mut File, bytes: &mut [u8]) -> io::Result<Option<usize>> {
    match file.read(bytes) {
        Ok(count) => Ok(Some(count)),
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(None)
        }
        Err(err) if err.raw_os_error() == Some(libc::EIO) => Ok(Some(0)),
        Err(err) => Err(err),
    }
}

fn ignore_pty_eof(err: io::Error) -> io::Result<()> {
    if err.raw_os_error() == Some(libc::EIO) {
        Ok(())
    } else {
        Err(err)
    }
}

struct View {
    host: Host,
    editor: Option<Editor>,
    draft: Draft,
    enabled: bool,
    dismissed: bool,
    option: u8,
    notice: Option<&'static str>,
    edit: Option<Edit>,
    deferred: Option<(Action, Instant)>,
    update_pending: bool,
}

struct Edit {
    start: Instant,
    option: u8,
    paste: bool,
    expected_occurrences: usize,
    report: Option<String>,
    navigating_from: Option<String>,
}

impl View {
    fn new(host: Host, editor: Option<Editor>) -> Self {
        Self {
            host,
            editor,
            draft: Draft::Unavailable,
            enabled: true,
            dismissed: false,
            option: 1,
            notice: None,
            edit: None,
            deferred: None,
            update_pending: false,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        self.edit
            .as_ref()
            .map(|edit| edit.start + EDITOR_TIMEOUT)
            .into_iter()
            .chain(self.deferred.map(|(_, until)| until))
            .min()
    }

    fn tick(&mut self) {
        let now = Instant::now();
        if self.deferred.is_some_and(|(_, until)| now >= until) {
            self.deferred = None;
            self.notice = Some("composer update timed out");
            self.update_pending = true;
        }
        if self
            .edit
            .as_ref()
            .is_some_and(|edit| now >= edit.start + EDITOR_TIMEOUT)
        {
            if let Some(editor) = &self.editor {
                editor.cancel();
            }
            self.edit = None;
            self.notice = Some("edit timed out");
            self.update_pending = true;
        }
    }

    fn observe(&mut self, terminal: &Output, keys: &mut Vec<u8>, perf: &mut Option<Perf>) {
        if !self.enabled {
            return;
        }
        let draft = self.host.read(terminal.screen());
        // Cursor-only movement does not reopen a dismissed preview.
        if draft_text(&draft) != draft_text(&self.draft) {
            self.dismissed = false;
            if self.edit.is_none() {
                self.notice = None;
            }
        }
        self.draft = draft;
        if let Some(edit) = &mut self.edit {
            if let Some(original) = &edit.navigating_from {
                if matches!(&self.draft, Draft::Visible { text, approximate: false, at_end: true, .. } if text == original)
                {
                    paste_suffix(keys, edit.option);
                    edit.navigating_from = None;
                    self.notice = Some("pasting");
                }
                return;
            }
            if !edit.paste && edit.report.is_none() {
                edit.report = self.editor.as_ref().and_then(Editor::report);
            }
            let decision = DECISIONS[usize::from(edit.option - 1)];
            let visible = draft_text(&self.draft)
                .is_some_and(|text| text.matches(decision).count() >= edit.expected_occurrences);
            let collapsed = edit.paste
                && self.host == Host::Claude
                && draft_text(&self.draft).is_some_and(|text| text.contains("[Pasted text #"));
            if (edit.paste || edit.report.is_some()) && (visible || collapsed) {
                let (method, notice) = if collapsed {
                    ("paste-placeholder", "paste collapsed")
                } else if edit.paste {
                    ("paste", "pasted")
                } else {
                    ("editor", "editor applied")
                };
                if let Some(perf) = perf.as_mut() {
                    perf.edits.push(format!(
                        "{}\t{:.3}\t{}\n",
                        method,
                        edit.start.elapsed().as_secs_f64() * 1000.0,
                        edit.report.as_deref().unwrap_or("-\t-"),
                    ));
                }
                self.notice = Some(notice);
                self.edit = None;
            }
        }
    }

    fn act(&mut self, action: Action, terminal: &Output, keys: &mut Vec<u8>) {
        self.update_pending = true;
        match action {
            Action::Toggle => {
                self.enabled = !self.enabled;
                self.deferred = None;
                if !self.enabled {
                    self.draft = Draft::Unavailable;
                } else if terminal.safe_to_inspect() {
                    self.draft = self.host.read(terminal.screen());
                }
                self.notice = None;
            }
            Action::Dismiss => self.dismissed = true,
            Action::Next => {
                self.option = self.option % 3 + 1;
                self.notice =
                    Some(["option 1", "option 2", "option 3"][usize::from(self.option - 1)]);
            }
            Action::Pick(_) | Action::Paste => {
                if self.edit.is_some() {
                    self.notice = Some("edit in progress");
                    return;
                }
                if self.enabled && !terminal.safe_to_inspect() {
                    self.deferred = Some((action, Instant::now() + Duration::from_millis(200)));
                    return;
                }
                let Draft::Visible {
                    text,
                    approximate,
                    rows_below_cursor,
                    at_end,
                } = &self.draft
                else {
                    self.notice = Some("composer unavailable");
                    return;
                };
                if text.is_empty() {
                    return;
                }
                let start = Instant::now();
                let paste = action == Action::Paste;
                if let Action::Pick(option) = action {
                    self.option = option;
                }
                let suffix = editor::suffix(self.option);
                let mut navigating_from = None;
                if paste {
                    if *approximate || !terminal.bracketed_paste() {
                        self.notice = Some("paste needs a visible composer");
                        return;
                    }
                    if *at_end {
                        paste_suffix(keys, self.option);
                    } else {
                        for _ in 0..*rows_below_cursor {
                            keys.extend_from_slice(b"\x1b[B");
                        }
                        keys.push(0x05);
                        navigating_from = Some(text.clone());
                    }
                } else if let (Some(editor), Some(key)) = (&self.editor, self.host.editor_key()) {
                    if editor.arm(&suffix).is_err() {
                        self.notice = Some("could not arm editor");
                        return;
                    }
                    keys.extend_from_slice(key);
                } else {
                    return;
                }
                self.notice = Some(if navigating_from.is_some() {
                    "moving to draft end"
                } else if paste {
                    "pasting"
                } else {
                    "opening editor"
                });
                self.edit = Some(Edit {
                    start,
                    option: self.option,
                    paste,
                    report: None,
                    navigating_from,
                    expected_occurrences: text
                        .matches(DECISIONS[usize::from(self.option - 1)])
                        .count()
                        + 1,
                });
            }
        }
    }

    fn label(&self, cols: u16) -> String {
        let mut label = if !self.enabled {
            "MarginCue | off".into()
        } else if self.dismissed {
            "MarginCue | dismissed".into()
        } else {
            match &self.draft {
                Draft::Unavailable => "MarginCue | no composer".into(),
                Draft::Visible {
                    text, approximate, ..
                } => format!(
                    "MarginCue | {} {} | {}",
                    if *approximate { "approx" } else { "draft" },
                    text.chars().count(),
                    text.replace('\\', "\\\\")
                        .replace('\n', "\\n")
                        .replace('\t', "\\t"),
                ),
            }
        };
        if let Some(notice) = self.notice {
            label.push_str(" | ");
            label.push_str(notice);
        }
        let mut remaining = usize::from(cols.saturating_sub(1));
        label
            .chars()
            .filter(|c| !c.is_control())
            .take_while(|c| {
                let width = c.width().unwrap_or(0);
                if width > remaining {
                    return false;
                }
                remaining -= width;
                true
            })
            .collect()
    }
}

fn paste_suffix(keys: &mut Vec<u8>, option: u8) {
    keys.extend_from_slice(b"\x1b[200~");
    keys.extend_from_slice(editor::suffix(option).as_bytes());
    keys.extend_from_slice(b"\x1b[201~");
}

fn draft_text(draft: &Draft) -> Option<&str> {
    match draft {
        Draft::Visible { text, .. } => Some(text),
        Draft::Unavailable => None,
    }
}

#[derive(Default)]
struct Perf {
    input: Samples,
    output: Samples,
    edits: Vec<String>,
}

#[derive(Default)]
struct Samples {
    small: Vec<u64>,
    medium: Vec<u64>,
    large: Vec<u64>,
}

impl Samples {
    fn add(&mut self, bytes: usize, elapsed: Duration) {
        let sample = match bytes {
            0..=64 => &mut self.small,
            65..=1024 => &mut self.medium,
            _ => &mut self.large,
        };
        sample.push(elapsed.as_nanos() as u64);
    }

    fn write(&mut self, label: &str, out: &mut File) -> io::Result<()> {
        for (size, times) in [
            ("<=64", &mut self.small),
            ("65..1024", &mut self.medium),
            (">1024", &mut self.large),
        ] {
            if times.is_empty() {
                continue;
            }
            times.sort_unstable();
            let at = |percent| times[(times.len() - 1) * percent / 100] as f64 / 1000.0;
            writeln!(
                out,
                "{label}\t{size}\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}",
                times.len(),
                at(50),
                at(95),
                at(99),
                at(100)
            )?;
        }
        Ok(())
    }
}

impl Perf {
    fn write(mut self, path: PathBuf) -> io::Result<()> {
        let mut out = File::create(path)?;
        writeln!(
            out,
            "direction\tbytes\tsamples\tp50_us\tp95_us\tp99_us\tmax_us"
        )?;
        self.input.write("input", &mut out)?;
        self.output.write("output", &mut out)?;
        writeln!(
            out,
            "method\twrapper_to_visible_result_ms\teditor_body_us\tpath"
        )?;
        for edit in self.edits {
            out.write_all(edit.as_bytes())?;
        }
        Ok(())
    }
}

//! margincue-relay: runs Codex in a terminal MarginCue owns, so MarginCue's
//! card can sit under Codex's prompt box and follow the draft as it is typed.
//!
//! Codex gets a pseudo-terminal a few rows shorter than the real one; the rows
//! below it are the card. A shadow screen reads the prompt box. MarginCue (the
//! Node process that started the relay, on fd `--fd`) decides what the card
//! shows and what, if anything, Enter adds to the prompt.

use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, ExitCode};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use margincue_relay::editor::{self, Editor, Mode};
use margincue_relay::host::{Draft, Host};
use margincue_relay::input::{Action, Claims, EnterKey, Geometry, Input};
use margincue_relay::io::{PtyChild, RawTerminal, Size, check, event, has_event, poll};
use margincue_relay::output::Output;
use margincue_relay::protocol::{self, Down, EnterAction, Up};

const QUEUE_LIMIT: usize = 128 * 1024;
const LINK_LIMIT: usize = 1 << 20;
const CPR_TIMEOUT: Duration = Duration::from_millis(80);
/// MarginCue answers an Enter within this, or the prompt goes as it is.
const ENTER_ANSWER: Duration = Duration::from_millis(250);
/// A write into the prompt box shows within this, or it is given up.
const WRITE_TIMEOUT: Duration = Duration::from_millis(2500);
/// How often the editor's report is looked for while a write is in flight.
const REPORT_POLL: Duration = Duration::from_millis(5);
/// Codex keeps at least this many rows.
const MIN_CHILD_ROWS: u16 = 12;
/// Codex shows a paste this long as a placeholder; longer additions go through the editor.
const PASTE_MAX: usize = 900;

const USAGE: &str = "\
Usage: margincue-relay [--fd N] [--host codex|generic] [--band ROWS] -- COMMAND [ARGS...]
       margincue-relay --version
Runs COMMAND (Codex) a few rows shorter than the terminal and draws MarginCue's
card below it. Ctrl+] then t turns MarginCue off or on; Ctrl+] then d hides the
card until the prompt changes.
";

fn main() -> ExitCode {
    match entry() {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            eprintln!("margincue-relay: {err}");
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
    if first.as_deref().is_some_and(|arg| arg == "--version") {
        println!(
            "margincue-relay {} protocol {}",
            env!("CARGO_PKG_VERSION"),
            protocol::VERSION
        );
        return Ok(0);
    }
    let mut args = first.into_iter().chain(args);
    let mut host = None;
    let mut fd: Option<RawFd> = None;
    // A fixed card height, for tests and terminals where resizing Codex misbehaves.
    let mut fixed: Option<u16> = None;
    let program = loop {
        match args.next().as_deref().and_then(|arg| arg.to_str()) {
            Some("-h" | "--help") => {
                print!("{USAGE}");
                return Ok(0);
            }
            Some("--fd") => {
                fd = Some(
                    args.next()
                        .and_then(|arg| arg.to_str()?.parse().ok())
                        .ok_or_else(|| io::Error::other("--fd needs a descriptor number"))?,
                );
            }
            Some("--band") => {
                fixed = Some(
                    args.next()
                        .and_then(|arg| arg.to_str()?.parse().ok())
                        .ok_or_else(|| io::Error::other("--band needs a row count"))?,
                );
            }
            Some("--host") => {
                host = Some(
                    args.next()
                        .and_then(|arg| Host::parse(arg.to_str()?))
                        .ok_or_else(|| io::Error::other("expected --host codex or generic"))?,
                );
            }
            Some("--") => break args.next(),
            Some(command) if !command.starts_with('-') => break Some(OsString::from(command)),
            _ => return Err(io::Error::other(USAGE)),
        }
    }
    .ok_or_else(|| io::Error::other(USAGE))?;
    let link = fd.map(Link::open).transpose()?;
    let host = host.unwrap_or_else(|| Host::detect(&program));
    let mut command = Command::new(program);
    command.args(args);
    let editor = Editor::install(host, &mut command)?;

    let signals = Signals::new()?;
    let mut tty = RawTerminal::open()?;
    let size = Size::read(tty.file.as_raw_fd())?;
    let mut terminal = Output::new(size, fixed.unwrap_or_else(|| initial_band(size)));
    let mut screen = Queue::default();
    let mut keys = Queue::default();
    if terminal.inner().rows != size.rows {
        let (row, col) = initial_cursor(&mut tty.file, &mut keys.bytes)?;
        terminal.start(row, col, &mut screen.bytes);
    }
    let mut state = State::new(host, editor, link, fixed);
    state.paint_fallback(&mut terminal, &mut screen.bytes);
    let mut child = PtyChild::spawn(command, terminal.inner(), Some(&tty.original))?;
    state.hello(&terminal);
    let result = relay(
        &mut tty.file,
        &mut child,
        signals,
        &mut terminal,
        &mut state,
        &mut keys,
        &mut screen,
    );
    terminal.finish(&mut screen.bytes);
    let _ = drain(&mut tty.file, &mut screen);
    drop(tty); // restore the outer termios before anything else is printed
    if let Some(editor) = &state.editor {
        editor.cancel();
    }
    if let Some(signal) = result? {
        return Ok(128 + signal as u8);
    }
    let status = child.child.wait()?;
    Ok(status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)) as u8)
}

fn initial_band(size: Size) -> u16 {
    u16::from(size.rows > MIN_CHILD_ROWS)
}

/// The most rows the card may take: it grows only on Codex's full-screen view,
/// where a resize redraws everything.
fn max_band(outer: Size, full: bool) -> u16 {
    if outer.rows <= MIN_CHILD_ROWS {
        return 0;
    }
    if !full {
        return 1;
    }
    // As in Claude Code: up to 60% of the window while a prompt is written, so the sketch fits
    // under the rows at 80 columns. The card shrinks back to one row once the prompt is sent.
    (outer.rows * 3 / 5).clamp(4, 24).min(outer.rows - MIN_CHILD_ROWS)
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

/// The pipe to MarginCue. Losing it leaves Codex running as if started bare.
struct Link {
    file: File,
    inbox: Vec<u8>,
    outbox: Queue,
}

impl Link {
    fn open(fd: RawFd) -> io::Result<Self> {
        check(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
        let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
        check(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) })?;
        Ok(Self {
            file: unsafe { File::from_raw_fd(fd) },
            inbox: Vec::new(),
            outbox: Queue::default(),
        })
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

fn relay(
    tty: &mut File,
    child: &mut PtyChild,
    mut signals: Signals,
    terminal: &mut Output,
    state: &mut State,
    keys: &mut Queue,
    display: &mut Queue,
) -> io::Result<Option<i32>> {
    let (tty_fd, child_fd) = (tty.as_raw_fd(), child.master.as_raw_fd());
    let mut bytes = [0; 32 * 1024];
    let mut input = Input::default();
    let mut child_exited = false;
    loop {
        keys.flush(&mut child.master).or_else(ignore_pty_eof)?;
        display.flush(tty)?;
        state.flush_link();
        let link_fd = state.link.as_ref().map(|link| link.file.as_raw_fd());
        let mut fds = vec![
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
        if let (Some(fd), Some(link)) = (link_fd, state.link.as_ref()) {
            fds.push(event(
                fd,
                libc::POLLIN
                    | if link.outbox.pending() > 0 {
                        libc::POLLOUT
                    } else {
                        0
                    },
            ));
        }
        let deadline = input.deadline().into_iter().chain(state.deadline()).min();
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
                    terminal.inner().set(child_fd)?;
                    state.geometry_changed(terminal);
                }
            }
            if signals.child_exit.swap(false, Ordering::Relaxed) {
                child_exited = child.child.try_wait()?.is_some();
            }
        }
        let now = Instant::now();
        {
            let mut actions = Vec::new();
            input.expire(now, &mut keys.bytes, |action, _| actions.push(action));
            for action in actions {
                state.act(action, &mut input, terminal, keys);
            }
        }
        if has_event(&fds[0], libc::POLLIN | libc::POLLHUP | libc::POLLERR) {
            let Some(count) = read_ready(tty, &mut bytes)? else {
                continue;
            };
            if count == 0 {
                return Ok(Some(libc::SIGHUP));
            }
            let geometry = Geometry {
                outer: terminal.outer(),
                inner: terminal.inner(),
                pixel_mouse: terminal.pixel_mouse(),
            };
            let mut actions = Vec::new();
            input.process(&bytes[..count], now, geometry, &mut keys.bytes, |action, _| {
                actions.push(action)
            });
            state.pastes(input.take_pastes());
            for action in actions {
                state.act(action, &mut input, terminal, keys);
            }
            keys.flush(&mut child.master).or_else(ignore_pty_eof)?;
        }
        if let Some(link) = fds.get(3)
            && has_event(link, libc::POLLIN | libc::POLLHUP | libc::POLLERR)
        {
            for message in state.read_link(&mut bytes) {
                state.handle(message, &mut input, terminal, keys, &mut display.bytes, child_fd)?;
            }
        }
        if child_exited || has_event(&fds[1], libc::POLLIN | libc::POLLHUP | libc::POLLERR) {
            let count = read_ready(&mut child.master, &mut bytes)?;
            if count == Some(0) || child_exited && count.is_none() {
                return Ok(None);
            }
            if let Some(count) = count {
                terminal.process(&bytes[..count], &mut display.bytes, &mut keys.bytes);
                for query in terminal.pixel_queries() {
                    input.expect_pixel_reply(query);
                }
                terminal.settle_geometry(&mut display.bytes);
                if terminal.safe_to_inspect() {
                    state.observe(terminal, &mut input);
                }
            }
        }
        state.tick(&mut input, terminal, keys);
        state.reshape(terminal, &mut display.bytes, child_fd)?;
        terminal.paint(&state.painted, &mut display.bytes);
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

/// What the relay is doing to the prompt box right now.
struct Pending {
    since: Instant,
    stage: Stage,
    /// The Enter to forward when done; none for a write MarginCue asked for.
    enter: Option<EnterKey>,
    /// The write to report back; none for an Enter.
    id: Option<u64>,
}

enum Stage {
    /// Waiting for MarginCue's answer to an Enter.
    Asking,
    /// Waiting for the box to end with `tail` (and, through the editor, for its report).
    Showing { tail: String, editor: bool, reported: bool },
}

struct State {
    host: Host,
    editor: Option<Editor>,
    link: Option<Link>,
    on: bool,
    draft: Draft,
    /// What MarginCue last heard about the draft.
    told: Option<(Option<String>, bool, bool, bool)>,
    /// MarginCue's card rows, as sent.
    lines: Vec<String>,
    /// The rows as drawn: sanitized, cut to the terminal.
    painted: Vec<Vec<u8>>,
    claims: Claims,
    write: Option<Pending>,
    /// Recent pastes, newest last, to read what a placeholder stands for.
    recent: Vec<String>,
    full: bool,
    max: u16,
    cols: u16,
    rows: u16,
    fixed: Option<u16>,
}

impl State {
    fn new(host: Host, editor: Option<Editor>, link: Option<Link>, fixed: Option<u16>) -> Self {
        Self {
            host,
            editor,
            link,
            on: true,
            draft: Draft::Unavailable,
            told: None,
            lines: Vec::new(),
            painted: Vec::new(),
            claims: Claims::default(),
            write: None,
            recent: Vec::new(),
            full: false,
            max: 0,
            cols: 0,
            rows: 0,
            fixed,
        }
    }

    fn max_band(&self, outer: Size, full: bool) -> u16 {
        self.fixed.unwrap_or_else(|| max_band(outer, full))
    }

    fn send(&mut self, message: Up) {
        let Some(link) = self.link.as_mut() else {
            return;
        };
        if link.outbox.pending() > LINK_LIMIT {
            // MarginCue stopped reading: carry on without it.
            self.link = None;
            self.claims = Claims::default();
            return;
        }
        link.outbox.bytes.extend_from_slice(&protocol::encode(&message));
    }

    fn flush_link(&mut self) {
        if let Some(link) = self.link.as_mut()
            && link.outbox.flush(&mut link.file).is_err()
        {
            self.lost();
        }
    }

    fn read_link(&mut self, bytes: &mut [u8]) -> Vec<Down> {
        let Some(link) = self.link.as_mut() else {
            return Vec::new();
        };
        match link.file.read(bytes) {
            Ok(0) => {
                self.lost();
                Vec::new()
            }
            Ok(count) => {
                link.inbox.extend_from_slice(&bytes[..count]);
                if link.inbox.len() > LINK_LIMIT {
                    self.lost();
                    return Vec::new();
                }
                protocol::decode(&mut link.inbox)
            }
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Vec::new()
            }
            Err(_) => {
                self.lost();
                Vec::new()
            }
        }
    }

    fn lost(&mut self) {
        self.link = None;
        self.claims = Claims::default();
        self.lines = vec!["\x1b[2m MarginCue stopped · Codex works as usual\x1b[m".into()];
    }

    fn hello(&mut self, terminal: &Output) {
        let outer = terminal.outer();
        self.full = terminal.alternate();
        self.max = self.max_band(outer, self.full);
        self.cols = outer.cols;
        self.rows = outer.rows;
        self.send(Up::Hello {
            protocol: protocol::VERSION,
            cols: self.cols,
            rows: self.rows,
            max: self.max,
            full: self.full,
        });
    }

    fn paint_fallback(&mut self, terminal: &mut Output, out: &mut Vec<u8>) {
        self.lines = vec!["\x1b[2m MarginCue\x1b[m".into()];
        self.repaint(terminal);
        terminal.paint(&self.painted, out);
    }

    fn geometry_changed(&mut self, terminal: &mut Output) {
        let outer = terminal.outer();
        let full = terminal.alternate();
        let max = self.max_band(outer, full);
        if (outer.cols, outer.rows, full, max) != (self.cols, self.rows, self.full, self.max) {
            self.cols = outer.cols;
            self.rows = outer.rows;
            self.full = full;
            self.max = max;
            self.send(Up::Size {
                cols: self.cols,
                rows: self.rows,
                max: self.max,
                full: self.full,
            });
        }
        self.repaint(terminal);
    }

    /// The rows the card should have now.
    fn wanted_band(&self, terminal: &Output) -> u16 {
        if let Some(rows) = self.fixed {
            return rows;
        }
        if self.max == 0 {
            return 0;
        }
        if !self.full || !terminal.alternate() {
            // Off the full-screen view a resize would disturb scrollback.
            return terminal.band().max(1).min(self.max.max(1));
        }
        (self.lines.len() as u16).clamp(1, self.max)
    }

    fn reshape(&mut self, terminal: &mut Output, out: &mut Vec<u8>, child_fd: RawFd) -> io::Result<()> {
        let band = self.wanted_band(terminal);
        if band != terminal.band() && self.write.is_none() && terminal.set_band(band, out) {
            terminal.inner().set(child_fd)?;
            self.repaint(terminal);
        }
        Ok(())
    }

    fn repaint(&mut self, terminal: &mut Output) {
        let rows = usize::from(terminal.band());
        let cols = terminal.outer().cols;
        let painted: Vec<Vec<u8>> = (0..rows)
            .map(|i| {
                self.lines
                    .get(i)
                    .map_or_else(Vec::new, |line| protocol::sanitize(line, cols))
            })
            .collect();
        if painted != self.painted {
            self.painted = painted;
        }
        terminal.invalidate();
    }

    fn pastes(&mut self, pastes: Vec<String>) {
        for paste in pastes {
            self.recent.push(paste);
        }
        let excess = self.recent.len().saturating_sub(8);
        self.recent.drain(..excess);
    }

    /// The draft with Codex's paste placeholders read back from the pastes seen.
    fn expand(&self, text: &str) -> String {
        const OPEN: &str = "[Pasted Content ";
        if !text.contains(OPEN) {
            return text.to_owned();
        }
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find(OPEN) {
            out.push_str(&rest[..start]);
            let after = &rest[start + OPEN.len()..];
            let resolved = after.find(" chars]").and_then(|end| {
                let count: usize = after[..end].parse().ok()?;
                let paste = self.recent.iter().rev().find_map(|paste| {
                    let normal = paste.replace("\r\n", "\n").replace('\r', "\n");
                    (normal.chars().count() == count).then_some(normal)
                })?;
                Some((paste, end + " chars]".len()))
            });
            match resolved {
                Some((paste, used)) => {
                    out.push_str(&paste);
                    rest = &after[used..];
                }
                None => {
                    out.push_str(OPEN);
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn observe(&mut self, terminal: &mut Output, input: &mut Input) {
        // Codex leaves its full-screen view for an editor handoff; the card
        // keeps its rows through the relay's own writes.
        if terminal.alternate() != self.full && self.write.is_none() {
            self.geometry_changed(terminal);
        }
        let mut draft = self.host.read(terminal.screen());
        if let Draft::Visible { text, .. } = &mut draft {
            *text = self.expand(text);
        }
        self.draft = draft;
        let told = match &self.draft {
            Draft::Visible {
                text,
                approximate,
                at_end,
                plain,
                ..
            } => (Some(text.clone()), *approximate, *at_end, *plain),
            Draft::Unavailable => (None, false, false, false),
        };
        if self.told.as_ref() != Some(&told) && self.on {
            self.send(Up::Draft {
                text: told.0.as_deref(),
                approx: told.1,
                end: told.2,
                plain: told.3,
            });
            self.told = Some(told);
        }
        self.apply_claims(input);
    }

    fn apply_claims(&self, input: &mut Input) {
        let plain = matches!(self.draft, Draft::Visible { plain: true, .. });
        let visible = matches!(self.draft, Draft::Visible { .. });
        let live = self.on && self.link.is_some();
        input.claims = Claims {
            enter: live && plain && self.claims.enter,
            arrows: live && visible && self.claims.arrows,
        };
    }

    fn deadline(&self) -> Option<Instant> {
        let write = self.write.as_ref()?;
        Some(match &write.stage {
            Stage::Asking => write.since + ENTER_ANSWER,
            Stage::Showing { editor: true, reported: false, .. } => {
                (Instant::now() + REPORT_POLL).min(write.since + WRITE_TIMEOUT)
            }
            Stage::Showing { .. } => write.since + WRITE_TIMEOUT,
        })
    }

    fn act(&mut self, action: Action, input: &mut Input, terminal: &Output, keys: &mut Queue) {
        match action {
            Action::Toggle => {
                self.on = !self.on;
                self.send(Up::Toggle { on: self.on });
                if self.on {
                    self.told = None;
                }
                self.apply_claims(input);
            }
            Action::Dismiss => self.send(Up::Dismiss),
            Action::Up => self.send(Up::Key { key: "up" }),
            Action::Down => self.send(Up::Key { key: "down" }),
            Action::Click { x, y } => self.send(Up::Click { x, y }),
            Action::Enter(key) => {
                if self.write.is_some() {
                    input.defer(key.bytes());
                    return;
                }
                let Draft::Visible {
                    text,
                    approximate,
                    plain: true,
                    ..
                } = &self.draft
                else {
                    keys.bytes.extend_from_slice(key.bytes());
                    return;
                };
                if !terminal.safe_to_inspect() || text.trim().is_empty() {
                    keys.bytes.extend_from_slice(key.bytes());
                    return;
                }
                let (text, approx) = (text.clone(), *approximate);
                input.hold();
                self.write = Some(Pending {
                    since: Instant::now(),
                    stage: Stage::Asking,
                    enter: Some(key),
                    id: None,
                });
                self.send(Up::Enter { text: &text, approx });
            }
        }
    }

    fn handle(
        &mut self,
        message: Down,
        input: &mut Input,
        terminal: &mut Output,
        keys: &mut Queue,
        out: &mut Vec<u8>,
        child_fd: RawFd,
    ) -> io::Result<()> {
        match message {
            Down::Band { lines } => {
                self.lines = lines;
                self.reshape(terminal, out, child_fd)?;
                self.repaint(terminal);
            }
            Down::Claims { enter, arrows } => {
                self.claims = Claims { enter, arrows };
                self.apply_claims(input);
            }
            Down::Enter { action, text } => {
                let Some(write) = self.write.as_mut() else {
                    return Ok(());
                };
                if !matches!(write.stage, Stage::Asking) || write.enter.is_none() {
                    return Ok(());
                }
                match action {
                    EnterAction::Pass => self.finish(input, keys, true),
                    EnterAction::Append | EnterAction::Replace if text.is_empty() => {
                        self.finish(input, keys, true)
                    }
                    EnterAction::Append => {
                        let mode = Mode::Append;
                        self.start_write(mode, &text, terminal, keys, input);
                    }
                    EnterAction::Replace => {
                        self.start_write(Mode::Replace, &text, terminal, keys, input);
                    }
                }
            }
            Down::Write { id, text, expect } => {
                let fits = match &self.draft {
                    Draft::Visible { text: now, .. } => {
                        now.trim().is_empty()
                            || expect.as_deref().is_some_and(|e| same(e, now))
                    }
                    Draft::Unavailable => false,
                };
                if self.write.is_some() || !fits || !terminal.safe_to_inspect() {
                    self.send(Up::Wrote { id, ok: false });
                    return Ok(());
                }
                input.hold();
                self.write = Some(Pending {
                    since: Instant::now(),
                    stage: Stage::Asking,
                    enter: None,
                    id: Some(id),
                });
                let empty = self.draft.text().is_some_and(|now| now.trim().is_empty());
                let mode = if empty { Mode::Append } else { Mode::Replace };
                self.start_write(mode, &text, terminal, keys, input);
            }
        }
        Ok(())
    }

    /// Paste when the caret sits at the end of a fully visible draft (or the
    /// box is empty); otherwise go through Codex's editor handoff.
    fn start_write(
        &mut self,
        mode: Mode,
        text: &str,
        terminal: &Output,
        keys: &mut Queue,
        input: &mut Input,
    ) {
        let tail = tail_of(text);
        let pasteable = mode == Mode::Append
            && terminal.bracketed_paste()
            && text.chars().count() <= PASTE_MAX
            && matches!(
                self.draft,
                Draft::Visible {
                    at_end: true,
                    clipped: false,
                    ..
                }
            );
        let editor = if pasteable {
            keys.bytes.extend_from_slice(b"\x1b[200~");
            keys.bytes.extend_from_slice(text.replace('\x1b', "").as_bytes());
            keys.bytes.extend_from_slice(b"\x1b[201~");
            false
        } else if let (Some(editor), Some(key)) = (&self.editor, self.host.editor_key())
            && editor.arm(mode, text).is_ok()
        {
            keys.bytes.extend_from_slice(key);
            true
        } else {
            // No way to write: an Enter goes as it is, a write fails.
            self.finish(input, keys, false);
            return;
        };
        if let Some(write) = self.write.as_mut() {
            write.since = Instant::now();
            write.stage = Stage::Showing {
                tail,
                editor,
                reported: false,
            };
        }
    }

    /// Done with the box: forward the Enter, report a write, let typed keys go.
    fn finish(&mut self, input: &mut Input, keys: &mut Queue, ok: bool) {
        let Some(write) = self.write.take() else {
            return;
        };
        if let Some(editor) = &self.editor
            && matches!(write.stage, Stage::Showing { editor: true, .. })
        {
            editor.cancel();
        }
        if let Some(key) = write.enter {
            keys.bytes.extend_from_slice(key.bytes());
        }
        if let Some(id) = write.id {
            self.send(Up::Wrote { id, ok });
        }
        input.release(&mut keys.bytes);
    }

    fn tick(&mut self, input: &mut Input, terminal: &Output, keys: &mut Queue) {
        let now = Instant::now();
        let outcome = {
            let Some(write) = self.write.as_mut() else {
                return;
            };
            match &mut write.stage {
                // MarginCue did not answer: the prompt goes as written.
                Stage::Asking => (now >= write.since + ENTER_ANSWER).then_some(false),
                Stage::Showing {
                    tail,
                    editor,
                    reported,
                } => {
                    if *editor && !*reported {
                        *reported = self.editor.as_ref().and_then(Editor::report).is_some();
                    }
                    let shown = (!*editor || *reported)
                        && terminal.safe_to_inspect()
                        && self
                            .draft
                            .text()
                            .is_some_and(|text| ends_with_tail(text, tail));
                    if shown {
                        Some(true)
                    } else {
                        // Codex never showed it. An Enter still goes: the person meant to send.
                        (now >= write.since + WRITE_TIMEOUT).then_some(false)
                    }
                }
            }
        };
        if let Some(ok) = outcome {
            self.finish(input, keys, ok);
        }
    }
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

/// The end of `text` that must show in the box once it is written.
fn tail_of(text: &str) -> String {
    let normal = normalize(text);
    let count = normal.chars().count();
    normal.chars().skip(count.saturating_sub(24)).collect()
}

fn ends_with_tail(text: &str, tail: &str) -> bool {
    normalize(text).ends_with(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tails_ignore_wrapping() {
        let tail = tail_of("\n\nDecisions:\n- Export covers the filtered rows.");
        assert_eq!(tail, "overs the filtered rows.");
        assert!(ends_with_tail(
            "Add an export\n\nDecisions:\n- Export covers the filtered\nrows.",
            &tail
        ));
    }

    #[test]
    fn card_height_limits() {
        assert_eq!(max_band(Size::cells(10, 80), true), 0);
        assert_eq!(max_band(Size::cells(30, 80), false), 1);
        assert_eq!(max_band(Size::cells(30, 80), true), 18);
        assert_eq!(max_band(Size::cells(38, 80), true), 22);
        assert_eq!(max_band(Size::cells(16, 80), true), 4);
        assert_eq!(max_band(Size::cells(60, 80), true), 24);
    }
}

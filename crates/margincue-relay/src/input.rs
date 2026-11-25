//! Outer input has two consumers: Codex and the card. Bytes go straight to
//! Codex unless the card has claimed that key right now (Enter while there
//! are Decisions to add, alt+↑/↓ while the card has rows), or they are a
//! press on the card's rows, or the Ctrl+] chord. Only a split ESC/CSI has a
//! short framing deadline, because a lone Escape can be a complete key.

use std::collections::VecDeque;
use std::io::Write;
use std::time::{Duration, Instant};

use crate::io::Size;
use crate::wire::{csi, integer, split_first};

const ESCAPE_WAIT: Duration = Duration::from_millis(4);
const LEADER_WAIT: Duration = Duration::from_millis(750);
const END_PASTE: &[u8] = b"\x1b[201~";
const PASTE_LIMIT: usize = 1 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Ctrl+] t: MarginCue off or on for this session.
    Toggle,
    /// Ctrl+] d: hide the card until the draft changes.
    Dismiss,
    /// Ctrl+] c: read the draft on demand.
    Read,
    /// Claimed Enter. `bytes` is how it arrived, to forward it later.
    Enter(EnterKey),
    Up,
    Down,
    /// A press on the card; `y` counts from the card's first row.
    Click { x: u16, y: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnterKey {
    Legacy,
    Kitty,
}

impl EnterKey {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Self::Legacy => b"\r",
            Self::Kitty => b"\x1b[13u",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Claims {
    pub enter: bool,
    pub arrows: bool,
    pub read: bool,
}

#[derive(Default)]
pub struct Input {
    escape: Vec<u8>,
    escape_deadline: Option<Instant>,
    paste_match: Option<usize>,
    paste: Vec<u8>,
    pastes: Vec<String>,
    leader: Vec<u8>,
    leader_deadline: Option<Instant>,
    consumed_key: Option<u16>,
    dragging: bool,
    pixel_replies: VecDeque<PixelQuery>,
    pub claims: Claims,
    /// While set, typed keys wait in `held` (terminal replies still pass).
    hold: bool,
    held: Vec<u8>,
}

#[derive(Clone, Copy)]
pub enum PixelQuery {
    TextArea,
    WholeWindow,
}

#[derive(Clone, Copy)]
pub struct Geometry {
    pub outer: Size,
    pub inner: Size,
    pub pixel_mouse: bool,
}

impl Input {
    pub fn expect_pixel_reply(&mut self, query: PixelQuery) {
        self.pixel_replies.push_back(query);
    }

    /// Keys typed from now on wait until `release`.
    pub fn hold(&mut self) {
        self.hold = true;
    }

    /// Typed keys that waited, in order; keys flow again.
    pub fn release(&mut self, to_child: &mut Vec<u8>) {
        self.hold = false;
        to_child.append(&mut self.held);
    }

    /// Queue bytes behind the held keys (a second Enter during a write).
    pub fn defer(&mut self, bytes: &[u8]) {
        self.held.extend_from_slice(bytes);
    }

    pub fn holding(&self) -> bool {
        self.hold
    }

    fn emit(&mut self, bytes: &[u8], to_child: &mut Vec<u8>) {
        if self.hold {
            self.held.extend_from_slice(bytes);
        } else {
            to_child.extend_from_slice(bytes);
        }
    }

    /// Pastes completed since the last call, as typed.
    pub fn take_pastes(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pastes)
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.escape_deadline
            .into_iter()
            .chain(self.leader_deadline)
            .min()
    }

    pub fn expire(
        &mut self,
        now: Instant,
        to_child: &mut Vec<u8>,
        mut act: impl FnMut(Action, &mut Vec<u8>),
    ) {
        if self.escape_deadline.is_some_and(|due| due <= now) {
            self.escape_deadline = None;
            let mut escape = std::mem::take(&mut self.escape);
            if let Some(action) = self.route_key(&escape, now, to_child) {
                act(action, to_child);
            }
            escape.clear();
            self.escape = escape;
        }
        if self.leader_deadline.is_some_and(|due| due <= now) {
            self.clear_leader(to_child);
        }
    }

    pub fn process(
        &mut self,
        bytes: &[u8],
        now: Instant,
        geometry: Geometry,
        to_child: &mut Vec<u8>,
        mut act: impl FnMut(Action, &mut Vec<u8>),
    ) {
        self.expire(now, to_child, &mut act);
        for &byte in bytes {
            if let Some(matched) = self.paste_match {
                self.emit(&[byte], to_child);
                if self.paste.len() < PASTE_LIMIT {
                    self.paste.push(byte);
                }
                self.paste_match = if byte == END_PASTE[matched] {
                    (matched + 1 < END_PASTE.len()).then_some(matched + 1)
                } else {
                    Some(usize::from(byte == END_PASTE[0]))
                };
                if self.paste_match.is_none() {
                    let mut text = std::mem::take(&mut self.paste);
                    if text.ends_with(END_PASTE) {
                        text.truncate(text.len() - END_PASTE.len());
                    }
                    self.pastes.push(String::from_utf8_lossy(&text).into_owned());
                }
                continue;
            }
            if self.escape.is_empty() && byte != 0x1b {
                if let Some(action) = self.route_key(&[byte], now, to_child) {
                    act(action, to_child);
                }
                continue;
            }
            self.escape.push(byte);
            self.escape_deadline = Some(now + ESCAPE_WAIT);
            let complete = match self.escape.as_slice() {
                [0x1b] | b"\x1b[" | b"\x1bO" => false,
                // An ESC-prefixed (Option as Meta) arrow: ESC ESC [ A.
                [0x1b, 0x1b] | [0x1b, 0x1b, b'[' | b'O'] => false,
                [0x1b, 0x1b, b'[' | b'O', rest @ ..] => {
                    (0x40..=0x7e).contains(&byte) || rest.len() >= 64
                }
                // X10 mouse report includes three unframed bytes.
                [0x1b, b'[', b'M', rest @ ..] => rest.len() >= 3,
                [0x1b, b'[' | b'O', rest @ ..] => {
                    (0x40..=0x7e).contains(&byte) || rest.len() >= 64 || byte == 0x1b
                }
                _ => true,
            };
            if !complete {
                continue;
            }
            self.escape_deadline = None;
            let key = std::mem::take(&mut self.escape);
            if key == b"\x1b[200~" {
                self.clear_leader(to_child);
                self.paste_match = Some(0);
                self.paste.clear();
                self.emit(&key, to_child);
            } else {
                match self.terminal_event(&key, geometry, to_child) {
                    Event::Consumed => {}
                    Event::Click(x, y) => act(Action::Click { x, y }, to_child),
                    Event::Key => {
                        if let Some(action) = self.route_key(&key, now, to_child) {
                            act(action, to_child);
                        }
                    }
                }
            }
            self.escape = key;
            self.escape.clear();
        }
    }

    fn route_key(&mut self, key: &[u8], now: Instant, to_child: &mut Vec<u8>) -> Option<Action> {
        let decoded = decode_key(key);
        if let Some((code, modifier, event @ (2 | 3))) = decoded {
            if modifier == 1 && self.consumed_key == Some(code) {
                if event == 3 {
                    self.consumed_key = None;
                }
            } else if (code, modifier) != (93, 5) {
                self.emit(key, to_child);
            }
            return None;
        }
        self.consumed_key = None;
        let is_leader = key == b"\x1d" || decoded == Some((93, 5, 1));
        if is_leader {
            if self.leader.is_empty() {
                self.leader.extend_from_slice(key);
                self.leader_deadline = Some(now + LEADER_WAIT);
            } else {
                self.clear_leader(to_child);
            }
            return None;
        }
        if !self.leader.is_empty() {
            let code = match (key, decoded) {
                ([byte], _) => Some(u16::from(*byte)),
                (_, Some((code, 1, 1))) => Some(code),
                _ => None,
            };
            let action = match code.and_then(|code| u8::try_from(code).ok()) {
                Some(b't') => Some(Action::Toggle),
                Some(b'd') => Some(Action::Dismiss),
                Some(b'c') if self.claims.read => Some(Action::Read),
                _ => None,
            };
            if action.is_some() {
                self.consumed_key = decoded.map(|(code, _, _)| code);
                self.leader.clear();
                self.leader_deadline = None;
                return action;
            }
            self.clear_leader(to_child);
        }
        if self.claims.enter {
            if key == b"\r" {
                return Some(Action::Enter(EnterKey::Legacy));
            }
            if decoded == Some((13, 1, 1)) {
                self.consumed_key = Some(13);
                return Some(Action::Enter(EnterKey::Kitty));
            }
        }
        if self.claims.arrows
            && let Some(up) = alt_arrow(key)
        {
            return Some(if up { Action::Up } else { Action::Down });
        }
        self.emit(key, to_child);
        None
    }

    fn clear_leader(&mut self, to_child: &mut Vec<u8>) {
        let leader = std::mem::take(&mut self.leader);
        self.emit(&leader, to_child);
        self.leader_deadline = None;
    }

    fn terminal_event(&mut self, key: &[u8], size: Geometry, to_child: &mut Vec<u8>) -> Event {
        if let [0x1b, b'[', b'M', _, _, y] = key {
            if u16::from(y.saturating_sub(32)) <= size.inner.rows {
                to_child.extend_from_slice(key);
            }
            return Event::Consumed;
        }
        let Some((params, opcode)) = csi(key) else {
            return Event::Key;
        };
        if matches!(opcode, b'M' | b'm')
            && let Some(fields) = params.strip_prefix(b"<")
            && let Some((head, row)) = split_last(fields, b';')
            && let (Some(button), Some(row)) = (
                head.split(|&b| b == b';').next().and_then(integer),
                integer(row),
            )
        {
            let limit = if size.pixel_mouse {
                size.inner.ypixel
            } else {
                size.inner.rows
            };
            let in_viewport = limit == 0 || row <= limit;
            let mut event = Event::Consumed;
            if in_viewport {
                to_child.extend_from_slice(key);
            } else if self.dragging && (opcode == b'm' || button & 32 != 0) {
                // Deliver the end of a drag that began above the card. If
                // the release were swallowed the app could stay in drag mode.
                to_child.extend_from_slice(b"\x1b[<");
                to_child.extend_from_slice(head);
                write!(to_child, ";{limit}{}", char::from(opcode)).unwrap();
            } else if opcode == b'M'
                && !size.pixel_mouse
                && button & (32 | 64) == 0
                && button & 3 == 0
                && let Some(col) = split_first(head, b';')
                    .and_then(|(_, col)| integer(col))
            {
                event = Event::Click(col.saturating_sub(1), row - size.inner.rows - 1);
            }
            if opcode == b'm' {
                self.dragging = false;
            } else if button & 96 == 0 && button & 3 != 3 {
                self.dragging = in_viewport;
            }
            return event;
        }
        if opcode == b't'
            && let Some(fields) = params.strip_prefix(b"4;")
            && let Some((height, width)) = split_first(fields, b';')
            && let (Some(height), Some(width)) = (integer(height), integer(width))
            && matches!(self.pixel_replies.pop_front(), Some(PixelQuery::TextArea))
        {
            let cropped =
                u32::from(height) * u32::from(size.inner.rows) / u32::from(size.outer.rows);
            write!(to_child, "\x1b[4;{cropped};{width}t").unwrap();
            return Event::Consumed;
        }
        // Focus and terminal replies are not keys.
        if matches!(opcode, b'I' | b'O' | b'R' | b't' | b'c')
            || (opcode == b'u' && params.starts_with(b"?"))
        {
            to_child.extend_from_slice(key);
            return Event::Consumed;
        }
        Event::Key
    }
}

enum Event {
    Consumed,
    Click(u16, u16),
    Key,
}

/// alt+↑ (true) or alt+↓ (false), in the forms terminals send it.
fn alt_arrow(key: &[u8]) -> Option<bool> {
    let up = |final_byte: u8| match final_byte {
        b'A' => Some(true),
        b'B' => Some(false),
        _ => None,
    };
    match key {
        [0x1b, 0x1b, b'[' | b'O', last] => return up(*last),
        _ => {}
    }
    let (params, opcode) = csi(key)?;
    let direction = up(opcode)?;
    let (first, rest) = split_first(params, b';')?;
    if integer(first)? != 1 {
        return None;
    }
    let mut fields = rest.split(|&b| b == b':');
    let modifier = integer(fields.next()?)?;
    let event = fields.next().map_or(Some(1), integer)?;
    (matches!(modifier, 3 | 9 | 11) && event == 1).then_some(direction)
}

fn decode_key(key: &[u8]) -> Option<(u16, u16, u16)> {
    let (params, opcode) = csi(key)?;
    if opcode == b'~' {
        let (modifiers, code) = split_first(params.strip_prefix(b"27;")?, b';')?;
        return Some((integer(code)?, integer(modifiers)?, 1));
    }
    if opcode != b'u' {
        return None;
    }
    let mut fields = params.split(|&b| b == b';');
    let code = integer(fields.next()?.split(|&b| b == b':').next()?)?;
    let mut modifiers = fields.next().unwrap_or(b"1").split(|&b| b == b':');
    let modifier = integer(modifiers.next()?)?.max(1);
    // Caps/Num Lock don't affect the relay's bindings.
    let modifier = ((modifier - 1) & !(64 | 128)) + 1;
    let event = integer(modifiers.next().unwrap_or(b"1"))?.max(1);
    Some((code, modifier, event))
}

fn split_last(bytes: &[u8], separator: u8) -> Option<(&[u8], &[u8])> {
    let offset = memchr::memrchr(separator, bytes)?;
    Some((&bytes[..offset], &bytes[offset + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry() -> Geometry {
        Geometry {
            outer: Size::cells(30, 100),
            inner: Size::cells(26, 100),
            pixel_mouse: false,
        }
    }

    fn run(input: &mut Input, bytes: &[u8]) -> (Vec<u8>, Vec<Action>) {
        let mut out = Vec::new();
        let mut actions = Vec::new();
        let now = Instant::now();
        input.process(bytes, now, geometry(), &mut out, |a, _| actions.push(a));
        input.expire(now + Duration::from_millis(10), &mut out, |a, _| actions.push(a));
        (out, actions)
    }

    #[test]
    fn enter_passes_unless_claimed() {
        let mut input = Input::default();
        assert_eq!(run(&mut input, b"hi\r"), (b"hi\r".to_vec(), vec![]));
        input.claims.enter = true;
        assert_eq!(
            run(&mut input, b"hi\r"),
            (b"hi".to_vec(), vec![Action::Enter(EnterKey::Legacy)])
        );
        // A newline inside a paste is text, never Enter.
        let (out, actions) = run(&mut input, b"\x1b[200~a\rb\x1b[201~");
        assert_eq!(out, b"\x1b[200~a\rb\x1b[201~");
        assert!(actions.is_empty());
        assert_eq!(input.take_pastes(), vec!["a\rb".to_string()]);
        // kitty Enter, its release swallowed with it.
        let (out, actions) = run(&mut input, b"\x1b[13u\x1b[13;1:3u");
        assert!(out.is_empty(), "{out:?}");
        assert_eq!(actions, vec![Action::Enter(EnterKey::Kitty)]);
        // shift+Enter stays Codex's newline.
        assert_eq!(run(&mut input, b"\x1b[13;2u").0, b"\x1b[13;2u");
    }

    #[test]
    fn alt_arrows_in_every_form() {
        let mut input = Input::default();
        assert_eq!(run(&mut input, b"\x1b[1;3A").0, b"\x1b[1;3A");
        input.claims.arrows = true;
        for (bytes, action) in [
            (&b"\x1b[1;3A"[..], Action::Up),
            (b"\x1b[1;3B", Action::Down),
            (b"\x1b[1;9A", Action::Up),
            (b"\x1b\x1b[B", Action::Down),
            (b"\x1b[1;3:1A", Action::Up),
        ] {
            assert_eq!(run(&mut input, bytes), (vec![], vec![action]), "{bytes:?}");
        }
        // Plain and ctrl arrows, and a key release, stay Codex's.
        for bytes in [&b"\x1b[A"[..], b"\x1b[1;5A", b"\x1b[1;3:3A"] {
            assert_eq!(run(&mut input, bytes).0, bytes, "{bytes:?}");
        }
        // Two Escapes are two Escapes.
        assert_eq!(run(&mut input, b"\x1b\x1b").0, b"\x1b\x1b");
    }

    #[test]
    fn clicks_on_the_card() {
        let mut input = Input::default();
        // Row 28 of 30 with 26 child rows: the card's second row.
        let (out, actions) = run(&mut input, b"\x1b[<0;12;28M\x1b[<0;12;28m");
        assert!(out.is_empty());
        assert_eq!(actions, vec![Action::Click { x: 11, y: 1 }]);
        // Above the card, Codex gets it.
        let (out, actions) = run(&mut input, b"\x1b[<0;12;3M");
        assert_eq!(out, b"\x1b[<0;12;3M");
        assert!(actions.is_empty());
        // The wheel over the card is dropped.
        let (out, actions) = run(&mut input, b"\x1b[<64;12;28M");
        assert!(out.is_empty() && actions.is_empty());
    }

    #[test]
    fn leader_chords() {
        let mut input = Input::default();
        assert_eq!(run(&mut input, b"\x1dt").1, vec![Action::Toggle]);
        assert_eq!(run(&mut input, b"\x1dd").1, vec![Action::Dismiss]);
        assert_eq!(run(&mut input, b"\x1dx").0, b"\x1dx");
        assert_eq!(run(&mut input, b"\x1dc"), (b"\x1dc".to_vec(), vec![]));
        input.claims.read = true;
        assert_eq!(run(&mut input, b"\x1dc"), (vec![], vec![Action::Read]));
        assert_eq!(
            run(&mut input, b"\x1b[93;5u\x1b[99u\x1b[99;1:3u"),
            (vec![], vec![Action::Read])
        );
        assert_eq!(run(&mut input, b"c"), (b"c".to_vec(), vec![]));
    }

    #[test]
    fn held_keys_wait_but_replies_pass() {
        let mut input = Input::default();
        input.hold();
        let (out, _) = run(&mut input, b"ab\x1b[12;40R\x1b[200~p\x1b[201~");
        assert_eq!(out, b"\x1b[12;40R");
        let mut out = Vec::new();
        input.defer(b"\r");
        input.release(&mut out);
        assert_eq!(out, b"ab\x1b[200~p\x1b[201~\r");
        assert!(!input.holding());
    }
}

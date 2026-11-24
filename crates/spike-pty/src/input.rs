//! Outer input has two consumers: the agent and the wrapper's one leader.
//! Ordinary bytes are relayed immediately. Only a split ESC/CSI has a short
//! framing deadline, because legacy Escape can be a complete key by itself.

use std::collections::VecDeque;
use std::io::Write;
use std::time::{Duration, Instant};

use crate::io::Size;
use crate::wire::{csi, integer, split_first};

const ESCAPE_WAIT: Duration = Duration::from_millis(4);
const LEADER_WAIT: Duration = Duration::from_millis(750);
const END_PASTE: &[u8] = b"\x1b[201~";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Pick(u8),
    Next,
    Dismiss,
    Toggle,
    Paste,
}

#[derive(Default)]
pub struct Input {
    escape: Vec<u8>,
    escape_deadline: Option<Instant>,
    paste_match: Option<usize>,
    leader: Vec<u8>,
    leader_deadline: Option<Instant>,
    consumed_key: Option<u16>,
    dragging: bool,
    pixel_replies: VecDeque<PixelQuery>,
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

    pub fn deadline(&self) -> Option<Instant> {
        self.escape_deadline
            .into_iter()
            .chain(self.leader_deadline)
            .min()
    }

    pub fn expire(&mut self, now: Instant, to_child: &mut Vec<u8>) {
        if self.escape_deadline.is_some_and(|due| due <= now) {
            self.escape_deadline = None;
            let mut escape = std::mem::take(&mut self.escape);
            self.route_key(&escape, now, to_child);
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
        self.expire(now, to_child);
        for &byte in bytes {
            if let Some(matched) = self.paste_match {
                to_child.push(byte);
                self.paste_match = if byte == END_PASTE[matched] {
                    (matched + 1 < END_PASTE.len()).then_some(matched + 1)
                } else {
                    Some(usize::from(byte == END_PASTE[0]))
                };
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
                to_child.extend_from_slice(&key);
            } else if !self.terminal_event(&key, geometry, to_child)
                && let Some(action) = self.route_key(&key, now, to_child)
            {
                act(action, to_child);
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
                to_child.extend_from_slice(key);
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
            let key = match (key, decoded) {
                ([byte], _) => Some(u16::from(*byte)),
                (_, Some((code, 1, 1))) => Some(code),
                _ => None,
            };
            let action = match key.and_then(|code| u8::try_from(code).ok()) {
                Some(n @ b'1'..=b'3') => Some(Action::Pick(n - b'0')),
                Some(b'n') => Some(Action::Next),
                Some(b'd') => Some(Action::Dismiss),
                Some(b't') => Some(Action::Toggle),
                Some(b'p') => Some(Action::Paste),
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
        to_child.extend_from_slice(key);
        None
    }

    fn clear_leader(&mut self, to_child: &mut Vec<u8>) {
        to_child.extend_from_slice(&self.leader);
        self.leader.clear();
        self.leader_deadline = None;
    }

    fn terminal_event(&mut self, key: &[u8], size: Geometry, to_child: &mut Vec<u8>) -> bool {
        if let [0x1b, b'[', b'M', _, _, y] = key {
            if u16::from(y.saturating_sub(32)) <= size.inner.rows {
                to_child.extend_from_slice(key);
            }
            return true;
        }
        let Some((params, opcode)) = csi(key) else {
            return false;
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
            if in_viewport {
                to_child.extend_from_slice(key);
            } else if self.dragging && (opcode == b'm' || button & 32 != 0) {
                // Deliver the end of a drag that began above the band. If
                // the release were swallowed the app could stay in drag mode.
                to_child.extend_from_slice(b"\x1b[<");
                to_child.extend_from_slice(head);
                write!(to_child, ";{limit}{}", char::from(opcode)).unwrap();
            }
            if opcode == b'm' {
                self.dragging = false;
            } else if button & 96 == 0 && button & 3 != 3 {
                self.dragging = in_viewport;
            }
            return true;
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
            return true;
        }
        // Focus and terminal replies are not continuation keys for a leader.
        if matches!(opcode, b'I' | b'O' | b'R' | b't' | b'c')
            || (opcode == b'u' && params.starts_with(b"?"))
        {
            to_child.extend_from_slice(key);
            return true;
        }
        false
    }
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
    // Caps/Num Lock don't affect the wrapper binding.
    let modifier = ((modifier - 1) & !(64 | 128)) + 1;
    let event = integer(modifiers.next().unwrap_or(b"1"))?.max(1);
    Some((code, modifier, event))
}

fn split_last(bytes: &[u8], separator: u8) -> Option<(&[u8], &[u8])> {
    let offset = memchr::memrchr(separator, bytes)?;
    Some((&bytes[..offset], &bytes[offset + 1..]))
}

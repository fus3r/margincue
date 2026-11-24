//! Lossless framing of the 7-bit control sequences used by the tested TUIs.
//! vte (inside vt100) interprets these bytes for the shadow screen. The
//! forwarding path keeps the original spelling of sequences it does not own.

use memchr::{memchr, memchr2};

const ESC: u8 = 0x1b;
const SHORT_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    Csi,
    String { bell_ends: bool },
    StringEscape,
    Overflow,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Control,
    Opaque,
}

pub struct Framer {
    state: State,
    short: Vec<u8>,
    utf8_left: u8,
}

impl Default for Framer {
    fn default() -> Self {
        Self {
            state: State::Ground,
            short: Vec::with_capacity(32),
            utf8_left: 0,
        }
    }
}

impl Framer {
    pub fn ground(&self) -> bool {
        self.state == State::Ground && self.utf8_left == 0
    }

    pub fn process(&mut self, mut bytes: &[u8], mut emit: impl FnMut(Kind, &[u8])) {
        while let Some(&byte) = bytes.first() {
            match self.state {
                State::Ground if byte != ESC => {
                    let len = memchr(ESC, bytes).unwrap_or(bytes.len());
                    let text = &bytes[..len];
                    self.track_utf8_tail(text);
                    emit(Kind::Text, text);
                    bytes = &bytes[len..];
                    continue;
                }
                State::Ground => {
                    self.utf8_left = 0;
                    self.short.push(byte);
                    self.state = State::Escape;
                }
                State::Escape | State::Csi | State::Overflow if byte == ESC => {
                    // A new ESC aborts an incomplete short sequence.
                    emit(Kind::Opaque, &self.short);
                    self.short.clear();
                    self.short.push(ESC);
                    self.state = State::Escape;
                }
                State::Escape if self.short.len() == 1 && byte == b'[' => {
                    self.short.push(byte);
                    self.state = State::Csi;
                }
                State::Escape
                    if self.short.len() == 1
                        && matches!(byte, b']' | b'P' | b'_' | b'^' | b'X') =>
                {
                    self.short.push(byte);
                    emit(Kind::Opaque, &self.short);
                    self.short.clear();
                    self.state = State::String {
                        bell_ends: byte == b']',
                    };
                }
                State::Escape | State::Csi => {
                    self.short.push(byte);
                    let final_byte = match self.state {
                        State::Csi => (0x40..=0x7e).contains(&byte),
                        _ => (0x30..=0x7e).contains(&byte),
                    };
                    if final_byte || matches!(byte, 0x18 | 0x1a | 0x80..=0xff) {
                        emit(Kind::Control, &self.short);
                        self.short.clear();
                        self.state = State::Ground;
                    } else if self.short.len() == SHORT_LIMIT {
                        emit(Kind::Opaque, &self.short);
                        self.short.clear();
                        self.state = State::Overflow;
                    }
                }
                State::Overflow => {
                    emit(Kind::Opaque, &bytes[..1]);
                    if (0x40..=0x7e).contains(&byte) || matches!(byte, 0x18 | 0x1a) {
                        self.state = State::Ground;
                    }
                }
                State::String { bell_ends } => {
                    let len = if bell_ends {
                        memchr2(ESC, 7, bytes)
                    } else {
                        memchr(ESC, bytes)
                    };
                    let len = len.unwrap_or(bytes.len());
                    // CAN and SUB cancel strings. They are uncommon in normal
                    // output, but honor them before introducing any band bytes.
                    let cancel = memchr2(0x18, 0x1a, &bytes[..len]);
                    if let Some(index) = cancel {
                        let n = index + 1;
                        emit(Kind::Opaque, &bytes[..n]);
                        bytes = &bytes[n..];
                        self.state = State::Ground;
                        continue;
                    }
                    if len > 0 {
                        emit(Kind::Opaque, &bytes[..len]);
                        bytes = &bytes[len..];
                        continue;
                    }
                    if byte == ESC {
                        self.state = State::StringEscape;
                    } else {
                        emit(Kind::Opaque, &bytes[..1]); // OSC BEL
                        self.state = State::Ground;
                    }
                }
                State::StringEscape if byte == b'\\' => {
                    emit(Kind::Opaque, b"\x1b\\");
                    self.state = State::Ground;
                }
                State::StringEscape => {
                    // ESC with any other final begins a new sequence.
                    self.state = State::Escape;
                    self.short.push(ESC);
                    continue;
                }
            }
            bytes = &bytes[1..];
        }
    }

    pub fn finish(&mut self, output: &mut Vec<u8>) {
        output.append(&mut self.short);
        if self.state == State::StringEscape {
            output.push(ESC);
        }
        self.state = State::Ground;
    }

    fn track_utf8_tail(&mut self, bytes: &[u8]) {
        // Only the tail determines whether it is safe to inject an escape.
        // Looking back at most four bytes avoids scanning printable runs twice.
        for (offset, byte) in bytes.iter().rev().take(4).enumerate() {
            let width: u8 = match byte {
                0x00..=0x7f => 1,
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                0x80..=0xbf => continue,
                _ => 1,
            };
            self.utf8_left = width.saturating_sub(1 + offset as u8);
            return;
        }
        self.utf8_left = self.utf8_left.saturating_sub(bytes.len().min(4) as u8);
    }
}

pub fn csi(bytes: &[u8]) -> Option<(&[u8], u8)> {
    let [params @ .., final_byte @ 0x40..=0x7e] = bytes.strip_prefix(b"\x1b[")? else {
        return None;
    };
    Some((params, *final_byte))
}

pub fn integer(bytes: &[u8]) -> Option<u16> {
    if bytes.is_empty() {
        return Some(0);
    }
    bytes.iter().try_fold(0u16, |n, byte| {
        if !byte.is_ascii_digit() {
            return None;
        }
        n.checked_mul(10)?.checked_add(u16::from(byte - b'0'))
    })
}

pub fn split_first(bytes: &[u8], separator: u8) -> Option<(&[u8], &[u8])> {
    let offset = memchr(separator, bytes)?;
    Some((&bytes[..offset], &bytes[offset + 1..]))
}

//! One JSON object per line between the relay and MarginCue, the Node process
//! that started it. The relay owns the terminal and reads the prompt box;
//! MarginCue owns the card and says what to draw and what to write.

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

/// Relay to MarginCue.
#[derive(Serialize, Debug)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Up<'a> {
    /// `max`: the most rows the card may take now. `full`: Codex is on its
    /// full-screen view, where the card may grow and shrink.
    Hello {
        protocol: u32,
        cols: u16,
        rows: u16,
        max: u16,
        full: bool,
    },
    Size {
        cols: u16,
        rows: u16,
        max: u16,
        full: bool,
    },
    /// `text` is null when no plain prompt box is on screen.
    Draft {
        text: Option<&'a str>,
        approx: bool,
        end: bool,
        plain: bool,
    },
    Key {
        key: &'static str,
    },
    /// A press on the card; `y` counts from the card's first row.
    Click {
        x: u16,
        y: u16,
    },
    /// The person pressed Enter on a plain prompt box while Enter is claimed.
    Enter {
        text: &'a str,
        approx: bool,
    },
    Wrote {
        id: u64,
        ok: bool,
    },
    Toggle {
        on: bool,
    },
    Dismiss,
}

/// MarginCue to the relay.
#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Down {
    /// The card's rows as text with SGR styling only, one row per line.
    Band { lines: Vec<String> },
    /// Keys the relay should hand to MarginCue instead of Codex.
    Claims {
        #[serde(default)]
        enter: bool,
        #[serde(default)]
        arrows: bool,
    },
    /// The answer to `enter`.
    Enter {
        #[serde(rename = "do")]
        action: EnterAction,
        #[serde(default)]
        text: String,
    },
    /// Put `text` in the prompt box: when it is empty, or still holds `expect`.
    Write {
        id: u64,
        text: String,
        #[serde(default)]
        expect: Option<String>,
    },
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnterAction {
    /// Send the prompt as it is.
    Pass,
    /// Add `text` at the end of the prompt, then send.
    Append,
    /// Make `text` the whole prompt, then send.
    Replace,
}

pub fn encode(message: &Up) -> Vec<u8> {
    let mut line = serde_json::to_vec(message).unwrap_or_default();
    line.push(b'\n');
    line
}

/// Splits complete lines off `buffer` and decodes them; bad lines are dropped.
pub fn decode(buffer: &mut Vec<u8>) -> Vec<Down> {
    let mut out = Vec::new();
    while let Some(end) = memchr::memchr(b'\n', buffer) {
        let line: Vec<u8> = buffer.drain(..=end).collect();
        if let Ok(message) = serde_json::from_slice::<Down>(&line[..line.len() - 1]) {
            out.push(message);
        }
    }
    out
}

/// A card row as the terminal may draw it: printable text and SGR sequences
/// only, cut at `cols` cells. Anything that could move the cursor is dropped.
pub fn sanitize(line: &str, cols: u16) -> Vec<u8> {
    use unicode_width::UnicodeWidthChar;
    let mut out = Vec::with_capacity(line.len());
    let mut width = 0usize;
    let limit = usize::from(cols);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    let mut params = String::new();
                    let mut sgr = true;
                    let mut last = None;
                    for p in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&p) {
                            last = Some(p);
                            break;
                        }
                        sgr &= p.is_ascii_digit() || p == ';' || p == ':';
                        params.push(p);
                    }
                    if sgr && last == Some('m') && params.len() <= 64 {
                        out.extend_from_slice(b"\x1b[");
                        out.extend_from_slice(params.as_bytes());
                        out.push(b'm');
                    }
                }
                Some(']' | 'P' | '_' | '^') => {
                    // A string: skip it to its terminator.
                    chars.next();
                    while let Some(p) = chars.next() {
                        if p == '\x07' {
                            break;
                        }
                        if p == '\x1b' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if c.is_control() {
            continue;
        }
        let w = c.width().unwrap_or(0);
        if width + w > limit {
            break;
        }
        width += w;
        let mut buf = [0; 4];
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
    out.extend_from_slice(b"\x1b[m");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_sgr_and_cuts_width() {
        let line = "\x1b[1;38;5;81mHello\x1b[0m \x1b[2Jworld\x1b]8;;x\x07";
        let out = String::from_utf8(sanitize(line, 8)).unwrap();
        assert_eq!(out, "\x1b[1;38;5;81mHello\x1b[0m wo\x1b[m");
        let out = String::from_utf8(sanitize("a\x1b]8;;http://x\x1b\\b\x1b[?25lc\nd", 10)).unwrap();
        assert_eq!(out, "abcd\x1b[m");
    }

    #[test]
    fn decode_splits_lines() {
        let mut buffer = b"{\"t\":\"claims\",\"enter\":true}\n{\"t\":\"band\",\"lines\":[\"a\"]}\n{\"t\":\"ba".to_vec();
        let messages = decode(&mut buffer);
        assert_eq!(messages.len(), 2);
        assert_eq!(buffer, b"{\"t\":\"ba");
        assert!(matches!(messages[0], Down::Claims { enter: true, arrows: false }));
    }

    #[test]
    fn encode_draft() {
        let line = encode(&Up::Draft { text: Some("hi"), approx: false, end: true, plain: true });
        assert_eq!(line, b"{\"t\":\"draft\",\"text\":\"hi\",\"approx\":false,\"end\":true,\"plain\":true}\n");
    }
}

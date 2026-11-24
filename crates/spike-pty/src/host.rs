//! Prompt-box logic belongs here, separate from the terminal relay.

use std::ffi::OsStr;
use std::path::Path;
use unicode_width::UnicodeWidthStr;
use vt100::{Cell, Screen};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Generic,
    Codex,
    Claude,
}

impl Host {
    pub fn detect(program: &OsStr) -> Self {
        match Path::new(program).file_name().and_then(OsStr::to_str) {
            Some("codex") => Self::Codex,
            Some("claude") => Self::Claude,
            _ => Self::Generic,
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "generic" => Some(Self::Generic),
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Generic => "generic",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    pub fn editor_key(self) -> Option<&'static [u8]> {
        match self {
            Self::Generic => None,
            Self::Codex | Self::Claude => Some(b"\x07"),
        }
    }

    pub fn read(self, screen: &Screen) -> Draft {
        let composer = match self {
            Self::Generic => None,
            Self::Codex => codex_box(screen),
            Self::Claude => claude_box(screen),
        };
        composer.map_or(Draft::Unavailable, |composer| composer.read(screen, self))
    }
}

struct Composer {
    first: u16,
    last: u16,
    left: u16,
    right: u16, // exclusive
    clipped: bool,
}

fn codex_box(screen: &Screen) -> Option<Composer> {
    let (rows, cols) = dimensions(screen);
    let (caret_row, caret_col) = screen.cursor_position();
    let right = cols.checked_sub(1)?;
    if screen.hide_cursor() || !(2..right).contains(&caret_col) {
        return None;
    }
    // The stock composer is full width and writes its arrow only on its first
    // visible row. A dim arrow is disabled input, not an empty textarea.
    let first = (0..=caret_row).rev().find(|&row| {
        screen
            .cell(row, 0)
            .is_some_and(|cell| matches!(cell.contents(), "›" | "»"))
            && blank(cell_at(screen, row, 1))
    })?;
    if screen.cell(first, 0)?.dim() {
        return None;
    }

    // Ratatui puts a blank spacer after the textarea before the footer.
    // Identify familiar footer rows so an empty line inside the draft is
    // retained even when the caret has moved above it.
    let footer = (first + 2..rows).find(|&row| {
        row_blank(screen, row - 1, cols) && codex_footer(&row_text(screen, row, 2, cols))
    });
    let last = if let Some(footer) = footer {
        footer - 2
    } else {
        (caret_row + 1..rows)
            .find(|&row| row_blank(screen, row, cols))
            .unwrap_or(rows)
            - 1
    };
    if caret_row > last {
        return None;
    }
    let clipped = (first..=last).any(|row| {
        [right.saturating_sub(1), right].into_iter().any(|col| {
            screen
                .cell(row, col)
                .is_some_and(|cell| cell.dim() && matches!(cell.contents(), "↑" | "↓"))
        })
    });
    Some(Composer {
        first,
        last,
        left: 2,
        right,
        clipped,
    })
}

fn codex_footer(text: &str) -> bool {
    text.starts_with("? for shortcuts")
        || text.starts_with("← for agents")
        || text.starts_with("tab to queue message")
        || text.contains(" · ") && (text.starts_with("GPT-") || text.contains(" context"))
}

fn claude_box(screen: &Screen) -> Option<Composer> {
    let (rows, cols) = dimensions(screen);
    let (caret_row, caret_col) = screen.cursor_position();
    if cols < 8 || caret_col < 2 || caret_col >= cols {
        return None;
    }
    // Claude's caret is drawn into the grid and the physical cursor is hidden
    // in this build. Demand both rules and the prompt marker at column zero.
    let first = (1..=caret_row).rev().find(|&row| {
        cell_at(screen, row, 0) == "❯"
            && cell_at(screen, row, 1) == "\u{a0}"
            && claude_rule(screen, row - 1, cols)
    })?;
    let boundary = (first + 1..rows).find(|&row| claude_rule(screen, row, cols))?;
    (caret_row < boundary).then_some(Composer {
        first,
        last: boundary - 1,
        left: 2,
        // 2.1.330 uses two padding cells after the editable text. A
        // long unbroken word wrapped at cols-4 in the 70–140 column probes.
        right: cols - 2,
        clipped: false,
    })
}

fn claude_rule(screen: &Screen, row: u16, cols: u16) -> bool {
    (0..cols).all(|col| cell_at(screen, row, col) == "─")
}

impl Composer {
    fn read(&self, screen: &Screen, host: Host) -> Draft {
        let (caret_row, caret_col) = screen.cursor_position();
        let width = usize::from(self.right - self.left);
        let mut lines = Vec::with_capacity(usize::from(self.last - self.first + 1));
        for row in self.first..=self.last {
            lines.push(row_text(screen, row, self.left, self.right));
        }
        // The placeholder changes between releases and installations. Its
        // role is indicated by dim styling at the empty insertion point.
        if self.first == self.last
            && caret_col == self.left
            && (self.left..self.right)
                .filter_map(|col| screen.cell(self.first, col))
                .filter(|cell| !blank(cell.contents()))
                .all(Cell::dim)
        {
            return Draft::Visible {
                text: String::new(),
                approximate: false,
                rows_below_cursor: 0,
                at_end: true,
            };
        }
        if matches!(lines[0].as_bytes().first(), Some(b'/' | b'!' | b'@' | b'$')) {
            return Draft::Unavailable;
        }
        // At the tail the caret supplies one extra piece of information about
        // invisible spaces. Spaces before a hard/soft row boundary are lost.
        if caret_row == self.last
            && let Some(last) = lines.last_mut()
        {
            let trailing = usize::from(caret_col - self.left).saturating_sub(last.width());
            last.extend(std::iter::repeat_n(' ', trailing));
        }
        let mut approximate = self.clipped;
        let mut text = String::new();
        for (i, line) in lines.iter().enumerate() {
            if i > 0 {
                let before = &lines[i - 1];
                let before_width = before.width();
                let word = line.split_whitespace().next().unwrap_or("");
                let previous_row = self.first + (i - 1) as u16;
                if screen.row_wrapped(previous_row) {
                    // A wrap performed by the *terminal* really is known.
                } else if !before.is_empty()
                    && !word.is_empty()
                    && (before_width >= width || before_width + 1 + word.width() > width)
                {
                    // These apps pre-wrap text before painting. A hard newline
                    // at the same boundary is observationally equivalent.
                    approximate = true;
                    if before_width < width && !line.starts_with(' ') {
                        text.push(' ');
                    }
                } else {
                    text.push('\n');
                }
            }
            text.push_str(line);
        }
        approximate |= match host {
            Host::Codex => text.contains("[Pasted Content ") || text.contains("[Image #"),
            Host::Claude => text.contains("[Pasted text #") || text.contains("[Image #"),
            Host::Generic => false,
        };
        Draft::Visible {
            text,
            approximate,
            rows_below_cursor: self.last - caret_row,
            at_end: caret_row == self.last
                && lines
                    .last()
                    .is_some_and(|last| usize::from(caret_col - self.left) >= last.width()),
        }
    }
}

fn dimensions(screen: &Screen) -> (u16, u16) {
    let (rows, cols) = screen.size();
    (rows.get(), cols.get())
}

fn cell_at(screen: &Screen, row: u16, col: u16) -> &str {
    screen.cell(row, col).map_or("", Cell::contents)
}

fn blank(cell: &str) -> bool {
    cell.is_empty() || cell == " "
}

fn row_blank(screen: &Screen, row: u16, cols: u16) -> bool {
    (0..cols).all(|col| blank(cell_at(screen, row, col)))
}

fn row_text(screen: &Screen, row: u16, left: u16, right: u16) -> String {
    let mut text = String::new();
    for col in left..right {
        if let Some(cell) = screen.cell(row, col)
            && !cell.is_wide_continuation()
        {
            if cell.has_contents() {
                text.push_str(cell.contents());
            } else {
                text.push(' ');
            }
        }
    }
    text.truncate(text.trim_end_matches(' ').len());
    text
}

#[derive(Debug, Default, PartialEq, Eq)]
pub enum Draft {
    #[default]
    Unavailable,
    Visible {
        text: String,
        approximate: bool,
        rows_below_cursor: u16,
        at_end: bool,
    },
}

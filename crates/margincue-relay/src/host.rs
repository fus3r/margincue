//! Reads Codex's prompt box from the shadow screen. Nothing here writes.
//!
//! Codex 0.171–0.172 draws the prompt box as a block of rows on one surface
//! colour (a padding row, the text rows, a padding row) with `›` on its first
//! text row. Popups (`@` files, `/` commands) are drawn right above the block,
//! so a blank row above it means no popup is open.

use std::ffi::OsStr;
use std::path::Path;
use unicode_width::UnicodeWidthStr;
use vt100::{Cell, Color, Screen};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Generic,
    Codex,
}

impl Host {
    pub fn detect(program: &OsStr) -> Self {
        match Path::new(program).file_name().and_then(OsStr::to_str) {
            Some("codex" | "codex.js") => Self::Codex,
            _ => Self::Generic,
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "generic" => Some(Self::Generic),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Generic => "generic",
            Self::Codex => "codex",
        }
    }

    /// The key that opens the host's external editor on the draft.
    pub fn editor_key(self) -> Option<&'static [u8]> {
        match self {
            Self::Generic => None,
            Self::Codex => Some(b"\x07"),
        }
    }

    pub fn read(self, screen: &Screen) -> Draft {
        match self {
            Self::Generic => Draft::Unavailable,
            Self::Codex => codex_box(screen).map_or(Draft::Unavailable, |b| b.read(screen)),
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub enum Draft {
    #[default]
    Unavailable,
    Visible {
        text: String,
        /// Wraps guessed, rows clipped, or a paste or image shown as a placeholder.
        approximate: bool,
        rows_below_cursor: u16,
        at_end: bool,
        /// No popup is open: Enter sends the prompt rather than picking an item.
        plain: bool,
        /// Some of the draft is scrolled out of the box.
        clipped: bool,
    },
}

impl Draft {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Visible { text, .. } => Some(text),
            Self::Unavailable => None,
        }
    }
}

struct Composer {
    /// Row of the `›` marker.
    first: u16,
    /// Last text row (inclusive).
    last: u16,
    left: u16,
    /// Exclusive.
    right: u16,
    clipped: bool,
    /// The row above the box is blank (or the box starts at the top).
    clear_above: bool,
}

fn codex_box(screen: &Screen) -> Option<Composer> {
    let (rows, cols) = dimensions(screen);
    let (caret_row, caret_col) = screen.cursor_position();
    let right = cols.checked_sub(1)?;
    if screen.hide_cursor() || !(2..right).contains(&caret_col) || caret_row >= rows {
        return None;
    }
    // The text rows start at the nearest `›` at or above the caret. A dim
    // arrow is disabled input, not an empty textarea.
    let first = (0..=caret_row).rev().find(|&row| {
        screen
            .cell(row, 0)
            .is_some_and(|cell| matches!(cell.contents(), "›" | "»"))
            && blank(cell_at(screen, row, 1))
    })?;
    if screen.cell(first, 0)?.dim() {
        return None;
    }
    let surface = background(screen, first);
    let (last, clear_above) = if surface != Color::Default {
        // The block: every row on the same surface colour. Its bottom row is
        // padding, so the text ends one row above it.
        let top = (0..first)
            .rev()
            .take_while(|&row| background(screen, row) == surface)
            .last()
            .unwrap_or(first);
        let bottom = (first..rows)
            .take_while(|&row| background(screen, row) == surface)
            .last()
            .unwrap_or(first);
        if top == first || bottom == first {
            // No padding rows: not the block this reader knows.
            return None;
        }
        let last = bottom - 1;
        let clear_above = top == 0 || row_blank(screen, top - 1, cols);
        (last, clear_above)
    } else {
        // Without a surface colour (a terminal that did not report its
        // background), fall back to the footer Codex draws after a spacer.
        let footer = (first + 2..rows).find(|&row| {
            row_blank(screen, row - 1, cols) && codex_footer(&row_text(screen, row, 2, cols))
        });
        let last = match footer {
            Some(footer) => footer - 2,
            None => {
                (caret_row + 1..rows)
                    .find(|&row| row_blank(screen, row, cols))
                    .unwrap_or(rows)
                    - 1
            }
        };
        let clear_above = first == 0 || row_blank(screen, first - 1, cols);
        (last, clear_above && footer.is_some())
    };
    if caret_row > last || last < first {
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
        clear_above,
    })
}

fn codex_footer(text: &str) -> bool {
    text.starts_with("? for shortcuts")
        || text.starts_with("← for agents")
        || text.starts_with("tab to queue message")
        || text.contains(" · ") && (text.starts_with("GPT-") || text.contains(" context"))
}

impl Composer {
    fn read(&self, screen: &Screen) -> Draft {
        let (caret_row, caret_col) = screen.cursor_position();
        let width = usize::from(self.right - self.left);
        let mut lines = Vec::with_capacity(usize::from(self.last - self.first + 1));
        for row in self.first..=self.last {
            lines.push(row_text(screen, row, self.left, self.right));
        }
        // The placeholder changes between releases. Its role shows in dim
        // styling at the empty insertion point.
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
                plain: self.clear_above,
                clipped: false,
            };
        }
        // Commands, shell lines and mentions open Codex's own pickers.
        if matches!(lines[0].as_bytes().first(), Some(b'/' | b'!')) {
            return Draft::Unavailable;
        }
        // At the tail the caret tells about invisible trailing spaces.
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
                    // A wrap the terminal itself performed is certain.
                } else if !before.is_empty()
                    && !word.is_empty()
                    && (before_width >= width || before_width + 1 + word.width() > width)
                {
                    // Codex wraps before painting; a newline at the same
                    // boundary would look the same.
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
        approximate |= text.contains("[Pasted Content ") || text.contains("[Image #");
        let at_end = caret_row == self.last
            && lines
                .last()
                .is_some_and(|last| usize::from(caret_col - self.left) >= last.width());
        // A mention being typed has a popup even if it is drawn elsewhere.
        let token = at_end
            .then(|| text.rsplit(char::is_whitespace).next().unwrap_or(""))
            .unwrap_or("");
        let picking = matches!(token.as_bytes().first(), Some(b'@' | b'$'));
        Draft::Visible {
            text,
            approximate,
            rows_below_cursor: self.last - caret_row,
            at_end,
            plain: self.clear_above && !picking,
            clipped: self.clipped,
        }
    }
}

fn dimensions(screen: &Screen) -> (u16, u16) {
    let (rows, cols) = screen.size();
    (rows.get(), cols.get())
}

fn background(screen: &Screen, row: u16) -> Color {
    screen.cell(row, 0).map_or(Color::Default, Cell::bgcolor)
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

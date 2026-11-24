//! Maps the child's viewport onto the top of the physical terminal. Child
//! bytes go into a shadow screen, while only the physical stream gets band
//! painting and virtual-geometry rewrites.

use std::io::Write;
use std::num::NonZeroU16;

use crate::input::PixelQuery;
use crate::io::Size;
use crate::wire::{Framer, Kind, csi, integer, split_first};

const CLEAR_ATTRIBUTES: &[u8] = b"\x1b[m";

pub fn screen(size: Size, history: usize) -> vt100::Parser {
    vt100::Parser::new(nonzero(size.rows), nonzero(size.cols), history)
}

fn nonzero(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n).expect("nonzero terminal size")
}

pub struct Output {
    framer: Framer,
    canvas: Canvas,
}

impl Output {
    pub fn new(outer: Size, band: u16) -> Self {
        let inner = outer.viewport(band);
        Self {
            framer: Framer::default(),
            canvas: Canvas {
                outer,
                inner,
                band,
                model: screen(inner, 0),
                geometry: [Geometry::new(inner.rows); 2],
                sync: false,
                paste: false,
                focus: false,
                modify_other_keys: false,
                kitty_depth: 0,
                pixel_mouse: false,
                osc: OscLink::default(),
                dirty: true,
                label: String::new(),
                geometry_pending: false,
                pixel_queries: Vec::new(),
            },
        }
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.canvas.model.screen()
    }

    pub fn inner(&self) -> Size {
        self.canvas.inner
    }

    pub fn outer(&self) -> Size {
        self.canvas.outer
    }

    pub fn bracketed_paste(&self) -> bool {
        self.canvas.paste
    }

    pub fn pixel_mouse(&self) -> bool {
        self.canvas.pixel_mouse
    }

    pub fn pixel_queries(&mut self) -> impl Iterator<Item = PixelQuery> + '_ {
        self.canvas.pixel_queries.drain(..)
    }

    pub fn safe_to_inspect(&self) -> bool {
        self.framer.ground() && !self.canvas.sync
    }

    pub fn start(&mut self, row: u16, col: u16, out: &mut Vec<u8>) {
        let canvas = &mut self.canvas;
        if !canvas.reserved() {
            return;
        }
        // Preserve the shell viewport. If its cursor occupied the new band,
        // scroll the outer screen first, just as printing more lines would.
        if row > canvas.inner.rows {
            cup(out, canvas.outer.rows, 1);
            write!(out, "\x1b[{}S", row - canvas.inner.rows).unwrap();
        }
        let mut position = Vec::new();
        cup(&mut position, row.min(canvas.inner.rows), col);
        canvas.model.process(&position);
        canvas.install_region(out);
    }

    pub fn process(&mut self, bytes: &[u8], out: &mut Vec<u8>, replies: &mut Vec<u8>) {
        let canvas = &mut self.canvas;
        self.framer.process(bytes, |kind, raw| {
            if kind == Kind::Control {
                canvas.control(raw, out, replies);
            } else {
                if kind == Kind::Opaque {
                    canvas.osc.feed(raw);
                }
                canvas.model.process(raw);
                out.extend_from_slice(raw);
            }
        });
    }

    pub fn paint(&mut self, label: &str, out: &mut Vec<u8>) {
        if label != self.canvas.label {
            self.canvas.label.clear();
            self.canvas.label.push_str(label);
            self.canvas.dirty = true;
        }
        if self.safe_to_inspect() {
            self.canvas.paint(out);
        }
    }

    pub fn resize(&mut self, outer: Size, out: &mut Vec<u8>) {
        let canvas = &mut self.canvas;
        let old_outer = canvas.outer;
        let old_inner = canvas.inner;
        canvas.outer = outer;
        canvas.inner = outer.viewport(canvas.band);
        let inner = canvas.inner;
        canvas
            .model
            .set_size(nonzero(inner.rows), nonzero(inner.cols));
        for geometry in &mut canvas.geometry {
            geometry.resize(old_inner.rows, inner.rows);
        }
        if self.framer.ground() {
            if old_inner.rows != old_outer.rows && inner.rows > old_inner.rows {
                // Rows returning to the child must not carry the old band.
                canvas.with_absolute_cursor(out, |out| {
                    out.extend_from_slice(CLEAR_ATTRIBUTES);
                    for row in old_inner.rows + 1..=old_outer.rows.min(inner.rows) {
                        cup(out, row, 1);
                        out.extend_from_slice(b"\x1b[2K");
                    }
                });
                out.extend_from_slice(canvas.model.screen().attributes_formatted().as_bytes());
            }
            if canvas.reserved() || old_inner.rows != old_outer.rows {
                canvas.install_region(out);
            }
        } else {
            // Never insert bytes into a split escape string. Apply the new
            // physical margins at the first safe output boundary.
            canvas.geometry_pending = true;
        }
        canvas.dirty = true;
    }

    pub fn finish(&mut self, out: &mut Vec<u8>) {
        let complete = self.framer.ground();
        self.framer.finish(out);
        if !complete {
            out.push(0x18); // cancel a truncated control before shell cleanup
        }
        let canvas = &mut self.canvas;
        if canvas.sync {
            out.extend_from_slice(b"\x1b[?2026l");
        }
        if canvas.model.screen().alternate_screen() {
            out.extend_from_slice(b"\x1b[?1049l");
            canvas.model.process(b"\x1b[?1049l");
        }
        if canvas.paste {
            out.extend_from_slice(b"\x1b[?2004l");
        }
        if canvas.focus {
            out.extend_from_slice(b"\x1b[?1004l");
        }
        if canvas.modify_other_keys {
            out.extend_from_slice(b"\x1b[>4;0m");
        }
        if canvas.kitty_depth > 0 {
            write!(out, "\x1b[<{}u", canvas.kitty_depth).unwrap();
        }
        if canvas.model.screen().mouse_protocol_mode() != vt100::MouseProtocolMode::None {
            out.extend_from_slice(b"\x1b[?1000;1002;1003;1006;1015;1016l");
        }
        if canvas.reserved() {
            canvas.label.clear();
            canvas.osc = OscLink::default();
            canvas.dirty = true;
            canvas.paint(out);
            canvas.with_absolute_cursor(out, |out| out.extend_from_slice(b"\x1b[r"));
        }
        if canvas.model.screen().hide_cursor() {
            out.extend_from_slice(b"\x1b[?25h");
        }
    }

    pub fn settle_geometry(&mut self, out: &mut Vec<u8>) {
        if self.framer.ground() && self.canvas.geometry_pending {
            self.canvas.install_region(out);
            self.canvas.geometry_pending = false;
        }
    }
}

#[derive(Clone, Copy)]
struct Geometry {
    top: u16,
    bottom: u16,
    origin: bool,
    saved_origin: bool,
}

impl Geometry {
    fn new(rows: u16) -> Self {
        Self {
            top: 1,
            bottom: rows,
            origin: false,
            saved_origin: false,
        }
    }

    fn resize(&mut self, old_rows: u16, rows: u16) {
        if self.bottom == old_rows {
            self.bottom = rows;
        }
        self.bottom = self.bottom.min(rows);
        if self.bottom <= self.top {
            self.top = 1;
            self.bottom = rows;
        }
    }
}

struct Canvas {
    outer: Size,
    inner: Size,
    band: u16,
    model: vt100::Parser,
    geometry: [Geometry; 2],
    sync: bool,
    paste: bool,
    focus: bool,
    modify_other_keys: bool,
    kitty_depth: u16,
    pixel_mouse: bool,
    osc: OscLink,
    dirty: bool,
    label: String,
    geometry_pending: bool,
    pixel_queries: Vec<PixelQuery>,
}

impl Canvas {
    fn reserved(&self) -> bool {
        self.inner.rows != self.outer.rows
    }

    fn screen_index(&self) -> usize {
        usize::from(self.model.screen().alternate_screen())
    }

    fn active(&self) -> Geometry {
        self.geometry[self.screen_index()]
    }

    fn install_region(&self, out: &mut Vec<u8>) {
        let current = self.active();
        if self.reserved() || current.top != 1 || current.bottom != self.outer.rows {
            region(out, current.top, current.bottom);
        } else {
            out.extend_from_slice(b"\x1b[r");
        }
        self.restore_cursor(out);
    }

    fn restore_cursor(&self, out: &mut Vec<u8>) {
        let (row, col) = self.model.screen().cursor_position();
        let row = if self.active().origin {
            (row + 1)
                .saturating_sub(self.active().top)
                .saturating_add(1)
        } else {
            row + 1
        };
        cup(out, row, col.saturating_add(1).min(self.inner.cols));
    }

    fn with_absolute_cursor(&self, out: &mut Vec<u8>, f: impl FnOnce(&mut Vec<u8>)) {
        if self.active().origin {
            out.extend_from_slice(b"\x1b[?6l");
        }
        f(out);
        if self.active().origin {
            out.extend_from_slice(b"\x1b[?6h");
        }
        self.restore_cursor(out);
    }

    fn control(&mut self, raw: &[u8], out: &mut Vec<u8>, replies: &mut Vec<u8>) {
        let index = self.screen_index();
        let mut changed_buffer = false;
        match raw {
            b"\x1b7" => self.geometry[index].saved_origin = self.geometry[index].origin,
            b"\x1b8" => self.geometry[index].origin = self.geometry[index].saved_origin,
            b"\x1bc" | b"\x1b[!p" => {
                if raw == b"\x1bc" {
                    self.geometry = [Geometry::new(self.inner.rows); 2];
                    self.sync = false;
                    self.paste = false;
                    self.focus = false;
                    self.modify_other_keys = false;
                    self.kitty_depth = 0;
                    self.pixel_mouse = false;
                    self.osc = OscLink::default();
                } else {
                    let active = &mut self.geometry[index];
                    *active = Geometry::new(self.inner.rows);
                    // vt100 does not model DECSTR; mirror the geometry it resets.
                    self.model.process(b"\x1b[?6l\x1b[r");
                }
                changed_buffer = true;
            }
            _ => {}
        }
        if let Some((params, opcode)) = csi(raw) {
            if opcode == b'm'
                && let Some(level) = params.strip_prefix(b">4;").and_then(integer)
            {
                self.modify_other_keys = level > 0;
            }
            if opcode == b'u' {
                if params.starts_with(b">") {
                    self.kitty_depth = self.kitty_depth.saturating_add(1);
                } else if let Some(count) = params.strip_prefix(b"<").and_then(integer) {
                    self.kitty_depth = self.kitty_depth.saturating_sub(count.max(1));
                }
            }
            if let Some(params) = params.strip_prefix(b"?")
                && matches!(opcode, b'h' | b'l')
            {
                let set = opcode == b'h';
                for mode in params.split(|&b| b == b';').filter_map(integer) {
                    match mode {
                        6 => self.geometry[index].origin = set,
                        47 | 1047 | 1049 => {
                            if set && mode == 1049 {
                                self.geometry[0].saved_origin = self.geometry[0].origin;
                                self.geometry[1] = Geometry::new(self.inner.rows);
                            } else if !set && mode == 1049 {
                                self.geometry[0].origin = self.geometry[0].saved_origin;
                            }
                            changed_buffer = true;
                        }
                        1048 if set => {
                            self.geometry[index].saved_origin = self.geometry[index].origin;
                        }
                        1048 => self.geometry[index].origin = self.geometry[index].saved_origin,
                        1004 => self.focus = set,
                        1016 => self.pixel_mouse = set,
                        2004 => self.paste = set,
                        2026 => {
                            if !set && self.sync {
                                // An invalidated band can join the child's frame
                                // instead of briefly appearing after it.
                                self.paint(out);
                            }
                            self.sync = set;
                        }
                        _ => {}
                    }
                }
            }
            if self.reserved() && self.clipped_csi(params, opcode, raw, out, replies) {
                return;
            }
        }
        // vt100 implements the common 47 and 1049 forms. These aliases
        // preserve the raw wire but give the shadow screen equivalent state.
        match raw {
            b"\x1b[?1047h" => self.model.process(b"\x1b[?47h"),
            b"\x1b[?1047l" => self.model.process(b"\x1b[2J\x1b[?47l"),
            b"\x1b[?1048h" => self.model.process(b"\x1b7"),
            b"\x1b[?1048l" => self.model.process(b"\x1b8"),
            _ => self.model.process(raw),
        }
        out.extend_from_slice(raw);
        if changed_buffer && self.reserved() {
            self.install_region(out);
            self.dirty = true;
        }
    }

    fn clipped_csi(
        &mut self,
        params: &[u8],
        opcode: u8,
        raw: &[u8],
        out: &mut Vec<u8>,
        replies: &mut Vec<u8>,
    ) -> bool {
        let index = self.screen_index();
        match opcode {
            b'r' => {
                let Some((top, bottom)) = pairs(params) else {
                    return false;
                };
                let bottom = if bottom == 0 {
                    self.inner.rows
                } else {
                    bottom.min(self.inner.rows)
                };
                let top = top.max(1);
                if top < bottom {
                    self.geometry[index].top = top;
                    self.geometry[index].bottom = bottom;
                    let offset = out.len();
                    region(out, top, bottom);
                    self.model.process(&out[offset..]);
                }
                // Invalid DECSTBM does not change margins or move the cursor.
            }
            b'J' => {
                let (selective, params) = params
                    .strip_prefix(b"?")
                    .map_or((false, params), |p| (true, p));
                let Some(mode @ (0 | 2)) = integer(params) else {
                    return false;
                };
                let (row, col) = self.model.screen().cursor_position();
                self.with_absolute_cursor(out, |out| {
                    let erase = if selective {
                        b"\x1b[?2K".as_slice()
                    } else {
                        b"\x1b[2K"
                    };
                    let first = if mode == 0 {
                        cup(out, row + 1, (col + 1).min(self.inner.cols));
                        out.extend_from_slice(if selective { b"\x1b[?K" } else { b"\x1b[K" });
                        row + 2
                    } else {
                        1
                    };
                    for line in first..=self.inner.rows {
                        cup(out, line, 1);
                        out.extend_from_slice(erase);
                    }
                });
                self.model.process(raw);
            }
            b'H' | b'f' | b'd' => {
                let Some((row, col)) = pairs(params) else {
                    return false;
                };
                let current = self.active();
                let limit = if current.origin {
                    current.bottom - current.top + 1
                } else {
                    self.inner.rows
                };
                if row <= limit {
                    return false;
                }
                let start = out.len();
                if opcode == b'd' {
                    write!(out, "\x1b[{limit}d").unwrap();
                } else {
                    cup(out, limit, col.max(1));
                }
                self.model.process(&out[start..]);
            }
            b'B' | b'e' | b'E' => {
                let Some(amount) = integer(params) else {
                    return false;
                };
                let (row, col) = self.model.screen().cursor_position();
                let geom = self.active();
                // The outer terminal already clips moves inside DECSTBM.
                if (geom.top..=geom.bottom).contains(&(row + 1))
                    || row.saturating_add(amount.max(1)) < self.inner.rows
                {
                    return false;
                }
                self.model.process(raw);
                cup(
                    out,
                    self.inner.rows,
                    if opcode == b'E' {
                        1
                    } else {
                        col.saturating_add(1).min(self.inner.cols)
                    },
                );
            }
            b't' if params == b"18" => {
                write!(replies, "\x1b[8;{};{}t", self.inner.rows, self.inner.cols).unwrap();
            }
            b't' if params == b"14" && self.inner.ypixel != 0 && self.inner.xpixel != 0 => {
                write!(
                    replies,
                    "\x1b[4;{};{}t",
                    self.inner.ypixel, self.inner.xpixel
                )
                .unwrap();
            }
            b't' if matches!(params, b"14" | b"14;2") => {
                self.pixel_queries.push(if params == b"14" {
                    PixelQuery::TextArea
                } else {
                    PixelQuery::WholeWindow
                });
                return false;
            }
            _ => return false,
        }
        true
    }

    fn paint(&mut self, out: &mut Vec<u8>) {
        let (_, col) = self.model.screen().cursor_position();
        if !self.dirty || !self.reserved() || col >= self.inner.cols || self.osc.open {
            return;
        }
        self.with_absolute_cursor(out, |out| {
            out.extend_from_slice(CLEAR_ATTRIBUTES);
            for row in self.inner.rows + 1..=self.outer.rows {
                cup(out, row, 1);
                out.extend_from_slice(b"\x1b[2K");
                if row == self.inner.rows + 1 {
                    out.extend_from_slice(self.label.as_bytes());
                }
            }
        });
        out.extend_from_slice(self.model.screen().attributes_formatted().as_bytes());
        self.dirty = false;
    }
}

fn pairs(params: &[u8]) -> Option<(u16, u16)> {
    match split_first(params, b';') {
        Some((first, second)) => Some((integer(first)?, integer(second)?)),
        None => Some((integer(params)?, 0)),
    }
}

fn region(out: &mut Vec<u8>, top: u16, bottom: u16) {
    write!(out, "\x1b[{top};{bottom}r").unwrap();
}

fn cup(out: &mut Vec<u8>, row: u16, col: u16) {
    write!(out, "\x1b[{row};{col}H").unwrap();
}

// Avoid drawing a band that would inherit a child's active hyperlink. Only
// the OSC command, second separator and presence of a payload are needed.
#[derive(Default)]
struct OscLink {
    stage: LinkStage,
    open: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum LinkStage {
    #[default]
    Ignore,
    Code,
    Separator,
    Parameters,
    Uri,
    Nonempty,
}

impl OscLink {
    fn feed(&mut self, bytes: &[u8]) {
        if bytes == b"\x1b]" {
            self.stage = LinkStage::Code;
        } else if matches!(bytes, b"\x07" | b"\x1b\\") {
            match self.stage {
                LinkStage::Uri => self.open = false,
                LinkStage::Nonempty => self.open = true,
                _ => {}
            }
            self.stage = LinkStage::Ignore;
        } else {
            for &byte in bytes {
                self.stage = match (self.stage, byte) {
                    (_, 0x18 | 0x1a) => LinkStage::Ignore,
                    (LinkStage::Code, b'8') => LinkStage::Separator,
                    (LinkStage::Separator, b';') => LinkStage::Parameters,
                    (LinkStage::Parameters, b';') => LinkStage::Uri,
                    (LinkStage::Parameters, _) => LinkStage::Parameters,
                    (LinkStage::Uri | LinkStage::Nonempty, _) => LinkStage::Nonempty,
                    _ => LinkStage::Ignore,
                };
                if self.stage == LinkStage::Ignore {
                    break;
                }
            }
        }
    }
}

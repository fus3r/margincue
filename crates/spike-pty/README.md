# MarginCue PTY spike

The product version is `crates/margincue-relay`: the Codex card under the prompt. This spike stays for its measurements and tests.

**The PTY wrapper belongs in an opt-in compatibility mode.** The relay is fast enough for ordinary typing. The terminal stream loses information about the draft, and a reserved scroll region changes scrollback on terminals that treat it as a status bar. These are limits of the interface between the CLI and the terminal.

## Run

```sh
cd crates/spike-pty
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
export CARGO_HOME="$PWD/target/cargo-home"
cargo build --release --locked
target/release/spike-pty -- codex
target/release/spike-pty --host claude -- env -u CLAUDECODE claude
target/release/spike-pty --band 3 -- zsh
```

The default band is two rows. It shows the Unicode character count and a width-limited draft preview. An `approx` label marks an inferred wrap, a visible clipping indicator, or a placeholder. Use the generic host to run arbitrary commands with a reserved band.

| Chord | Demo action |
| --- | --- |
| Ctrl+] then 1, 2, or 3 | Append the corresponding demo decision through Ctrl+G |
| Ctrl+] then p | Move to the observed draft end and try a bracketed paste |
| Ctrl+] then n | Cycle the demo choice |
| Ctrl+] then d | Dismiss the preview until the draft changes |
| Ctrl+] then t | Toggle the preview |
| Ctrl+] twice | Forward one Ctrl+] to the child |

An unused leader falls through after 750 ms. The wrapper recognizes legacy control bytes, kitty CSI-u, and the xterm modifyOtherKeys form. A normal Ctrl+G delegates to the original session editor. `--metrics FILE` records timings and editor temp paths when the process exits.

## Terminal relay

The child receives a controlling PTY with the real width and a reduced height. The outer terminal paints the child's byte stream directly. A parallel virtual screen reads the child stream before the wrapper adds its band. The relay uses nonblocking file descriptors and bounded queues so backpressure on the terminal display can yield to input.

| Operation | Handling |
| --- | --- |
| DECSTBM set and reset | Clamp the physical bottom margin to the viewport. Keep narrower child margins when valid. |
| ED from cursor or full display | Emit line erases through the viewport bottom. ED above the cursor and explicit history clearing pass through. |
| Cursor movement | Clamp common vertical addressing to the viewport. Band painting restores cursor coordinates and modeled SGR without using the application's saved-cursor slot. |
| Alternate buffers, RIS, DECSTR | Reinstall physical margins and restore the band. |
| Win size and queries | Send the reduced winsize through the inner PTY. Answer the text-area cell query locally. Answer or crop the text-area pixel report. Forward normal cursor reports and whole-window, display, and cell size reports. |
| Resize | Recompute sizes, clear rows returned to the app, and let the child redraw after SIGWINCH. Release the band when fewer than two child rows would fit. |
| Keyboard, paste, mouse, and focus | Pass mode controls and regular input. Interpret the wrapper leader outside pasted content. Filter SGR mouse hits in the band and clamp an in-progress drag crossing into it. |
| Synchronized updates | Track the child's mode and defer preview recomputation until the frame ends. An invalidated band can be repainted before the child's end marker. |

The nested test kept the band while scrolling 48 synthetic lines and recorded 33 history rows in the outer model. Two real Codex inline `/status` commands added 36 outer-model history rows. Kitty's source admits main-buffer history when the top margin is zero. iTerm2 has separate profile settings governing history with a status bar and history in the alternate buffer. The band occupies ordinary terminal cells and participates in terminal selection. The headless harness checks application mouse coordinates and final cells. Native GUI selection, resize reflow, flicker perception, and OS key mappings need GUI testing. [xterm controls](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) · [kitty scroll implementation](https://github.com/kovidgoyal/kitty/blob/master/kitty/screen.c) · [iTerm2 terminal profiles](https://iterm2.com/documentation-preferences-profiles-terminal.html)

Open issues for arbitrary children include 8-bit control framing, graphics and rectangular operations, emulator-specific attribute and wrap behavior, and shell job control. A missing startup cursor report causes the spike to start at the top-left. The shadow model truncates or extends lines on width changes, so a full repaint by the child matters when a real terminal reflows text.

## Composer and write-back

- **Codex 0.171.0.** The spec finds the composer arrow, text inset, caret, and known footer rows. It uses dim styling for the empty placeholder. The real test generated two different drafts, a soft-wrapped line and an explicit newline at the same point. Both produced equal terminal cells, the same caret column, and no VT wrap bit. The test also verified a 1,080-character paste rendered only as `[Pasted Content 1080 chars]` and Ctrl+G exposed the original text. [Composer renderer](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/bottom_pane/chat_composer.rs) · [Composer layout](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/bottom_pane/chat_composer/composer_layout.rs) · [Codex wrap implementation](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/bottom_pane/textarea/wrapping.rs)
- **Claude Code 2.1.330.** The spec finds the ruled prompt box and caret position, even with the physical cursor hidden. A probe with an unbroken word measured a text width of terminal width minus four cells at 70–140 columns. The real test verifies a soft-wrap guess on resize and exact extraction of modifier-Enter newlines. Claude replaces the multiline bracketed-paste demo with a `[Pasted text #…]` token. A separate manual Ctrl+G readback verified the pasted bytes were appended to the underlying prompt.
- **Common limitations.** Offscreen text, collapsed paste payloads, and text displaced by attachments are absent from the terminal stream. A normal terminal autowrap has a wrap bit. App-rendered wraps usually lack that bit, so the spec guesses from the available columns and next word and flags ambiguity. Trailing whitespace can be indistinguishable from cell padding. Themes, footers, split layouts, and composer changes can invalidate the spec. The tests cover the trust dialog, model picker, and slash suggestions where the band should omit a draft.

**Ctrl+G is the more robust write path.** On Codex the helper received `$CODEX_HOME/editor/.tmp*.md`. Claude passed a `claude-prompt-*.md` file inside `$TMPDIR/claude-<uid>/` with both temp-root variables pointed at the same directory. Both apps redrew the composer and put the caret at the end. Codex sent alternate-buffer leave and enter controls during handoff. Claude re-entered and redrew its alternate buffer without a sampled main-buffer frame. Codex's source also resets the composer undo history when importing an edit. [Codex external-editor implementation](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/external_editor.rs) · [Codex composer import](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/bottom_pane/chat_composer.rs)

An early, blind arrow/End/paste attempt put the decision between existing lines. The demo now waits for the rendered caret at the end of the unchanged draft before sending the paste. The two hosts accepted it in the tested stock modes. The editor supplies its own full seed even when the wrapper can only see a shortened preview. Paste depends on the current keymap, selection, caret, and the app's paste policy.

Four consecutive release-mode runs measured the time from the leader continuation to the visible composite result. The editor helper spent 0.17–0.23 ms inside its entry point through the append. Process startup, the CLI handoff, and repaint are included in the end-to-end numbers.

| Host | Editor to visible text | Paste to visible result |
| --- | ---: | ---: |
| Codex | 20.4–21.5 ms | 20.1–20.9 ms to visible text |
| Claude Code | 22.5–23.3 ms | 7.4–7.6 ms to a collapsed token |

**Use a remappable leader in a product.** Ctrl+] followed by a plain continuation worked with the tested bindings. Direct Alt+digit can be ESC-prefixed, CSI-u, or printable text when macOS Option is used for character composition. The input test forwards these distinct forms unchanged. [Apple keyboard profiles](https://support.apple.com/en-mt/guide/terminal/trmlkbrd/mac) · [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)

## Dependencies

`vt100` 0.18.1 supplies a compact screen with styles, cursor, width continuations, soft-wrap bits, and history. It uses `vte` to interpret the byte stream. The small wire framer relays unmodified controls byte-for-byte, including split strings. Using `vte` alone would require implementing the grid. `alacritty_terminal` and `termwiz` offer more terminal machinery and receive the same already-rendered draft. The Unix relay uses `libc` so it can own the controlling terminal, raw-mode lifetime, winsize, and nonblocking poll loop explicitly. [vt100 crate](https://docs.rs/crate/vt100/0.18.1) · [vte parser](https://github.com/alacritty/vte) · [Alacritty terminal engine](https://github.com/alacritty/alacritty/tree/master/alacritty_terminal) · [Termwiz](https://github.com/wezterm/wezterm/tree/main/termwiz)

## Reproduce

```sh
cargo test --release --locked
cargo test --release --locked --test live -- --ignored --nocapture --test-threads=1
cargo test --release --locked --test relay relay_cost -- --ignored --nocapture
```

The harness runs the installed TUIs in fresh homes under `target/`. It uses inert credentials and loopback API endpoints, starts Codex with `--no-daemon`, and starts Claude via `env -u CLAUDECODE`. It enters only the local trust choice and built-in Codex commands. The real tests assert on the composite grid, exact short drafts, both write paths, resize, the Codex mouse caret, modal suppression, and the information-loss cases. The synthetic tests cover resets, dimensions and query replies, the band, scroll history, split controls and UTF-8, saved cursor, and protocol bytes. Flexibility across other CLI versions and terminal frontends remains untested.

**Cost on the M4 Pro.** In three release-mode runs with a 30×100 outer PTY, the 54-byte echo round trip grew by 9.8–11.4 µs at p50. A 4 KiB echo grew by 39.6–42.5 µs at p50. The wrapper's own read-to-write stage took 0.8–1.0 µs for input. Its output stage took 2.0–2.4 µs for chunks up to 64 bytes and 12.4–12.6 µs for chunks of 65–1,024 bytes at p50. The larger writes arrived as several macOS PTY reads. A lone legacy Escape took 4.56–4.61 ms at p50 due to the framing timer. The synthetic idle probe measured zero CPU time charged over 5 seconds, with about 2 MiB RSS. The real-host probes recorded a few microseconds of wrapper CPU over 2 seconds and about 2.3–2.5 MiB RSS. These measurements exclude GUI presentation and model work.

## Product direction

Keep the Claude native mod for the in-composer experience. For Codex, put the draft and decorations in the host itself. An upstream hook or a narrow change to the open-source TUI would retain the stock experience. A first-party MarginCue TUI could own the composer and use Codex App Server for threads, turns, streamed items, and approvals. The stock TUI keeps its unsent draft local to its composer. Keep the PTY path version-scoped and opt-in, and keep the explicit editor workflow for other hosts. [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)

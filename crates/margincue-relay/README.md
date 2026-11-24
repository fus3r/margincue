# margincue-relay

Runs Codex a few rows short of the terminal, so MarginCue's card can sit under Codex's prompt box and follow the draft as it is typed. `margincue codex` (mods/codex) starts it and serves the card over a pipe; on its own it runs any command with a one-row band.

```sh
cargo build --release --locked
cargo test --release --locked                                       # unit and terminal tests
cargo test --release --locked --test live -- --ignored --test-threads=1   # against the installed Codex
```

## What it does

- **Terminal.** The child gets a pseudo-terminal with the real width and a reduced height. Its bytes reach the terminal unchanged apart from scroll margins, erases and cursor moves clamped to its rows. A shadow screen (`vt100`) mirrors what the child drew. The band is painted at frame boundaries with the cursor and styling restored. This part comes from `crates/spike-pty`; its README has the measurements and the terminal-protocol details.
- **The prompt box** (`src/host.rs`). Codex 0.171–0.172 draws it as rows on one surface colour with `›` on its first text row. Popups are drawn right above it, so a blank row above means Enter sends the prompt. Wraps Codex performs itself are guessed and flagged.
- **The pipe** (`src/protocol.rs`, fd given by `--fd`). One JSON object per line. The relay sends `hello`, `size`, `draft`, `key`, `click`, `enter`, `wrote`, `toggle` and `dismiss`. MarginCue sends `band` (rows with SGR styling only, sanitized), `claims`, an answer to `enter`, and `write`. If the pipe closes, Codex carries on as if started without MarginCue.
- **Keys** (`src/input.rs`). Bytes go to Codex unless MarginCue has claimed the key just then: Enter while Decisions would go with the prompt, alt+↑/↓ while the card has rows. Presses on the card's rows are also MarginCue's. `ctrl+]` then `t` turns MarginCue off for the session; `ctrl+]` then `d` hides the card until the prompt changes.
- **Writes** (`src/editor.rs`). An addition at the end of a fully visible draft is a bracketed paste. Anything else goes through Codex's ctrl+g handoff: the relay is `$VISUAL`, applies one armed request and exits. A ctrl+g the person presses finds none and opens their editor (MarginCue's full card). Typed keys wait until the write shows in the box.

Unix only; Windows keeps ctrl+g until a ConPTY port.

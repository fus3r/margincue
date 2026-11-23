# MarginCue

Shows clarifying questions in Claude Code and Codex CLI when a prompt starts a new task.

## Claude Code

Download [margincue-claude-code.zip](https://github.com/fus3r/margincue/releases/download/v0.2.0/margincue-claude-code.zip) and start Claude Code from your project.

```sh
claude --plugin-dir "$HOME/Downloads/margincue-claude-code.zip"
```

Questions can appear while you type. Open **Answer**, pick an option, and press Esc to return to the draft. Enter sends your answers with the prompt.

Draft review uses Haiku through your Claude session. Run `/margincue sheet off` to disable automatic questions. [Claude Code guide](mods/claude-code/README.md)

## Codex CLI

On Apple silicon, download [margincue-codex-macos-arm64.tar.gz](https://github.com/fus3r/margincue/releases/download/v0.2.0/margincue-codex-macos-arm64.tar.gz). Extract it and run this from the extracted directory.

```sh
./mods/codex/margincue install
```

Start a new Codex session and review and trust the two MarginCue hooks. Questions appear after you send the prompt. [Codex settings and source build](mods/codex/README.md)

## Tests

```sh
node --test spec/*.unit.ts
node spec/run-traces.ts
claude plugin test mods/claude-code
cargo test --locked --manifest-path crates/margincue-codex/Cargo.toml
```

The Claude Code mod carries the [MIT license](mods/claude-code/LICENSE). The Codex download includes its dependency license notices.

Inspired by [Bruce Liu's Feedforward](https://x.com/liu_xingyu/status/2121015724374397183).

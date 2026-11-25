# Contributing to MarginCue

MarginCue is open source under the MIT license, and contributions are welcome: bug reports, choices it should or should never ask about, expert profiles for your field, and code.

## Before you start

- **Bugs and ideas:** open an issue with one of the templates. For a bug, say where MarginCue ran (Claude Code in a terminal or the desktop app, Codex CLI, or Codex in the ChatGPT app) and what the card showed.
- **A first contribution:** issues labelled `good first issue` are a good start. Adding an expert profile for a field you know needs no code.
- **Bigger changes:** open an issue first, so the approach is agreed before you write code.

## Where things are

| Folder | What it holds |
| --- | --- |
| `mods/claude-code/core/` | The reading of a draft, the card's state, and the decisions sent with a prompt. Shared with Codex. |
| `mods/claude-code/hooks/` | The Claude Code plugin: the card in the terminal and in the desktop app. |
| `mods/codex/src/` | Codex: the hooks, the composer, and the card for the ChatGPT app with its MCP server. |
| `crates/margincue-relay/` | The Rust relay that draws the card under Codex's prompt. |
| `prompts/` | The prompts for the reading, the sketch and the agent's marked choices. |
| `profiles/` | Chapter notes, source references, and recurring decision catalogs for each field. |
| `spec/` | Unit tests and traces of the core's behaviour. |

## Build and test

```sh
npm --prefix mods/codex run build      # the Codex bundle in mods/codex/dist
node --test spec/*.unit.ts             # unit tests
node spec/run-traces.ts                # traces of the core's behaviour
claude plugin test mods/claude-code    # the Claude Code plugin's tests
cargo test --release --manifest-path crates/margincue-relay/Cargo.toml
```

After editing a prompt or profile chapter, run `node mods/claude-code/scripts/sync-assets.ts` to regenerate the plugin's assets. See the [profile format](spec/profile-bundle.md) for chapter authoring and catalog compilation. Commit `mods/codex/dist/` with any change to its bundled sources. CI checks that the bundle matches those sources.

## Pull requests

- One change per pull request, with a test when it changes behaviour.
- Say what a person sees before and after; a screenshot of the card helps.
- Keep changes to a prompt's wording in their own pull request: they change every reading.

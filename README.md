# MarginCue

[![test](https://github.com/fus3r/margincue/actions/workflows/test.yml/badge.svg)](https://github.com/fus3r/margincue/actions/workflows/test.yml)

See how Claude Code or Codex will read your prompt before it starts, and steer the choices it makes while it works.

<p align="center">
  <img src="docs/demo.gif" width="720" alt="MarginCue in Claude Code: as the prompt is typed, the card checks names against the repo, offers the open choices and sketches the result">
</p>

## What it does

While you type:

- **The reading.** One line above the prompt says what the agent will deliver and how it takes your request, including whether the cases you list are the whole job or just examples.
- **Your names, checked against your code.** Names in the prompt are looked up in the project as you type. A name the code doesn't have ("Audit Log", when the code says `activityLogs`) is flagged before you send, with the closest names it does have, one key each.
- **The open choices, each with a control.** Chips, sliders and pick-any rows for what the prompt leaves open. The plan you saw goes with the prompt, in a visible Decisions block: every choice, the ones you switched and the ones you kept, so the agent builds what the card showed.
- **A sketch of the result.** For something new: a wireframe, a sample of the report, a results table. Change a choice and it redraws.

While Claude works:

- **Its choices become switches.** Claude marks the choices it makes for you as it goes. Switch one and the change reaches it at its next step, without stopping it.
- **A receipt.** After the turn, what you set and what Claude chose. Switch one and the follow-up prompt is written for you.

It adapts to you and to the project. The first run asks what you work on and your level in each field. A data challenge or a research repository brings in the matching expert decisions (statistics and machine learning, system design), at the depth you asked for.

## Install

**Claude Code** 2.1.275 or later, at the prompt:

```
/plugin install margincue --marketplace fus3r/margincue
```

Answer `y` to add the marketplace, then choose a scope. In the desktop app: + next to the prompt box, Plugins, Add marketplace `fus3r/margincue`, then Add plugin.

**Codex CLI** 0.171 or later, with Node 20 or later:

```sh
npx -y github:fus3r/margincue setup
```

Accept the `codex` alias during setup. Open a **new terminal** (including a new terminal tab in VS Code) and run `codex`: the card sits under Codex's prompt and follows what you type. On Windows, press **Ctrl+G** at the Codex prompt to open it. [Codex guide and direct launch command](mods/codex/README.md#install)

**Codex in the ChatGPT desktop app** shows the card at Enter on new tasks. [Install and test the desktop card](mods/codex/README.md#codex-in-the-chatgpt-desktop-app)

## Keys

| Key | What it does |
| --- | --- |
| `alt+↑` / `alt+↓` (or `ctrl+↑` / `ctrl+↓`) | Next row / change its value, without leaving the prompt |
| `ctrl+x tab`, then `1`–`9`, `x`, `s`, `p` | Pick an option, drop a row, open the sketch, attach it to the prompt |
| A number in the empty prompt during a turn | Switch Claude's focused choice right away |
| `ctrl+]` then `t` (Codex) | MarginCue off or on for this session |

Everything on the card also takes clicks.

## What it costs and what leaves your machine

In Claude Code, each reading and each sketch is one small Haiku call through your own session, so it counts toward your plan. In Codex, each reading or sketch is a short thread through your own Codex login, on the lightest model your account offers, never saved to your history. A reading runs when you finish a sentence or pause in the composers, or on Enter in the Codex desktop app. `/margincue mode quiet` keeps the card to one line while you type, `/margincue sketch off` drops sketches, and `/margincue mode off` stops everything. In Codex desktop, quiet mode skips the card at Enter.

Your draft goes to Claude the same way your prompt does. The project index (file names and declared names, read with git or ripgrep) stays on your machine, and so do your first-run answers and learned picks. There is no telemetry; `/margincue log <path>` writes a local log of counts and timings, never your text.

## Where it runs

| | Card before work | Choices as switches | Receipt |
| --- | --- | --- | --- |
| Claude Code: terminal (macOS, Linux, Windows) | above the prompt | on the card, during the turn | under the answer |
| Claude Code: desktop app (Code tab), VS Code | at Enter (these apps show plugins no draft): each choice Claude would make as a dropdown, above Claude's send question, whose "Other" adds to your prompt | above the prompt, during the turn | under the answer |
| Codex CLI | under the prompt as you type (macOS, Linux; on Windows, on ctrl+g) | under the prompt; the change goes in the prompt box and Enter sends it into the turn | after the turn |
| Codex in the ChatGPT desktop app | at Enter on new tasks, as an interactive card before Codex starts | marked in the reply | after the turn |
| Codex IDE extension | at the top of the agent's reply | marked in the reply | after the turn |

## Commands

`/margincue status` shows what MarginCue knows about you and the project. `/margincue setup` asks the first-run questions again. `/margincue card|sketch|refs|blanks on|off` switches each part. The [Claude Code guide](mods/claude-code/README.md) has the rest.

## Development

```sh
node --test spec/*.unit.ts
node spec/run-traces.ts
claude plugin test mods/claude-code
cargo test --release --manifest-path crates/margincue-relay/Cargo.toml
```

The Claude Code mod carries the [MIT license](mods/claude-code/LICENSE).

Inspired by [Bruce Liu's Feedforward](https://x.com/liu_xingyu/status/2121015724374397183).

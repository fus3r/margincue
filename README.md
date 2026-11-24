# MarginCue

[![test](https://github.com/fus3r/margincue/actions/workflows/test.yml/badge.svg)](https://github.com/fus3r/margincue/actions/workflows/test.yml)

See how Claude Code will read your prompt before you press Enter, and steer the choices it makes while it works.

<!-- Demo video goes here. -->

## What it does

While you type:

- **The reading.** One line above the prompt says what the agent will deliver and how it takes your request, including whether the cases you list are the whole job or just examples.
- **Your names, checked against your code.** Names in the prompt are looked up in the project as you type. A name the code doesn't have ("Audit Log", when the code says `activityLogs`) is flagged before you send, with the closest names it does have, one key each.
- **The open choices, each with a control.** Chips, sliders and pick-any rows for what the prompt leaves open. Only the choices you set go with the prompt, in a visible Decisions block.
- **A sketch of the result.** For something new: a wireframe, a sample of the report, a results table. Change a choice and it redraws.

While Claude works:

- **Its choices become switches.** Claude marks the choices it makes for you as it goes. Switch one and the change reaches it at its next step, without stopping it.
- **A receipt.** After the turn, what you set and what Claude chose. Switch one and the follow-up prompt is written for you.

It adapts to you and to the project. The first run asks what you work on and your level in each field. A data challenge or a research repository brings in the matching expert decisions (statistics and machine learning, system design), at the depth you asked for.

## Install

In Claude Code 2.1.275 or later, at the prompt:

```
/plugin install margincue --marketplace fus3r/margincue
```

Answer `y` to add the marketplace, then choose a scope. In the desktop app: + next to the prompt box, Plugins, Add marketplace `fus3r/margincue`, then Add plugin.

## Keys

| Key | What it does |
| --- | --- |
| `alt+↑` / `alt+↓` (or `ctrl+↑` / `ctrl+↓`) | Next row / change its value, without leaving the prompt |
| `ctrl+x tab`, then `1`–`9`, `x`, `s`, `p` | Pick an option, drop a row, open the sketch, attach it to the prompt |
| A number in the empty prompt during a turn | Switch Claude's focused choice right away |

Everything on the card also takes clicks, in the terminal and in the desktop app.

## What it costs and what leaves your machine

Each reading and each sketch is one small Haiku call through your own Claude Code session, so it counts toward your plan. A reading runs when you finish a sentence or pause, one at a time; a prompt usually takes a few. `/margincue mode quiet` keeps the card to one line, `/margincue sketch off` drops sketches, and `/margincue mode off` stops everything.

Your draft goes to Claude the same way your prompt does. The project index (file names and declared names, read with git or ripgrep) stays on your machine, and so do your first-run answers and learned picks. There is no telemetry; `/margincue log <path>` writes a local log of counts and timings, never your text.

## Where it runs

Claude Code 2.1.275 or later: the terminal on macOS, Linux and Windows, the Code tab of the desktop app, and VS Code. For Codex CLI, [`mods/codex`](mods/codex/README.md) holds the earlier version, which asks its questions after you press Enter; the card is coming to Codex next.

## Commands

`/margincue status` shows what MarginCue knows about you and the project. `/margincue setup` asks the first-run questions again. `/margincue card|sketch|refs|blanks on|off` switches each part. The [Claude Code guide](mods/claude-code/README.md) has the rest.

## Development

```sh
node --test spec/*.unit.ts
node spec/run-traces.ts
claude plugin test mods/claude-code
```

The Claude Code mod carries the [MIT license](mods/claude-code/LICENSE).

Inspired by [Bruce Liu's Feedforward](https://x.com/liu_xingyu/status/2121015724374397183).

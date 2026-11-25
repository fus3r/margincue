# MarginCue

[![test](https://github.com/fus3r/margincue/actions/workflows/test.yml/badge.svg)](https://github.com/fus3r/margincue/actions/workflows/test.yml)

See how Claude Code or Codex will read your prompt before it starts, and steer the choices it makes while it works.

<p align="center">
  <img src="docs/demo.gif" width="720" alt="MarginCue in Claude Code: the card flags Audit Log, a name the repo doesn't have, and one key picks the repo's ActivityLog; typing layout.tsx, which is in three files, adds a row asking which one you mean">
</p>

## Install

**Claude Code** 2.1.326 or later, at the prompt:

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

**First test:** type a one-letter typo of a real identifier from your repo, in backticks (`getUsr` for `getUser`), and watch the card flag it.

## What it does

While you type:

- **The reading.** One line above the prompt says what the agent will deliver and how it takes your request, including whether the cases you list are the whole job or just examples.
- **Your names, checked against your code.** Names in the prompt are looked up in the project as you type. A name the code doesn't have ("Audit Log", when the code says `activityLogs`) is flagged before you send, with the closest names it does have, one key each.
- **The open choices, each with a control.** Chips, sliders and pick-any rows for what the prompt leaves open. By default, your picks, saved decisions and written step order go with the prompt. The remaining rows go as open questions, with every option unmarked.
- **A sketch of the result.** For something new: a wireframe, a sample of the report, a results table. Change a choice and it redraws.

While Claude works:

- **Its choices become switches.** Claude marks the choices it makes for you as it goes. Switch one and the change reaches it at its next step, without stopping it.
- **A receipt.** After the turn, what you set and what Claude chose. Switch one and the follow-up prompt is written for you.

It adapts to you and to the project. The first run asks what you work on and your level in each field. A data challenge or a research repository brings in the matching expert decisions (statistics and machine learning, system design), at the depth you asked for.

The on-demand expert review (`ctrl+x tab`, then `r`, or `/margincue review`) draws on chapters for [general coding-agent work](profiles/general/chapters.md), [ML research](profiles/ml-research/chapters.md), [product](profiles/product/chapters.md), and [system design](profiles/system-design/chapters.md). It picks up to two chapters that match the draft and uses the theory and workflow for your stated level in each field. For example, a learner working on model evaluation gets help choosing what data to hold out. An expert gets guidance on what the evaluation design lets them claim.

Automatic chapter review (beta) is off by default and can be enabled with `/margincue review auto` or, for the Codex live card, by setting `"review": "auto"` in `~/.margincue/settings.json`.

## Keys

| Key | What it does |
| --- | --- |
| `alt+↑` / `alt+↓` (or `ctrl+↑` / `ctrl+↓`) | Next row / change its value, without leaving the prompt |
| `ctrl+x tab`, then `1`–`9`, `x`, `s`, `p` | Pick an option, drop a row, open the sketch, attach it to the prompt |
| `ctrl+x tab`, then `k` (Claude Code) | Keep all shown selections. Pick hard-to-undo choices individually |
| A number in the empty prompt during a turn | Switch Claude's focused choice right away |
| `ctrl+]` then `c` (Codex) | Read the draft in `key` mode with relay 0.1.3 or later |
| `ctrl+]` then `k` (Codex) | Keep all shown selections, with relay 0.1.4 or later. The full-screen card uses `tab`, then `k` |
| `e` on a focused receipt choice (Claude Code terminal) | Open related edits |
| `ctrl+]` then `t` (Codex) | MarginCue off or on for this session |

Everything on the card also takes clicks.

## What it costs and what leaves your machine

In Claude Code, each reading and each sketch is one small Haiku call through your own session, so it counts toward your plan. In Codex, each reading or sketch is a short thread through your own Codex login, on the lightest model your account offers, never saved to your history. A reading runs when you finish a sentence or pause in the composers, or on Enter in the Codex desktop app. `/margincue mode quiet` keeps the card to one line while you type, `/margincue sketch off` drops sketches, and `/margincue mode off` stops everything. In Codex desktop, quiet mode skips the card at Enter.

Your draft goes to Claude the same way your prompt does, through your own session, with a little context from the project: an outline of its folders and file names (at most 3,200 characters), the file where each name in your draft was found, a few related folders with their file names, and one line about you from your first-run answers. MarginCue keeps file contents on your machine unless you open a receipt diff that needs one Claude reading, which sends only a bounded set of potentially related hunks. The project index (file names and declared names, read with git or ripgrep), your first-run answers and your learned picks are stored on your machine. There is no telemetry; `/margincue log <path>` writes a local log of counts and timings, never your text.

## Where it runs

| | Card before work | Choices as switches | Receipt |
| --- | --- | --- | --- |
| Claude Code: terminal (macOS, Linux, Windows) | above the prompt | on the card, during the turn | under the answer |
| Claude Code: desktop app (Code tab), VS Code | at Enter (these apps show plugins no draft): each choice Claude would make as a dropdown, above Claude's send question, whose "Other" adds to your prompt | above the prompt, during the turn | under the answer |
| Codex CLI | under the prompt as you type (macOS, Linux; on Windows, on ctrl+g) | under the prompt; the change goes in the prompt box and Enter sends it into the turn | after the turn |
| Codex in the ChatGPT desktop app | at Enter on new tasks, as an interactive card before Codex starts | marked in the reply | after the turn |
| Codex IDE extension | at the top of the agent's reply | marked in the reply | after the turn |

## Commands

In Claude Code, `/margincue status` shows what MarginCue knows about you and the project, `/margincue setup` asks the first-run questions again, and `/margincue card|sketch|refs|blanks on|off` switches each part. Use `/margincue send open|all|picked` to choose what the card sends and `/margincue read auto|key` to choose when it reads. [Claude Code guide](mods/claude-code/README.md)

In Codex, set `send` and `read` in `~/.margincue/settings.json`, and update a field with `margincue level <profile> <learning|practitioner|expert>`. [Codex settings and shortcuts](mods/codex/README.md#settings-and-removal)

## Development

```sh
node --test spec/*.unit.ts
node spec/run-traces.ts
claude plugin test mods/claude-code
cargo test --release --manifest-path crates/margincue-relay/Cargo.toml
```

The Claude Code mod carries the [MIT license](mods/claude-code/LICENSE).

Inspired by [Bruce Liu's Feedforward](https://x.com/liu_xingyu/status/2121015724374397183).

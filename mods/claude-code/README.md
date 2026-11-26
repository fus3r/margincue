# MarginCue for Claude Code

While you type a prompt, MarginCue shows how the agent will read it, links the names you use to your code, lists the choices the prompt leaves open with a control for each, and sketches what the result will look like. While the agent works, the choices it makes for you become switches you can flip without stopping it. After the turn, a receipt lists who decided what, and one key turns a change into the follow-up prompt. Enter always sends at once.

## Install

In Claude Code 2.1.326 or later, at the prompt:

```
/plugin install margincue --marketplace fus3r/margincue
```

Answer `y` to add the marketplace, then choose a scope. From a shell: `claude plugin install margincue --marketplace fus3r/margincue`. In the desktop app: + next to the prompt box, Plugins, Add marketplace `fus3r/margincue`, then Add plugin.

To run a checkout while working on MarginCue itself: `claude --plugin-dir path/to/margincue/mods/claude-code`.

Run `/margincue status` in Claude Code to check that the mod loaded. The status line says whether the project index is ready.

## First run

The first time MarginCue starts in an interactive session with an empty prompt, it asks what you use coding agents for, how experienced you are in the fields you picked, and which choices you want to make yourself. Fields without a stated level use standard depth. Use `/margincue setup` to update your answers, `/margincue setup reset` to forget them, and `/margincue status` to see what MarginCue knows. The answers stay in the mod's store on this machine.

## What you see

**The reading.** Above the prompt, one line starting "You want…" says how the agent will take your request: what it will deliver and its scope, including whether the cases you list are the whole job or examples. It appears on prompts of six words or more, refreshes at sentence ends and pauses by default, and shows ⟳ while a newer reading is on its way.

**Names in the code.** As you type, names in your prompt are looked up in the project (git or ripgrep, collected once in the background). Found names are underlined in blue; a name the code does not have is underlined in yellow and, when the code has close names, becomes a row asking which one you mean. On Enter, the files behind what you wrote as code (a path, a file name, an identifier, something in backticks) go with the prompt (`Where things are: …`) so the agent skips its search; product names and plain words are never sent as places.

**Choices, with a control for each.** One row per open choice: chips for one-of and pick-any choices, a slider for ordered values and numbers. The value a row reads with is a filled chip: grey-blue while it is only what the agent would do, green once you set it. Options are never cut while the terminal has room: a long row wraps, and the focused row shows every option. The focused row's words are highlighted in your prompt. ◆ marks a decision from an expert profile (ML research, system design). The profile comes from the project itself, read once in the background from its folder name, files and libraries (a challenge or a hackathon, a research repository, notebooks and data, train and test files, torch or sklearn; Dockerfiles, Terraform, Kafka or Redis), from `/margincue profile`, or from the field's vocabulary in your prompt. The project also sets the stakes: a challenge gets the decisions that matter when a held-out score counts, a research project the ones that must stand up to review. `/margincue status` says which profile the project calls for and why. ↺ marks your usual pick, learned after you chose the same option twice in this project. On Enter the plan you saw travels with the prompt, in a Decisions block: every choice on the card, the ones you set and the ones you kept, so the agent does not decide them again. That holds when the card was read for exactly what you send; if you typed on after its last reading, only the choices you set travel. In the transcript, your sent prompt lists them under it.

**The sketch.** For a request that builds or changes something, a few lines show what done will look like: a wireframe, a sample of the report or output, a request and its response, a results table. On a terminal of 140 columns or more it stands beside the rows; otherwise under them, its first lines and its frame's bottom kept when the band runs short of rows. Changing a choice redraws it. It goes with the prompt as the target output, once it is drawn for the choices you send; press `✓ goes with the prompt` to leave it out.

**During the turn.** The agent marks the choices it makes for you; its reply shows each in bold, followed by "N choices made for you", and the card lists them as blue chips. Switch one and the change reaches the agent at its next step, without stopping it.

**After the turn.** A receipt under the answer lists the choices you set and those the agent made, with what you switched. Switch one again, on the receipt or on the card, and the follow-up prompt is written into the composer for you to send.

The receipt shows high-consequence choices first and folds low ones when there are more than four agent choices. In the terminal, `/margincue choices` groups the last 20 receipts' agent choices by tier, with switches that name the turn and diff links when edits were captured.

In the terminal, use **diff** beside a choice or open **Review choices** (also `/margincue edits` for the latest receipt). Focus a choice with Tab and press `e` to open its related edits. VS Code, Cursor and Windsurf open a diff for each related file when their CLI is on `PATH`. The diff starts from the file at the beginning of the turn and shows the related hunks or the whole file change when the receipt can only match the file. Other terminals open a temporary `.diff` through `$VISUAL` or `$EDITOR` or show its path in the transcript.

The terminal card's `§` line shows a matching chapter's Choice note at your level. Press `ctrl+x tab` then `b` to open or close its Theory, Workflow and Choice, press `z` to drop it, or use `/margincue chapters on|off` to switch it.

## Keys

| Key | Action |
| --- | --- |
| `alt+↑` (or `ctrl+↑` where the terminal keeps alt for itself) | Next row |
| `alt+↓` (or `ctrl+↓`) | Next value of the focused row (during a turn, the change is sent 1.5 s after the last press) |
| `ctrl+x tab`, then `1`–`9` | Pick an option of the focused row (a pick-any row toggles it) |
| `ctrl+x tab`, then `x` | Drop the focused row; a newer reading will not bring it back |
| `ctrl+x tab`, then `s` / `p` | Open or close the sketch / attach it to the prompt |
| `ctrl+x tab`, then `c` | Read the current draft |
| `ctrl+x tab`, then `k` | Keep all shown selections. Pick hard-to-undo choices individually |
| `ctrl+x tab`, then `r` / `d` | Expert review of the draft / change the depth |
| A number in the empty composer during a turn | Switch the focused agent choice at once |
| `e` in **Review choices** | Open related edits for the focused receipt choice |

Buttons also take clicks: a chip, a step of a slider, `+N` to open a row, the sketch's title and `✓ goes with the prompt` (or `attach to prompt` once left out).

Run `/margincue review [profile]` to find up to two consequential choices your draft leaves open. The review uses the profile and your level in it and skips choices already on the card.

## Settings

`/margincue mode auto|on|quiet|off` controls when the card runs. Quiet keeps it to one line. `/margincue card on|off` switches the card. `/margincue read auto|key` reads as you type (default) or waits for `ctrl+x tab`, then `c`. `/margincue sketch on|off`, `/margincue refs on|off` and `/margincue blanks on|off` switch the sketch, the `Where things are` line and the choice marks. Use `/margincue language en|auto`, `/margincue profile <name>`, `/margincue depth essentials|standard|research` and `/margincue review [profile]` to control the review.

`/margincue send open|all|picked` sets what goes with the prompt. Every mode sends your picks, saved decisions and written step order.

- `open` (default) sends untouched rows as unmarked questions. Claude settles each one and says what it chose.
- `all` sends ordinary defaults as decisions.
- `picked` sends only the decisions above, plus any untouched hard-to-undo questions. Those questions stay open in every mode until you pick an option.

If you used `send all` before this change, run it again to save that preference.

Standing decisions are unchanged: `/margincue state`, `/margincue why <slot>` and `/margincue forget <slot> [scope]`. Project decisions live in `.margincue/decisions.json`; learned picks stay in the mod's own store, never in your repository. `/margincue log <path>` writes a local event log without draft text, and `/margincue ab on|off|status` runs the card and control arms.

Readings and sketches are one Haiku call each through your Claude Code session, at low effort. Claude Code's mod filesystem limit is 4 MiB per file.

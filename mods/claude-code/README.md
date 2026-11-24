# MarginCue for Claude Code

MarginCue shows standing decisions above the prompt while you type. Confirmed standing choices can apply to one project, everywhere, only with the current model, or only during the session. A draft that starts something new can also show a short sheet of questions and options. Your selected options travel with the prompt in a visible Decisions block. Enter sends immediately.

## Install

Download [margincue-claude-code.zip](https://github.com/fus3r/margincue/releases/download/v0.2.0/margincue-claude-code.zip). Start a signed-in Claude Code CLI that supports mods from the project where you want to use it.

```sh
claude --plugin-dir "$HOME/Downloads/margincue-claude-code.zip"
```

Tested on macOS with Claude Code 2.1.330 and 2.1.331.

If you cloned MarginCue, run Claude Code from the project you want to work in. Give `--plugin-dir` the full path to the plugin inside your checkout.

```sh
claude --plugin-dir "/path/to/MarginCue/mods/claude-code"
```

Run `/margincue status` in Claude Code to check that the mod loaded.

Type `Build a site to share our club's photos.` and pause. Choose **Answer** when the questions appear. Pick a number, then press Esc to return to the draft. Enter attaches the confirmed answer. To leave MarginCue out of the next session, start Claude Code without `--plugin-dir`.

Eligible drafts go to Haiku through your existing Claude session. Run `/margincue sheet off` to turn off automatic questions or `/margincue mode off` to turn off MarginCue reviews.

## Controls

Press `ctrl+x tab` to focus the band. A number picks an option, `s` changes scope, `x` skips, `w` explains the choice, `d` changes depth, and `r` opens expert review. From the prompt, `alt+↓` picks the next option and `alt+↑` cycles scope when the band shows a standing choice. The band buttons also take clicks.

The band shows “MarginCue · thinking…” while a sheet or on-demand review is running. When the questions arrive, MarginCue highlights the first unanswered one. Click **Answer** or press `alt+↑` to open the pane. A number picks and advances. You can also use `↑` and `↓` with Enter, `s` to skip, `b` to go back, or Escape to return to your draft with your answers. The pane also returns to the draft after the last question. Selected answers appear above the draft with a check mark. Enter sends them with the draft.

During a turn, the band shows one unanswered question. A bare number in an empty composer answers it and queues the choice for Claude’s next model request. `alt+↑` is available during the turn too. In quiet mode, the band keeps the open count and `alt+↑` opens the pane.

English is the default for the interface, sheets, and decision wording. Use `/margincue language auto` to follow the draft’s language or `/margincue language en` to select English. `/margincue status` shows the saved setting.

`/margincue state` lists saved decisions and `/margincue why <slot>` shows the card’s rationale and source. `/margincue forget <slot> [scope]` removes an answer, starting at the narrowest active scope when omitted. `/margincue mode auto|on|quiet|off` selects the display policy. Auto and on show questions, quiet shows a count, and off stops reviews and hides the band. `/margincue sheet on|off` switches kick-off sheets on or off. They are on by default. `/margincue review [profile]` reviews the current draft explicitly. Sheets and expert reviews use the session’s Claude credentials.

Project decisions live in `.margincue/decisions.json`. Personal bundles can be placed in `~/.margincue/bundles/`. `/margincue log <path>` starts a local event log for the session and `/margincue log off` stops it. Log rows contain decision identifiers, choices, and timings. Draft text and free-text answers are omitted.

`/margincue ab on` assigns each new active session to the sheet or control arm and stores its sheet events in a per-session file under `~/.margincue/ab/`. `/margincue ab status` totals the saved counts per arm. `/margincue ab off` ends participation. The sheet setting also applies during the trial.

Project changes refresh roughly once per second. Use a separate event log path for each concurrent writer. Claude Code’s mod filesystem limit is 4 MiB per file.

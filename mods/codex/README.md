# MarginCue for Codex CLI

The same card as in Claude Code, in Codex:
- **Before you send:** how the agent will read the prompt, your names checked against the code, a control for each open choice, and a sketch of the result.
- **While Codex works:** its own choices become switches.
- **After the turn:** a receipt.

## Install

Codex CLI 0.171 or later, and Node 20 or later:

```sh
npx -y github:fus3r/margincue setup
```

Setup does three things:
1. It installs the Codex plugin (`codex plugin marketplace add fus3r/margincue`, then `codex plugin add margincue@margincue`).
2. It asks three or four questions about your work, so the card fits it.
3. It offers to add a `codex` alias, so Codex opens MarginCue when you press ctrl+g.

In your next Codex session, trust the plugin's hooks when Codex asks (press `t`), or review them first with `/hooks`.

## Use

Write the prompt in Codex as usual and press **ctrl+g**. Codex hands the draft to MarginCue, which shows the card above it while you edit:

| Key | What it does |
| --- | --- |
| `alt+↑` / `alt+↓` (or `ctrl+↑` / `ctrl+↓`) | Next row / change its value |
| `tab`, then `1`–`9`, `x`, `s`, `p` | Pick an option, drop a row, show the sketch, attach it to the prompt |
| `enter` | Back to Codex with the prompt and the Decisions you set; `enter` there sends it |
| `shift+enter` (or `alt+enter`) | New line |
| `ctrl+e` | Your own editor on the draft |
| `esc` | Back to Codex, draft unchanged |

The card's readings use your own Codex login: each is a one-off thread on the lightest model your account offers, at low effort, never saved to your history. MarginCue's own readings skip your hooks.

**While Codex works**, press ctrl+g in the empty prompt: the choices the agent made for you are listed as switches. Switch one and MarginCue writes the amendment. Press `enter` there, then `enter` in Codex, and the change reaches the running turn. **After the turn**, the same keys write the follow-up prompt, and the receipt line lists who decided what.

## The Codex desktop app and the IDE extension

Codex gives plugins no hook before you send, and the app has no ctrl+g editor. So there, the agent opens its reply with MarginCue's card instead:
- the reading;
- any name the code does not have;
- the choices it settles, marked like this: ⟦label: choice | alternative⟧.

The receipt follows the turn. The same applies when you press Enter in the CLI without ctrl+g.

## Settings and removal

`margincue status` shows what MarginCue knows about you. Settings live in `~/.margincue/settings.json` (`"mode": "off" | "quiet" | "auto"`, `"sketch": false`, `"blanks": false`).

To remove MarginCue:
1. Run `codex plugin remove margincue@margincue`.
2. Delete the `codex` alias from your shell profile.
3. Delete `~/.margincue`.

## Development

```sh
cd mods/codex
npm run build                      # src/ → dist/margincue.mjs (one file, no dependencies)
node --test ../../spec/codex.unit.ts
```

The composer shares its core, layout and prompts with the Claude Code mod in `../claude-code`.

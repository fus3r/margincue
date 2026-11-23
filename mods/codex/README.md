# MarginCue for Codex CLI

MarginCue checks each submitted prompt for signs that you're starting something new. If the check passes, it asks the acting model to get your choices before opening files, running commands, or editing. The questions appear after Enter and use the running Codex session.

## Install

Tested with Codex CLI 0.171.0 on Apple silicon. Download [margincue-codex-macos-arm64.tar.gz](https://github.com/fus3r/margincue/releases/download/v0.2.0/margincue-codex-macos-arm64.tar.gz). Extract it and run the installer from the extracted directory.

```sh
./mods/codex/margincue install
```

Start a new Codex session. Review and trust the two MarginCue hooks at startup or through `/hooks`. Then send a prompt such as `Build a site to share our club's photos.`

To build from source on another Unix system, clone the repository and run the same installer from the checkout. It builds with Cargo when the bundled executable is absent.

```sh
git clone https://github.com/fus3r/margincue.git
cd margincue
./mods/codex/margincue install
```

## How to answer

- **Codex picker.** To enable the experimental picker outside plan mode, run `./mods/codex/margincue picker on`. It shows up to three questions. Press an option number to advance. This setting also makes the picker available to Codex on other prompts. Run `./mods/codex/margincue picker off` to undo it.
- **MarginCue form.** Approval policies that allow MCP forms can show up to five questions in a terminal dialog. Press a number to answer, or Esc to skip the dialog. `./mods/codex/margincue run` starts a session with a policy that allows MCP forms.
- **Reply.** When the picker and form are unavailable, Codex can ask in its reply. Answer with one number per question, such as `2 1 3`, or `0` to let it decide.

`./mods/codex/margincue status` reports which path your Codex settings allow. `./mods/codex/margincue off` disables the hook's questions. `on` re-enables them. Use `timeout 90` to set the form timeout in seconds or `timeout 0` for no limit.

To uninstall, run `./mods/codex/margincue remove` from the package or checkout. To install a newer downloaded package, remove the old installation first, then run the new package's installer and review the hooks again.

## Local data

Settings and event counts live in `$XDG_STATE_HOME/margincue/codex` or `~/.local/state/margincue/codex` by default. The MarginCue event log records timings and question and answer counts. It omits prompt text.

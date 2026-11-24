#!/usr/bin/env bash
# What `npx -y github:fus3r/margincue setup` does, from the packed package, in a fresh home. Run from the
# repository root by the setup jobs in test.yml (every push) and relay.yml (daily, against the release).
set -eo pipefail
pack=$(npm pack --silent | tail -1)
home="$RUNNER_TEMP/home"
mkdir -p "$home"
export HOME="$home" USERPROFILE="$home" SHELL=/bin/bash
touch "$home/.bashrc"
# Setup downloads the relay this version's release carries. The relay workflow attaches it only once a
# tag is pushed and its builds finish, so until then setup falls back to ctrl+g, as it would for a user.
version=$(node -p "require('./package.json').version")
case "$RUNNER_OS-$RUNNER_ARCH" in
  Linux-X64) asset=margincue-relay-linux-x64 ;;
  Linux-ARM64) asset=margincue-relay-linux-arm64 ;;
  macOS-X64) asset=margincue-relay-darwin-x64 ;;
  macOS-ARM64) asset=margincue-relay-darwin-arm64 ;;
  *) asset= ;;
esac
released=no
if [[ -n "$asset" ]] && curl -sfL -r 0-0 -o /dev/null "https://github.com/fus3r/margincue/releases/download/v$version/$asset"; then
  released=yes
fi
# A relative path: Git Bash turns file:$PWD into D:\d\a\... on Windows.
printf '\ny\n' | npx -y --package="./$pack" margincue setup | tee "$RUNNER_TEMP/setup.log"
node "$home/.margincue/bin/margincue.mjs" codex --version | grep codex-cli
if [[ "$RUNNER_OS" == Windows ]]; then
  grep "function codex" "$home/Documents/PowerShell/Microsoft.PowerShell_profile.ps1"
  grep "Not on Windows yet" "$RUNNER_TEMP/setup.log"
else
  grep "margincue.mjs\" codex'" "$home/.bashrc"
  if [[ "$released" == yes ]]; then
    "$home/.margincue/bin/margincue-relay" --version | grep "protocol 1"
  else
    # Not released yet: the ctrl+g fallback, or the relay if its release landed during setup.
    grep "ctrl+g in Codex opens the card instead" "$RUNNER_TEMP/setup.log" \
      || "$home/.margincue/bin/margincue-relay" --version | grep "protocol 1"
  fi
fi

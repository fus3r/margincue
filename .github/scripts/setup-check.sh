#!/usr/bin/env bash
# What `npx -y github:fus3r/margincue setup` does, from the packed package, in a fresh home. Run from the
# repository root by the setup jobs in test.yml (every push) and relay.yml (daily, against the release).
set -eo pipefail
pack=$(npm pack --silent | tail -1)
home="$RUNNER_TEMP/home"
mkdir -p "$home"
export HOME="$home" USERPROFILE="$home" SHELL=/bin/bash
# Windows reads its Documents folder from USERPROFILE: give it the Windows form of the path, as a real profile has.
if [[ "$RUNNER_OS" == Windows ]]; then export USERPROFILE="$(cygpath -w "$home")"; fi
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
  for shell in pwsh powershell; do
    "$shell" -NoProfile -Command '
      if (-not (Select-String -LiteralPath $PROFILE -Pattern "^function codex .*margincue\.mjs" -Quiet)) {
        throw "MarginCue function missing from $PROFILE"
      }
    '
  done
  [[ "$(grep -cF '[Y/n]' "$RUNNER_TEMP/setup.log")" == 1 ]]
  grep "Not on Windows yet" "$RUNNER_TEMP/setup.log"
else
  # A macOS terminal opens bash as a login shell: the alias goes where that shell reads it.
  if [[ "$RUNNER_OS" == macOS ]]; then rc="$home/.bash_profile"; else rc="$home/.bashrc"; fi
  grep "margincue.mjs\" codex'" "$rc"
  if [[ "$released" == yes ]]; then
    "$home/.margincue/bin/margincue-relay" --version | grep "protocol 1"
  else
    # Not released yet: the ctrl+g fallback, or the relay if its release landed during setup.
    grep "ctrl+g in Codex opens the card instead" "$RUNNER_TEMP/setup.log" \
      || "$home/.margincue/bin/margincue-relay" --version | grep "protocol 1"
  fi
fi

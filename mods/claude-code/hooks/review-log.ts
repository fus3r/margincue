import type { EngineInterface } from 'claude-code'
import { REVIEW_LOG_FILE } from '../core/review-log'

type IO = Pick<EngineInterface, 'env' | 'process'>

export async function reviewLogPath($: IO): Promise<string> {
  const directory = await $.env.get('MARGINCUE_HOME').catch(() => undefined)
  if (directory) return directory.replace(/[\\/]+$/, '') + '/' + REVIEW_LOG_FILE
  const home = await $.env.get('HOME').catch(() => undefined) ?? await $.env.get('USERPROFILE')
  if (!home) throw new Error('No home directory for the audit log')
  return home.replace(/[\\/]+$/, '') + '/.margincue/' + REVIEW_LOG_FILE
}

type Action = 'append' | 'count' | 'clear'

// The mod file API exposes whole-file writes. Append through the host, using
// stdin so prompt content can't become a shell argument or a command.
const unix = `
  set -e
  file=$1
  dir=\${file%/*}
  [ ! -L "$dir" ] && [ ! -L "$file" ] || exit 1
  case "$2" in
    append) umask 077; mkdir -p "$dir"; cat >> "$file" ;;
    count) if [ -f "$file" ]; then wc -l < "$file"; else echo 0; fi ;;
    clear) rm -f -- "$file" ;;
  esac`
const windows = `
  $ErrorActionPreference = 'Stop'
  $file = $env:MARGINCUE_AUDIT_LOG
  $dir = Split-Path -Parent $file
  foreach ($path in @($dir, $file)) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
  }
  switch ($env:MARGINCUE_AUDIT_ACTION) {
    'append' {
      [void][IO.Directory]::CreateDirectory($dir)
      [Console]::InputEncoding = [Text.Encoding]::UTF8
      $line = [Console]::In.ReadToEnd()
      [IO.File]::AppendAllText($file, $line)
    }
    'count' { if ([IO.File]::Exists($file)) { ([IO.File]::ReadLines($file) | Measure-Object).Count } else { 0 } }
    'clear' { [IO.File]::Delete($file) }
  }`

export async function reviewLogIO($: IO, action: Action, path: string, line?: string): Promise<number> {
  const isWindows = /^[a-z]:[\\/]/i.test(path)
  const command = isWindows ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', windows]
    : ['sh', '-c', unix, 'margincue-audit', path, action]
  const result = await $.process.run(command, {
    timeoutMs: 5000, ...(line !== undefined && { stdin: line + '\n' }),
    ...(isWindows && { env: { MARGINCUE_AUDIT_LOG: path, MARGINCUE_AUDIT_ACTION: action } }),
  })
  if (result.exitCode !== 0) throw new Error('Could not access the audit log')
  return Number(result.stdout.trim())
}

// margincue: the composer Codex opens on ctrl+g, the Codex hooks, and setup.
//
//   margincue setup           install for Codex: plugin, first-run questions, the card under Codex's prompt
//   margincue codex [args]    start Codex with the card under its prompt (the relay), and the composer on ctrl+g
//   margincue compose FILE    the composer (Codex runs it)
//   margincue hook prompt|stop|start   the Codex hooks (they read JSON on stdin)
//   margincue mcp             the desktop card's stdio server
//   margincue prefetch ID     read a desktop card in the background (the prompt hook starts it)
//   margincue status          what MarginCue knows about you

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describeUser, interview } from '../../claude-code/hooks/onboarding'
import { runnable } from './command'
import { compose } from './compose'
import { promptHook, stopHook } from './hooks'
import { serveMcp } from './mcp'
import { findRelay, installRelay, startRelay } from './relay'
import { runPrefetch } from './prefetch'
import { PATHS, readSettings, saveSettings, sendSetting } from './store'
import { MIN_CODEX, tooOld } from './version'

const SELF = fileURLToPath(import.meta.url)
/** Where setup and the session hook keep a copy of this file, so the shell alias survives plugin updates. */
const STABLE = join(PATHS.bin, 'margincue.mjs')
const slash = (path: string) => (process.platform === 'win32' ? path.replace(/\\/g, '/') : path)
const quote = (path: string) => `"${slash(path)}"`

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === 'compose' && rest[0]) return compose(rest[0])
  if (command === 'hook') return hook(rest[0] ?? '')
  if (command === 'mcp') return serveMcp()
  if (command === 'prefetch' && rest[0]) return runPrefetch(rest[0])
  if (command === 'codex') return launch(rest)
  if (command === 'setup') return setup()
  if (command === 'status') return status()
  process.stdout.write('margincue setup | codex [args] | compose FILE | hook prompt|stop|start | mcp | status\n')
}

// ---- hooks: never in the way of the person's prompt --------------------------------------

async function hook(event: string): Promise<void> {
  try {
    const input = JSON.parse(await stdin() || '{}') as Record<string, unknown>
    const output = event === 'prompt' ? promptHook(input) : event === 'stop' ? stopHook(input) : event === 'start' ? startHook() : null
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch {}
}

/** Each session keeps the stable copy current, so `margincue codex` runs the installed version. */
function startHook(): null {
  keepCopy()
  return null
}

function keepCopy(): void {
  try {
    if (SELF === STABLE) return
    if (existsSync(STABLE) && readFileSync(STABLE).equals(readFileSync(SELF))) return
    mkdirSync(PATHS.bin, { recursive: true })
    copyFileSync(SELF, STABLE)
  } catch {}
}

function stdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
  })
}

// ---- the launcher --------------------------------------------------------------------

/**
 * Codex under the relay: the card sits under its prompt box as the prompt is typed. Codex picks
 * its ctrl+g editor from VISUAL alone: the composer goes there, the person's editor behind ctrl+e.
 * Without the relay (Windows, no binary, MARGINCUE_RELAY=off) Codex starts bare and ctrl+g opens the card.
 */
function launch(args: string[]): void {
  const own = process.env['MARGINCUE_EDITOR'] || process.env['VISUAL'] || process.env['EDITOR'] || ''
  const visual = `${quote(process.execPath)} ${quote(existsSync(STABLE) ? STABLE : SELF)} compose`
  const env = { ...process.env, VISUAL: visual, ...(own && !own.includes('margincue') && { MARGINCUE_EDITOR: own }) }
  const bare = () => {
    const codex = runnable('codex', args)
    const child = spawn(codex.command, codex.args, { ...codex.options, stdio: 'inherit', env })
    child.on('exit', (code) => process.exit(code ?? 0))
    child.on('error', (error) => {
      process.stderr.write(`margincue: could not start codex (${error.message}). Is Codex CLI installed?\n`)
      process.exit(1)
    })
  }
  const relay = findRelay(env)
  if (relay && startRelay(relay, args, env, bare)) return
  bare()
}

// ---- setup ---------------------------------------------------------------------------

/** Answers in order, typed or piped; null once the input has ended. */
function lineReader() {
  const rl = createInterface({ input: process.stdin })
  const lines: string[] = []
  const waiting: ((line: string | null) => void)[] = []
  let closed = false
  rl.on('line', (line) => {
    const next = waiting.shift()
    if (next) next(line)
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    for (const next of waiting.splice(0)) next(null)
  })
  return {
    question(prompt: string): Promise<string | null> {
      process.stdout.write(prompt)
      if (lines.length) return Promise.resolve(lines.shift()!)
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => waiting.push(resolve))
    },
    close: () => rl.close(),
  }
}

async function setup(): Promise<void> {
  const rl = lineReader()
  const say = (line = '') => process.stdout.write(`${line}\n`)
  say('MarginCue for Codex')
  say()
  const codex = codexSync(['--version'])
  if (codex.status !== 0) {
    say('Codex CLI was not found. Install it first: npm install -g @openai/codex')
    rl.close()
    return
  }
  const found = tooOld(`${codex.stdout ?? ''}`)
  if (found) {
    say(`Codex CLI ${found} is older than ${MIN_CODEX}, which MarginCue needs. Update it first: npm install -g @openai/codex@latest`)
    rl.close()
    return
  }
  say(`1. The plugin (hooks that let you switch the agent's choices during a turn, and the receipt after it).`)
  const added = codexSync(['plugin', 'marketplace', 'add', 'fus3r/margincue'])
  const installed = codexSync(['plugin', 'add', 'margincue@margincue'])
  say(installed.status === 0 || /already/i.test(`${installed.stdout}${installed.stderr}`)
    ? '   Installed. In your next Codex session, trust its hooks when Codex asks (press t), or review them with /hooks.'
    : `   Could not install it automatically (${(added.stderr || installed.stderr || '').trim().split('\n')[0] || 'unknown error'}).\n` +
      '   Run: codex plugin marketplace add fus3r/margincue && codex plugin add margincue@margincue')
  keepCopy()
  say()
  const settings = readSettings()
  if (settings.onboarded !== 'done') {
    say('2. A few questions, so the card fits your work (Enter skips).')
    try {
      const user = await interview(async (question, options) => {
        say()
        say(`   ${question}`)
        options.options.forEach((label, i) => say(`     ${i + 1}. ${label}`))
        const answer = ((await rl.question(options.multiSelect ? '   Numbers, comma-separated: ' : '   Number: ')) ?? '').trim()
        say()
        if (!answer) throw new Error('skipped')
        const picked = answer.split(/[,\s]+/).map((n) => options.options[Number(n) - 1]).filter((label): label is string => Boolean(label))
        return picked.join(', ') || answer
      })
      saveSettings({ ...settings, user, onboarded: 'done' })
      say()
      say(`   Saved: ${describeUser(user)}`)
    } catch {
      saveSettings({ ...settings, onboarded: 'skipped' })
      say('   Skipped. Run margincue setup again any time.')
    }
    say()
  }
  say(`3. The card under Codex's prompt, as you type.`)
  await installRelay(say)
  const { files, text } = aliasLine()
  const missing = files.filter((file) => !readText(file).includes(text))
  if (!missing.length) {
    say(`   The codex alias is already in ${files.join(' and ')}.`)
  } else {
    const answer = ((await rl.question(`   Add this to ${missing.join(' and ')}?\n     ${text}\n   [Y/n] `)) ?? 'n').trim().toLowerCase()
    if (answer === '' || answer === 'y' || answer === 'yes') {
      let added = false
      for (const file of missing) {
        try {
          mkdirSync(dirname(file), { recursive: true })
          appendProfile(file, `\n# MarginCue: Codex with MarginCue's card under its prompt\n${text}\n`)
          added = true
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : 'error')
          say(`   Could not write to ${file} (${code}). Add the line above to your shell profile yourself, or start Codex with: node ${quote(STABLE)} codex`)
        }
      }
      if (added) say('   Added. Open a new terminal and run codex: the card shows under the prompt as you type.')
    } else say(`   Not added. Start Codex with: node ${quote(STABLE)} codex`)
  }
  rl.close()
}

function codexSync(args: string[]) {
  const codex = runnable('codex', args)
  return spawnSync(codex.command, codex.args, { ...codex.options, encoding: 'utf8' })
}

const hasUtf16LeBom = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xfe

function readText(file: string): string {
  try {
    const bytes = readFileSync(file)
    return bytes.toString(hasUtf16LeBom(bytes) ? 'utf16le' : 'utf8')
  } catch {
    return ''
  }
}

function appendProfile(file: string, text: string): void {
  if (process.platform !== 'win32') {
    appendFileSync(file, text)
    return
  }
  // Windows PowerShell 5.1 can write UTF-16 LE and needs a BOM to read a new UTF-8 profile as UTF-8.
  const before = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
  appendFileSync(file, before.length ? text : `\ufeff${text}`, hasUtf16LeBom(before) ? 'utf16le' : 'utf8')
}

function powershellProfiles(): string[] {
  const files = new Set<string>()
  // When Documents is missing, older PowerShell versions can omit it from $PROFILE.
  const query = [
    '$file = [string]$PROFILE;',
    String.raw`if ([IO.Path]::GetPathRoot($file) -in '', '\') {`,
    "  $documents = [Environment]::GetFolderPath('MyDocuments', 'DoNotVerify');",
    String.raw`  $file = [IO.Path]::Combine($documents, $file.TrimStart('\'))`,
    '};',
    // Keep redirected Documents paths intact across console code pages.
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($file))',
  ].join(' ')
  for (const shell of ['pwsh', 'powershell']) {
    const command = runnable(shell, ['-NoProfile', '-Command', query])
    const answer = spawnSync(command.command, command.args, { ...command.options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })
    if (answer.status !== 0) continue
    let file = Buffer.from(answer.stdout.trim(), 'base64').toString('utf8')
    // Still relative (no Documents folder Windows can name): the person's own Documents is where PowerShell looks.
    if (/\.ps1$/i.test(file) && !/^(?:[a-z]:[\\/]|\\\\)/i.test(file)) {
      file = join(process.env['USERPROFILE'] || homedir(), 'Documents', file.replace(/^[\\/]+/, ''))
    }
    if (/^(?:[a-z]:[\\/]|\\\\).+\.ps1$/i.test(file)) files.add(file)
  }
  return files.size ? [...files] : [join(homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')]
}

function aliasLine(): { files: string[]; text: string } {
  // `node` from PATH, not this process's path: a versioned install path breaks on the next Node upgrade.
  const run = `node ${quote(STABLE)}`
  if (process.platform === 'win32') return { files: powershellProfiles(), text: `function codex { & ${run} codex @args }` }
  const shell = process.env['SHELL'] ?? ''
  if (shell.endsWith('fish')) {
    const config = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
    return { files: [join(config, 'fish', 'config.fish')], text: `function codex; ${run} codex $argv; end` }
  }
  // zsh reads its profile from ZDOTDIR when set. A macOS terminal opens bash as a login shell, which reads the
  // first of these files that exists and never ~/.bashrc.
  const login = ['.bash_profile', '.bash_login', '.profile'].map((name) => join(homedir(), name))
  const file = shell.endsWith('zsh') ? join(process.env['ZDOTDIR'] || homedir(), '.zshrc')
    : process.platform === 'darwin' && shell.endsWith('bash') ? login.find((path) => existsSync(path)) ?? login[0]!
    : join(homedir(), '.bashrc')
  return { files: [file], text: `alias codex='${run} codex'` }
}

function status(): void {
  const settings = readSettings()
  process.stdout.write([
    `MarginCue for Codex: ${settings.mode ?? 'auto'} · sketch ${settings.sketch === false ? 'off' : 'on'} · blanks ${settings.blanks === false ? 'off' : 'on'}`,
    `Read: ${settings.read === 'key' ? 'key' : 'auto'} · Send: ${sendSetting(settings)}`,
    settings.user ? `You: ${describeUser(settings.user)}` : 'You: not set up yet (margincue setup asks a few questions).',
    `Composer: ${existsSync(STABLE) ? STABLE : 'not installed (margincue setup)'}`,
  ].join('\n') + '\n')
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // A last resort: one line, never a stack trace in the person's terminal.
  process.stderr.write(`margincue: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

// margincue: the composer Codex opens on ctrl+g, the Codex hooks, and setup.
//
//   margincue setup           install for Codex: plugin, first-run questions, the composer on ctrl+g
//   margincue codex [args]    start Codex with the composer as its ctrl+g editor
//   margincue compose FILE    the composer (Codex runs it)
//   margincue hook prompt|stop|start   the Codex hooks (they read JSON on stdin)
//   margincue status          what MarginCue knows about you

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describeUser, interview } from '../../claude-code/hooks/onboarding'
import { compose } from './compose'
import { promptHook, stopHook } from './hooks'
import { PATHS, readSettings, saveSettings } from './store'

const SELF = fileURLToPath(import.meta.url)
/** Where setup and the session hook keep a copy of this file, so the shell alias survives plugin updates. */
const STABLE = join(PATHS.bin, 'margincue.mjs')
const slash = (path: string) => (process.platform === 'win32' ? path.replace(/\\/g, '/') : path)
const quote = (path: string) => `"${slash(path)}"`

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === 'compose' && rest[0]) return compose(rest[0])
  if (command === 'hook') return hook(rest[0] ?? '')
  if (command === 'codex') return launch(rest)
  if (command === 'setup') return setup()
  if (command === 'status') return status()
  process.stdout.write('margincue setup | codex [args] | compose FILE | hook prompt|stop|start | status\n')
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

/** Codex picks its ctrl+g editor from VISUAL alone: this runs Codex with the composer there, and the person's editor behind ctrl+e. */
function launch(args: string[]): void {
  const own = process.env['MARGINCUE_EDITOR'] || process.env['VISUAL'] || process.env['EDITOR'] || ''
  const visual = `${quote(process.execPath)} ${quote(existsSync(STABLE) ? STABLE : SELF)} compose`
  const child = spawn('codex', args, {
    stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, VISUAL: visual, ...(own && !own.includes('margincue') && { MARGINCUE_EDITOR: own }) },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (error) => {
    process.stderr.write(`margincue: could not start codex (${error.message}). Is Codex CLI installed?\n`)
    process.exit(1)
  })
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
  const codex = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (codex.status !== 0) {
    say('Codex CLI was not found. Install it first: npm install -g @openai/codex')
    rl.close()
    return
  }
  say(`1. The plugin (hooks that let you switch the agent's choices during a turn, and the receipt after it).`)
  const added = spawnSync('codex', ['plugin', 'marketplace', 'add', 'fus3r/margincue'], { encoding: 'utf8', shell: process.platform === 'win32' })
  const installed = spawnSync('codex', ['plugin', 'add', 'margincue@margincue'], { encoding: 'utf8', shell: process.platform === 'win32' })
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
  say('3. The card while you type: Codex opens MarginCue on ctrl+g when started through it.')
  const line = aliasLine()
  if (line) {
    const answer = ((await rl.question(`   Add this to ${line.file}?\n     ${line.text}\n   [Y/n] `)) ?? 'n').trim().toLowerCase()
    if (answer === '' || answer === 'y' || answer === 'yes') {
      appendFileSync(line.file, `\n# MarginCue: Codex opens the MarginCue composer on ctrl+g\n${line.text}\n`)
      say('   Added. Open a new terminal, run codex, and press ctrl+g in the prompt.')
    } else say(`   Not added. Start Codex with: node ${quote(STABLE)} codex`)
  }
  rl.close()
}

function aliasLine(): { file: string; text: string } | null {
  // `node` from PATH, not this process's path: a versioned install path breaks on the next Node upgrade.
  const run = `node ${quote(STABLE)}`
  if (process.platform === 'win32') {
    const profile = join(homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    mkdirSync(join(homedir(), 'Documents', 'PowerShell'), { recursive: true })
    return { file: profile, text: `function codex { & ${run} codex @args }` }
  }
  const shell = process.env['SHELL'] ?? ''
  if (shell.endsWith('fish')) return { file: join(homedir(), '.config', 'fish', 'config.fish'), text: `function codex; ${run} codex $argv; end` }
  const file = shell.endsWith('zsh') ? join(homedir(), '.zshrc') : join(homedir(), '.bashrc')
  return { file, text: `alias codex='${run} codex'` }
}

function status(): void {
  const settings = readSettings()
  process.stdout.write([
    `MarginCue for Codex: ${settings.mode ?? 'auto'} · sketch ${settings.sketch === false ? 'off' : 'on'} · blanks ${settings.blanks === false ? 'off' : 'on'}`,
    settings.user ? `You: ${describeUser(settings.user)}` : 'You: not set up yet (margincue setup asks a few questions).',
    `Composer: ${existsSync(STABLE) ? STABLE : 'not installed (margincue setup)'}`,
  ].join('\n') + '\n')
}

void main(process.argv.slice(2))

// What MarginCue keeps for Codex, under ~/.margincue: the person's settings and first-run
// answers, the picks it learned per project, and the turn the hooks saw last (so the
// composer can show the agent's choices during and after a turn).

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UserProfile } from '../../claude-code/hooks/onboarding'

export const HOME = process.env['MARGINCUE_HOME'] ?? join(homedir(), '.margincue')

export const PATHS = {
  settings: join(HOME, 'settings.json'),
  learned: join(HOME, 'learned.json'),
  turn: join(HOME, 'codex', 'turn.json'),
  /** The last prompt the composer handed back: its card was seen before sending. */
  composed: join(HOME, 'codex', 'composed.json'),
  bin: join(HOME, 'bin'),
}

export type Settings = {
  mode?: 'auto' | 'on' | 'quiet' | 'off'
  sketch?: boolean
  refs?: boolean
  blanks?: boolean
  user?: UserProfile
  onboarded?: 'done' | 'skipped'
}

/** A Codex turn as the hooks saw it. */
export type TurnRecord = {
  session: string
  turn: string
  transcript: string
  cwd: string
  startedAt: number
  endedAt: number | null
  /** The Decisions the prompt carried. */
  decisions: string[]
  source: Source
}
export type Source = 'cli' | 'app' | 'ide' | 'exec' | 'unknown'

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Written whole or not at all: a temp file renamed over the old one. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

export const readSettings = () => readJson<Settings>(PATHS.settings, {})
export const saveSettings = (settings: Settings) => writeJson(PATHS.settings, settings)

export type Learned = Record<string, { label: string; count: number }>

export function readLearned(root: string): Learned {
  return readJson<Record<string, Learned>>(PATHS.learned, {})[root] ?? {}
}

export function learn(root: string, key: string, label: string): void {
  const all = readJson<Record<string, Learned>>(PATHS.learned, {})
  const mine = all[root] ?? {}
  const prior = mine[key]
  mine[key] = { label, count: prior?.label === label ? prior.count + 1 : 1 }
  all[root] = mine
  writeJson(PATHS.learned, all)
}

// ---- Codex sessions ------------------------------------------------------------------

/** Where a Codex session runs, from the first line of its session file. */
export function sessionSource(transcript: string): Source {
  const head = readHead(transcript, 64 * 1024)
  const first = head.split('\n', 1)[0] ?? ''
  try {
    const meta = (JSON.parse(first) as { payload?: { originator?: string; source?: string } }).payload ?? {}
    const originator = meta.originator ?? ''
    if (/desktop/i.test(originator)) return 'app'
    if (meta.source === 'exec' || /exec/i.test(originator)) return 'exec'
    if (/tui|cli/i.test(originator) || meta.source === 'cli') return 'cli'
    if (meta.source === 'vscode') return 'ide'
  } catch {}
  return 'unknown'
}

/** The agent's messages in one turn of a Codex session file (its last 4 MiB is enough for a turn). */
export function turnMessages(transcript: string, turn: string): string[] {
  const out: string[] = []
  for (const line of readTail(transcript, 4 * 1024 * 1024).split('\n')) {
    if (!line.includes('AgentMessage') || !line.includes(turn)) continue
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string; item?: { type?: string; content?: { text?: string }[] } } }
      const payload = entry.payload
      if (entry.type !== 'event_msg' || payload?.type !== 'item_completed' || payload.turn_id !== turn) continue
      if (payload.item?.type !== 'AgentMessage') continue
      const text = (payload.item.content ?? []).map((part) => part.text ?? '').join('')
      if (text) out.push(text)
    } catch {}
  }
  return out
}

function readHead(file: string, bytes: number): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const n = readSync(fd, buffer, 0, bytes, 0)
      return buffer.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function readTail(file: string, bytes: number): string {
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const start = Math.max(0, size - bytes)
      const buffer = Buffer.alloc(size - start)
      const n = readSync(fd, buffer, 0, buffer.length, start)
      const text = buffer.subarray(0, n).toString('utf8')
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

// ---- the engine's process call, for the project index ------------------------------

type Run = { exitCode: number; stdout: string; stderr: string }

/** `$.process.run` as hooks/repo-index.ts uses it, on Node. */
export const processEngine = {
  process: {
    run: (argv: string[], options: { cwd: string; timeoutMs?: number }): Promise<Run> => new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= 32 * 1024 * 1024) out.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      })
    }),
  },
}

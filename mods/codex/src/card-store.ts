// A desktop card's life on disk, shared by three processes: the prompt hook creates it the moment
// the person presses Enter, a detached reader fills it in as Codex streams the reading (then draws
// the first preview), and the MCP server hands it to the widget, which follows it until it is done.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedSketch } from '../../claude-code/core/card'
import { HOME } from './store'
import type { CardState, SketchState, WidgetCard } from './widget-message'

export const CARDS = join(HOME, 'codex', 'cards')
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const POLL_MS = 80

export type CardRecord = {
  id: string
  prompt: string
  cwd: string
  at: number
  /** Raised on every write, so a reader can wait for anything newer than what it has. */
  version: number
  state: CardState
  card: WidgetCard
  sketchState: SketchState
  sketch: ParsedSketch | null
  /** What the preview prompt needs besides the card: names found in the code, and the date. */
  names: string[]
  today?: string
  /** The process filling the card in; a dead one means the card will not progress. */
  pid?: number
}

export const isCardId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(id)
const fileOf = (id: string) => join(CARDS, `${id}.json`)

export function emptyCard(id: string, prompt: string): WidgetCard {
  return { id, prompt, reading: null, rows: [], missing: [], preview: false, sketch: null }
}

export function readRecord(id: string): CardRecord | null {
  if (!isCardId(id)) return null
  try {
    const record = JSON.parse(readFileSync(fileOf(id), 'utf8')) as CardRecord
    return record?.id === id ? settle(record) : null
  } catch {
    return null
  }
}

/** Written whole or not at all, so a reader never sees half a card. */
export function writeRecord(record: CardRecord): void {
  mkdirSync(CARDS, { recursive: true })
  const temp = `${fileOf(record.id)}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(record))
  renameSync(temp, fileOf(record.id))
}

export function updateRecord(id: string, change: (record: CardRecord) => void): CardRecord | null {
  const record = readRecord(id)
  if (!record) return null
  change(record)
  record.version++
  writeRecord(record)
  return record
}

/** Resolves with the record once it is newer than `after`, or as it is when `ms` runs out. */
export async function waitForRecord(id: string, after: number, ms: number): Promise<CardRecord | null> {
  const until = Date.now() + ms
  for (;;) {
    const record = readRecord(id)
    if (!record || record.version > after || Date.now() >= until) return record
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** A record whose writer died mid-way is finished as failed, so nobody waits on it. */
function settle(record: CardRecord): CardRecord {
  if (record.pid === undefined || (record.state !== 'reading' && record.sketchState !== 'drawing') || alive(record.pid)) return record
  if (record.state === 'reading') record.state = 'failed'
  if (record.sketchState === 'drawing') record.sketchState = 'failed'
  return record
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Creates the card and starts reading it in a detached process, so the reading runs while the agent is
 * still deciding to call the tool. Returns the card's id, or null when the reader could not start.
 */
export function startCard(prompt: string, cwd: string, extra: Partial<CardRecord> = {}): string | null {
  const id = randomBytes(6).toString('base64url')
  const record: CardRecord = {
    id, prompt, cwd, at: Date.now(), version: 1, state: 'reading', card: emptyCard(id, prompt),
    sketchState: 'none', sketch: null, names: [], ...extra,
  }
  try {
    writeRecord(record)
    const entry = process.env['MARGINCUE_ENTRY'] ?? fileURLToPath(import.meta.url)
    const child = spawn(process.execPath, [entry, 'prefetch', id], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => updateRecord(id, (card) => { card.state = 'failed' }))
    child.unref()
    // The reader also records itself; this covers a reader that dies before it can.
    if (child.pid !== undefined) updateRecord(id, (card) => { card.pid ??= child.pid })
    pruneCards()
    return id
  } catch {
    return null
  }
}

/** Cards older than a week are of no use: their thread has moved on. */
export function pruneCards(now = Date.now()): void {
  try {
    for (const name of readdirSync(CARDS)) {
      const file = join(CARDS, name)
      try {
        if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file)
      } catch {}
    }
  } catch {}
}

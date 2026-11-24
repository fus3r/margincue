// The agent's own choices in the turn the hooks saw last. During the turn they are switches:
// switching one writes an amendment, which Enter in Codex sends into the running turn. After
// the turn, switching one writes the follow-up prompt. Shared by the card under the prompt
// (band.ts) and the ctrl+g composer.

import { parseBlanks } from '../../claude-code/core/card'
import type { ParsedBlank } from '../../claude-code/core/card'
import type { MargincueCard, MargincueRow } from '../../claude-code/types'
import { PATHS, readJson, turnMessages } from './store'
import type { TurnRecord } from './store'

/** A turn this recent still has its choices on offer. */
export const RECENT_MS = 30 * 60 * 1000

export type Agent = {
  running: boolean
  blanks: ParsedBlank[]
  picked: number[]
  focus: number
  /** The text the switches ask for now ('' while every choice is the agent's). */
  text: string
  turn: string
}

/** The last turn on this project with marked choices, if it is running or recent. */
export function readTurn(cwd: string, now = Date.now()): Agent | null {
  const turn = readJson<TurnRecord | null>(PATHS.turn, null)
  if (!turn || turn.cwd !== cwd) return null
  const running = turn.endedAt === null
  if (!running && now - (turn.endedAt ?? 0) > RECENT_MS) return null
  const seen = new Map<string, ParsedBlank>()
  for (const message of turnMessages(turn.transcript, turn.turn)) for (const blank of parseBlanks(message)) seen.set(blank.label, blank)
  const blanks = [...seen.values()]
  if (!blanks.length) return null
  return { running, blanks, picked: blanks.map(() => 0), focus: 0, text: '', turn: turn.turn }
}

/** A newer reading of the same turn keeps the person's picks for the choices it still has. */
export function mergeTurn(before: Agent | null, after: Agent | null): Agent | null {
  if (!before || !after || before.turn !== after.turn) return after
  const picks = new Map(before.blanks.map((blank, i) => [blank.label, before.picked[i] ?? 0]))
  const picked = after.blanks.map((blank) => Math.min(picks.get(blank.label) ?? 0, blank.alternatives.length))
  const focused = before.blanks[before.focus]?.label
  const focus = Math.max(0, after.blanks.findIndex((blank) => blank.label === focused))
  return { ...after, picked, focus, text: before.text }
}

export function agentCard(state: Agent): MargincueCard {
  const rows: MargincueRow[] = state.blanks.map((blank, i) => ({
    id: `a${i}`, key: `agent_${i}`, label: blank.label, type: 'one', statement: `${blank.label}: {}`,
    options: [blank.choice, ...blank.alternatives], defaults: [0], selected: [state.picked[i] ?? 0],
    chosen: (state.picked[i] ?? 0) !== 0, origin: 'agent',
  }))
  return {
    id: 1, stage: state.running ? 'turn' : 'after', reading: false, error: false, read: null, kind: null, rows,
    focus: rows[state.focus]?.id ?? null, mentions: [], language: 'en', collapsed: false,
  }
}

/** Sets row `row` to `option` (or the next one) and returns the text that asks for the picks. */
export function pick(state: Agent, row: number, option: number | 'next'): string {
  const blank = state.blanks[row]
  if (!blank) return state.text
  const count = blank.alternatives.length + 1
  state.picked[row] = option === 'next' ? ((state.picked[row] ?? 0) + 1) % count : Math.min(option, count - 1)
  state.focus = row
  const lines = state.blanks.flatMap((b, i) => {
    const picked = state.picked[i] ?? 0
    if (picked === 0) return []
    const value = b.alternatives[picked - 1]!
    return state.running
      ? [`Amendment to my last prompt: for ${b.label}, use ${value} instead of ${b.choice}.`]
      : [`Change ${b.label}: ${value} instead of ${b.choice}.`]
  })
  state.text = lines.length ? (state.running ? lines.join('\n') : `${lines.join(' ')} Keep everything else as it is.`) : ''
  return state.text
}

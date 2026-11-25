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
  /** Each row's value now, as an index into [choice, ...alternatives]. */
  picked: number[]
  /** The value the turn already has: the agent's choice, or what the person's amendment asked for. */
  sent: number[]
  /** The person set this row's value with an amendment. */
  mine: boolean[]
  focus: number
  /** The text the switches ask for now ('' while nothing differs from what the turn has). */
  text: string
  turn: string
}

const AMENDMENT = /^Amendment to my last prompt: for (.+?), use (.+?) instead of (.+?)\.$/

/** What the person's amendments in the turn asked for, by row label (the last one wins). */
export function turnAmendments(messages: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const message of messages) {
    for (const line of message.split('\n')) {
      const match = AMENDMENT.exec(line.trim())
      if (match) out.set(match[1]!.trim().toLowerCase(), match[2]!.trim())
    }
  }
  return out
}

const options = (blank: ParsedBlank) => [blank.choice, ...blank.alternatives]
const indexOf = (blank: ParsedBlank, value: string | undefined) =>
  value === undefined ? -1 : options(blank).findIndex((option) => option.toLowerCase() === value.toLowerCase())

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
  const amended = turnAmendments(turnMessages(turn.transcript, turn.turn, 'UserMessage'))
  const sent = blanks.map((blank) => Math.max(0, indexOf(blank, amended.get(blank.label.toLowerCase()))))
  const mine = blanks.map((blank) => indexOf(blank, amended.get(blank.label.toLowerCase())) >= 0)
  return { running, blanks, picked: [...sent], sent, mine, focus: 0, text: '', turn: turn.turn }
}

/**
 * A newer reading of the same turn. The person's switches not sent yet stay; what was sent stays
 * too until the transcript shows it (Codex writes the amendment a moment after Enter).
 */
export function mergeTurn(before: Agent | null, after: Agent | null): Agent | null {
  if (!before || !after || before.turn !== after.turn) return after
  const value = (agent: Agent, i: number, at: number[]) => options(agent.blanks[i]!)[at[i] ?? 0]
  const unsent = new Map<string, string>()
  const sentBefore = new Map<string, string>()
  before.blanks.forEach((blank, i) => {
    if ((before.picked[i] ?? 0) !== (before.sent[i] ?? 0)) unsent.set(blank.label, value(before, i, before.picked)!)
    if (before.mine[i]) sentBefore.set(blank.label, value(before, i, before.sent)!)
  })
  const sent = after.blanks.map((blank, i) => after.mine[i] ? after.sent[i]! : Math.max(0, indexOf(blank, sentBefore.get(blank.label))))
  const mine = after.blanks.map((blank, i) => Boolean(after.mine[i]) || indexOf(blank, sentBefore.get(blank.label)) >= 0)
  const picked = after.blanks.map((blank, i) => {
    const at = indexOf(blank, unsent.get(blank.label))
    return at >= 0 ? at : sent[i]!
  })
  const focused = before.blanks[before.focus]?.label
  const focus = Math.max(0, after.blanks.findIndex((blank) => blank.label === focused))
  return { ...after, picked, sent, mine, focus, text: before.text }
}

/** The amendment went into the turn: what it asked for is now what the turn has. */
export function markSent(state: Agent): void {
  state.mine = state.picked.map((picked, i) => picked !== (state.sent[i] ?? 0) || Boolean(state.mine[i]))
  state.sent = [...state.picked]
  state.text = ''
}

export function agentCard(state: Agent): MargincueCard {
  const rows: MargincueRow[] = state.blanks.map((blank, i) => ({
    id: `a${i}`, key: `agent_${i}`, label: blank.label, type: 'one', statement: `${blank.label}: {}`,
    options: options(blank), defaults: [0], selected: [state.picked[i] ?? 0],
    chosen: (state.picked[i] ?? 0) !== 0 || Boolean(state.mine[i]), origin: 'agent',
  }))
  return {
    id: 1, stage: state.running ? 'turn' : 'after', reading: false, error: false, read: null, kind: null, rows,
    focus: rows[state.focus]?.id ?? null, mentions: [], language: 'en', collapsed: false,
  }
}

/** Sets row `row` to `option` (or the next one) and returns the text that asks for what differs from the turn. */
export function pick(state: Agent, row: number, option: number | 'next'): string {
  const blank = state.blanks[row]
  if (!blank) return state.text
  const count = blank.alternatives.length + 1
  state.picked[row] = option === 'next' ? ((state.picked[row] ?? 0) + 1) % count : Math.min(option, count - 1)
  state.focus = row
  const lines = state.blanks.flatMap((b, i) => {
    const picked = state.picked[i] ?? 0
    const sent = state.sent[i] ?? 0
    if (picked === sent) return []
    const value = options(b)[picked]!
    const was = options(b)[sent]!
    return state.running
      ? [`Amendment to my last prompt: for ${b.label}, use ${value} instead of ${was}.`]
      : [`Change ${b.label}: ${value} instead of ${was}.`]
  })
  state.text = lines.length ? (state.running ? lines.join('\n') : `${lines.join(' ')} Keep everything else as it is.`) : ''
  return state.text
}

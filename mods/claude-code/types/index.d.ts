// The values margincue keeps in $.state: what its band draws.

/** One cue as the band shows it (no draft text beyond the anchor). */
export type MargincueCue = {
  id: string
  anchor: string
  statement: string
  options: string[]
  chosen: number | string | null
  /** Picked while stale; applied once a reply for the current text confirms the cue. */
  pending: number | string | null
  stale: boolean
  provisional: boolean
}

export type MargincueScope = 'user' | 'model' | 'project' | 'session'

export type MargincueMark = { slot: string; label: string; value: string }
export type MargincueStateCue = {
  slot: string
  label: string
  statement: string
  options: { id: string; label: string }[]
  scope: MargincueScope
  guard: boolean
  why: string
  source: string
}
export type MargincueExpert = {
  id: number
  profile: string
  phase: 'reviewing' | 'ready' | 'error'
  items: (MargincueStateCue & { key: string; persistent: boolean; defaultIndex?: number; chosen?: string })[]
  language: 'en' | 'fr'
  model: boolean
}

export type MargincueMention = {
  phrase: string
  start: number
  end: number
  status: 'found' | 'missing'
  match?: string
  kind?: 'symbol' | 'name' | 'path'
  files: string[]
  near: { name: string; file: string }[]
}

export type MargincueRow = {
  id: string
  key: string
  label: string
  type: 'one' | 'many' | 'range'
  statement: string
  options: string[]
  defaults: number[]
  selected: number[]
  chosen: boolean
  origin: 'model' | 'repo' | 'lens' | 'agent'
  unit?: string
  lens?: string
  learned?: true
  openOnSend?: true
  start?: number
  end?: number
}

export type MargincueCard = {
  id: number
  stage: 'draft' | 'turn' | 'after'
  reading: boolean
  awaitingRead?: boolean
  error: boolean
  read: string | null
  kind: 'build' | 'change' | 'fix' | 'explore' | 'ask' | 'other' | null
  rows: MargincueRow[]
  focus: string | null
  mentions: MargincueMention[]
  chapter?: { title: string; choice: string; notes: string; expanded: boolean; page: number }
  sketch?: { title: string; lines: string[]; drawing: boolean; pinned: boolean; open: boolean }
  language: 'en' | 'fr'
  collapsed: boolean
  pickedOnly?: true
}

export type MargincueReceipt = {
  id: number
  yours: string[]
  agent: { label: string; value: string; was?: string; options: string[] }[]
}

export type MargincueBand = {
  enabled: boolean
  phase: 'off' | 'idle' | 'reviewing' | 'error'
  profile: string
  /** The draft is not empty (the band shows its quiet row). Held cues are left out of `cues`. */
  hasDraft: boolean
  cues: MargincueCue[]
  focus: string | null
  latencyMs: number | null
  note: string | null
  mode?: 'off' | 'quiet' | 'on' | 'auto'
  language?: 'en' | 'fr'
  depth?: 'essentials' | 'standard' | 'research'
  marks?: MargincueMark[]
  first?: MargincueStateCue | null
  open?: number
  amendment?: MargincueCue
  canReadCard?: boolean
  card?: MargincueCard
  reviewPending?: boolean
  canReview?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    margincue: { band: MargincueBand | null; expert: MargincueExpert | null }
  }
}

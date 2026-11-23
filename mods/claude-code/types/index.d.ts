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
  items: (MargincueStateCue & { key: string; persistent: boolean; chosen?: string })[]
  language: 'en' | 'fr'
  model: boolean
}

export type MargincueSheet = {
  id: number
  items: (Pick<MargincueCue, 'id' | 'statement' | 'options'> & { chosen: number | null; pending: number | null })[]
  pending: boolean
  focus: string | null
  language: 'en' | 'fr'
  collapsed: boolean
  afterSubmit: boolean
  pane?: { item: string; position: number; total: number; canGoBack: boolean }
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
  sheet?: MargincueSheet
  reviewPending?: boolean
  canReview?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    margincue: { band: MargincueBand | null; expert: MargincueExpert | null }
  }
}

// MarginCue core: the shapes that cross the boundary between a host and the core.
// Everything here is plain JSON data. Offsets are UTF-16 code units; times are
// milliseconds from the host's monotonic clock.

import type { Depth, Language, Mode, ProfileBundle, Scope } from './bundle'
import type { DecisionView, StateChange, StateCue, StateLoad } from './state'

export type Origin = 'type' | 'paste' | 'history' | 'fill' | 'open' | 'restore'
export type LanguageSetting = 'en' | 'auto'

/** One edit: `text` replaced the code units `[start, end)` of the previous draft. */
export type Splice = { start: number; end: number; text: string }

export type Timing = {
  /** Review after this long without an edit. */
  idleMs: number
  /** Never fire two typing-driven reviews closer than this. */
  minGapMs: number
  /** A cue in the unterminated last sentence is held until the draft has rested this long. */
  settleMs: number
  /** ...or until the text runs this many code units past the cue's anchor. */
  holdChars: number
  /** Reviews in flight at once; one more cancels the oldest. */
  maxInflight: number
  /** No review below this many characters (trimmed)... */
  minChars: number
  /** ...or this many words. */
  minWords: number
  planMaxTokens: number
  fullMaxTokens: number
  /** Entries in the LRU of reviewed texts. */
  cacheSize: number
}

export type Event =
  | {
      type: 'config'
      enabled: boolean
      mode?: Mode
      depth?: Depth
      language?: LanguageSetting
      /** Present for the sheet protocol. False keeps the automatic review tier silent. */
      sheet?: boolean
      audit?: boolean
      profile: string
      timing?: Partial<Timing>
      streaming: boolean
      eagerPlan: boolean
    }
  | { type: 'draft'; now: number; text: string; origin: Origin; edit?: Splice; cursor?: number }
  | { type: 'timer'; now: number }
  | { type: 'reply'; now: number; req: number; text: string; done: boolean; ok?: boolean }
  | { type: 'pick'; now: number; cue: string; option: number | string | null; cycle?: true }
  | { type: 'dismiss'; now?: number; cue: string }
  | { type: 'acceptAll'; now?: number }
  | { type: 'focus'; dir?: 1 | -1; cue?: string }
  | { type: 'submit'; now: number; text: string; amendable?: boolean }
  | { type: 'loadState'; now: number; state: StateLoad }
  | { type: 'set'; now: number; at?: number; slot: string; option: string; scope?: Scope; text?: string }
  | { type: 'delegate'; now: number; at?: number; slot: string; scope?: Scope }
  | { type: 'forget'; now: number; slot: string; scope?: Scope }
  | { type: 'sessionReset'; now: number }
  | { type: 'review'; now: number; profile?: string }
  | { type: 'expertPick'; now: number; at?: number; review: number; key: string; option: string; scope?: Scope }
  | { type: 'amend'; now: number; cue: string; option: number }
  | { type: 'turnStart'; now: number }
  | { type: 'endAmendment'; now: number }
  | { type: 'sheetPane'; id: number; move: 'open' | 'close' | 'skip' | 'back'; cue?: string }
  | { type: 'sheetAnswer'; now: number; id: number; cue: string; option: number; via: 'pane' | 'composer' }
  | { type: 'sheetShown'; now: number; id: number }

export type Chosen = null | number | string

/** A cue as the view shows it. `start`/`end` are absent for a global cue. */
export type CueView = {
  id: string
  start?: number
  end?: number
  anchor: string
  statement: string
  options: string[]
  chosen: Chosen
  /** A pick made while the cue was stale, applied once a reply for the current text confirms the cue. */
  pending: Chosen
  stale: boolean
  provisional: boolean
  /** Still being written: in the unterminated last sentence, near the caret. Hosts do not draw held cues. */
  held: boolean
}

export type Phase = 'off' | 'idle' | 'reviewing' | 'error'

export type View = {
  enabled: boolean
  profile: string
  phase: Phase
  /** The draft the spans refer to. */
  text: string
  cues: CueView[]
  focus: string | null
  /** Last keystroke to the last applied complete reply, for the last review; null before any. */
  latencyMs: number | null
  /** The lines `submit` would attach now. */
  decisions: string[]
  /** A short message for the band (a pick that could not be applied), until the next edit or pick. */
  note: string | null
  state?: DecisionView
  expert?: ExpertView
  amendment?: CueView
  sheet?: SheetView
}

export type SheetItem = Pick<CueView, 'id' | 'statement' | 'options'> & { chosen: number | null; pending: number | null }
export type SheetView = {
  id: number
  items: SheetItem[]
  pending: boolean
  focus: string | null
  language: Language
  collapsed: boolean
  afterSubmit: boolean
  pane?: { item: string; position: number; total: number; canGoBack: boolean }
}

export type ExpertItem = StateCue & {
  key: string
  persistent: boolean
  chosen?: string
}
export type ExpertView = { id: number; profile: string; phase: 'reviewing' | 'ready' | 'error'; items: ExpertItem[] }

export type Effect =
  | {
      type: 'request'
      req: number
      kind: 'full' | 'plan' | 'expert' | 'sheet'
      tier?: 'cloud'
      system: string[]
      prompt: string
      maxTokens: number
    }
  | { type: 'cancel'; req: number }
  | { type: 'timer'; at: number | null }
  | { type: 'view'; view: View }
  | { type: 'submit'; text: string; decisions: string[] }
  | ({ type: 'persist' } & StateChange)
  | { type: 'amend'; text: string; cue: string; option: number; ms: number }
  | ({ type: 'metric'; name: string } & Record<string, unknown>)

/** The data the core turns into requests: prompts/system.md and profiles/*.md, as text. */
export type Assets = {
  system: string
  /** Profile Markdown keyed by name. */
  profiles: Record<string, string>
  bundles?: ProfileBundle[]
  personalProfiles?: string[]
  expertSystem?: string
  sheetSystem?: string
}

export type Example = { draft: string; output: string; status?: 'complete' | 'incomplete' }

export type Profile = {
  name: string
  description: string
  maxCues: number
  rubric: string
  examples: Example[]
}

/** One cue line of a reply, before anchor resolution. `anchor` null: global. */
export type ParsedCue = { anchor: string | null; statement: string; options: string[] }

export type ParsedReply = {
  /** Anchors of the plan line; null when the reply has no plan line (yet). */
  plan: string[] | null
  /** The plan line was NONE. */
  none: boolean
  cues: ParsedCue[]
}

export type Decision = { statement: string; option: string; question?: true }

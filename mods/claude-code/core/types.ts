// MarginCue core: the shapes that cross the boundary between a host and the core.
// Everything here is plain JSON data. Offsets are UTF-16 code units; times are
// milliseconds from the host's monotonic clock.

import type { Depth, Language, Mode, ProfileBundle, Scope } from './bundle'
import type { CardKind, RowType } from './card'
import type { ProfileChapter } from './chapters'
import type { Mention, Vocabulary } from './grounding'
import type { DecisionView, StateChange, StateCue, StateLoad } from './state'

export type Origin = 'type' | 'paste' | 'history' | 'fill' | 'open' | 'restore'
export type LanguageSetting = 'en' | 'auto'
export type SendSetting = 'all' | 'picked' | 'open'
export const DEFAULT_SEND: SendSetting = 'open'
export type ReadingMode = 'auto' | 'key'
export type ReviewMode = 'auto' | 'off'

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
      /** Present for the card protocol (named `sheet` before the card replaced the kick-off sheet). False keeps the automatic tier silent. */
      sheet?: boolean
      /** When to read a draft card (default auto). */
      read?: ReadingMode
      /** Run the chapter review alongside eligible draft cards (default off). */
      review?: ReviewMode
      /** Draw a sketch of the deliverable under the card (default true). */
      sketch?: boolean
      /** Attach where the draft's names live in the code (default true). */
      refs?: boolean
      /** How untouched choices travel (default open). */
      send?: SendSetting
      /** One line about the person (their work, level per field, what they decide), from the first-run interview. */
      user?: string
      /** The local date (YYYY-MM-DD), so a sketch's sample dates look like this week's. */
      today?: string
      /** Profiles the person works in: a project needs less evidence to call for these. */
      prefer?: string[]
      /** Depth per profile, from the person's level in that field; `depth` applies to the rest. */
      depths?: Record<string, Depth>
      audit?: boolean
      profile: string
      /** The default general profile counts as selected only when the person chose it. */
      profileSelected?: boolean
      timing?: Partial<Timing>
      streaming: boolean
      eagerPlan: boolean
    }
  /** `atEnter`: the host can show the draft's card while holding the prompt at Enter. */
  | { type: 'draft'; now: number; text: string; origin: Origin; edit?: Splice; cursor?: number; atEnter?: boolean; afterEnter?: true }
  | { type: 'timer'; now: number }
  | { type: 'reply'; now: number; req: number; text: string; done: boolean; ok?: boolean }
  | { type: 'pick'; now: number; cue: string; option: number | string | null; cycle?: true }
  | { type: 'dismiss'; now?: number; cue: string }
  | { type: 'acceptAll'; now?: number }
  | { type: 'focus'; dir?: 1 | -1; cue?: string }
  /** `plan: false`: only explicit picks bind (the person was asked each choice in turn). */
  | { type: 'submit'; now: number; text: string; amendable?: boolean; plan?: boolean }
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
  /** The project's names, collected by the host; null when there is no index. */
  | { type: 'vocabulary'; vocab: Vocabulary | null }
  /** Options the person picked before, per row key, with how often. */
  | { type: 'learned'; picks: Record<string, { label: string; count: number }> }
  | { type: 'cardRead'; now: number }
  | { type: 'cardKeep'; now: number }
  /** alt+up: the next row; a click: that row. */
  | { type: 'cardFocus'; dir?: 1 | -1; row?: string }
  /** alt+down: the focused (or named) row's next value. */
  | { type: 'cardCycle'; now: number; row?: string; dir?: 1 | -1 }
  /** A number key or a click: select option `option` (a pick-any row toggles it). */
  | { type: 'cardSet'; now: number; row: string; option: number }
  /** The person's own words for a row, typed under "Other" in the app's question panel: they go as its Decision. */
  | { type: 'cardSay'; now: number; row: string; text: string }
  | { type: 'cardDismiss'; now: number; row: string }
  | { type: 'cardShown'; now: number; id: number }
  | { type: 'sketch'; now: number; action: 'toggle' | 'pin' | 'refresh' }
  /** A choice the agent marked in its reply during the running turn. */
  | { type: 'blank'; now: number; label: string; choice: string; alternatives: string[] }

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
  canReadCard?: boolean
  card?: CardView
  receipt?: ReceiptView
}

/**
 * One row of the card. `selected` is what the row reads now: the person's pick,
 * else an earlier habit, else the default. `chosen` records a pick on this card.
 */
export type CardRowView = {
  id: string
  key: string
  label: string
  type: RowType
  statement: string
  options: string[]
  defaults: number[]
  selected: number[]
  chosen: boolean
  origin: 'model' | 'repo' | 'lens' | 'agent'
  unit?: string
  lens?: string
  learned?: true
  /** The untouched default will travel as a question. */
  openOnSend?: true
  start?: number
  end?: number
}

/** Before Enter (`draft`), during the turn (`turn`, the agent's own choices), after it (`after`). */
export type CardStage = 'draft' | 'turn' | 'after'

export type CardView = {
  id: number
  stage: CardStage
  /** A reading is on its way (the first, or a newer one for an edited draft). */
  reading: boolean
  /** This draft is waiting for the reading shortcut. */
  awaitingRead?: boolean
  error: boolean
  read: string | null
  kind: CardKind | null
  rows: CardRowView[]
  focus: string | null
  mentions: Mention[]
  /** Expert profiles this reading draws on: the project's, the one picked, the draft's field. */
  lenses: string[]
  sketch?: { title: string; lines: string[]; drawing: boolean; pinned: boolean; open: boolean }
  language: Language
  collapsed: boolean
  pickedOnly?: true
}

export type ReceiptView = {
  id: number
  yours: string[]
  agent: { label: string; value: string; was?: string; options: string[] }[]
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
      kind: 'full' | 'plan' | 'expert' | 'card' | 'sketch'
      tier?: 'cloud'
      system: string[]
      prompt: string
      maxTokens: number
      /** The sketch is for a card shown at Enter. */
      atEnter?: true
    }
  | { type: 'cancel'; req: number }
  | { type: 'timer'; at: number | null }
  | { type: 'view'; view: View }
  | { type: 'submit'; text: string; decisions: string[] }
  | ({ type: 'persist' } & StateChange)
  | { type: 'amend'; text: string; cue: string; option: number; ms: number }
  /** Put a follow-up prompt in the empty composer; `replaces` is the earlier fill it may overwrite. */
  | { type: 'fill'; text: string; replaces: string | null }
  /** Remember a pick for this project (counted, so a habit shows after two). */
  | { type: 'learn'; key: string; label: string }
  | ({ type: 'metric'; name: string } & Record<string, unknown>)

/** The data the core turns into requests: prompts/system.md and profiles/*.md, as text. */
export type Assets = {
  system: string
  /** Profile Markdown keyed by name. */
  profiles: Record<string, string>
  chapters?: ProfileChapter[]
  bundles?: ProfileBundle[]
  personalProfiles?: string[]
  expertSystem?: string
  sheetSystem?: string
  cardSystem?: string
  sketchSystem?: string
  blanksProtocol?: string
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

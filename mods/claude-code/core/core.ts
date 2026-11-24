import { diffSplice, resolveAnchor, shiftSpan, spliceFits } from './anchor'
import type { Span } from './anchor'
import { applyDecisions, attachDecisions, decisionLine } from './decisions'
import { DecisionDraft, DecisionState, decisionFor, eligibleSlot, stateCue } from './state'
import type { SlotResult, StateChange } from './state'
import type { Depth, Language, Mode, Rigor, Scope } from './bundle'
import { expertPrompt, MAX_EXPERT_CUES, parseExpert } from './expert'
import { Lru } from './lru'
import { normalize, parseReply } from './parse'
import { parseProfile } from './profile'
import { buildPrompt, buildSystem, isTerminated, lastSentenceStart } from './request'
import { CARD_MAX_TOKENS, cycleSelection, parseCard, parseSketch, rowValue, sameSelection, SKETCH_MAX_TOKENS, toggleSelection } from './card'
import type { CardKind, ParsedCard, ParsedRow, ParsedSketch, RowType } from './card'
import { ground, indexVocabulary, nameKey, relatedFolders } from './grounding'
import type { GroundIndex, Mention } from './grounding'
import { detectLenses } from './project'
import type { ProjectLens } from './project'
import type {
  Assets,
  CardRowView,
  CardStage,
  CardView,
  Chosen,
  CueView,
  Decision,
  Effect,
  Event,
  ExpertItem,
  ExpertView,
  LanguageSetting,
  Origin,
  ParsedCue,
  Profile,
  ReceiptView,
  Splice,
  Timing,
  View,
} from './types'

// The MarginCue core: a deterministic state machine, handle(event) -> effects.
// No clock, no I/O, no host types. Every time comes in on an event.
//
// Effects of one handle() call come in the order the work happened (cancel,
// request, submit, metric), then at most one `timer` (when the wanted wake-up
// changed), then at most one `view` (when anything visible changed).

export const DEFAULT_TIMING: Timing = {
  idleMs: 280,
  minGapMs: 300,
  settleMs: 700,
  holdChars: 16,
  maxInflight: 2,
  minChars: 12,
  minWords: 3,
  planMaxTokens: 24,
  fullMaxTokens: 320,
  cacheSize: 32,
}

/** The note a pick leaves when the cue it was made on did not survive. */
export const NOTE_PICK_DROPPED = 'The draft changed under that pick; it was not applied.'

type Cue = Omit<CueView, 'held'>

type Review = {
  seq: number
  generation: number
  key: string
  text: string
  textAt: number
  full: number
  plan: number | null
  planDone: boolean
  firstAt: number | null
  buffers: Record<string, string>
}

type Dismissed = { anchor: string; statement: string; options: string[] }

type CardRow = {
  id: string
  key: string
  label: string
  type: RowType
  statement: string
  options: string[]
  defaults: number[]
  unit?: string
  anchor?: string
  /** Repo rows: the file behind each option, attached with the pick. */
  hints?: string[]
  origin: 'model' | 'repo' | 'lens' | 'agent'
  lens?: string
  /** The person's selection; null while untouched (the row then reads its habit or default). */
  picked: number[] | null
  learned?: number[]
  /** Agent rows: the selection last sent to the agent. */
  sent?: number[]
}

type Sketch = { key: string; req: number | null; buffer: string; title: string; lines: string[]; pinned: boolean; open: boolean }

type Card = {
  id: number
  stage: CardStage
  read: string | null
  kind: CardKind | null
  rows: CardRow[]
  focus: string | null
  dismissed: Set<string>
  req: number | null
  reqText: string
  reqKey: string
  reqAt: number
  buffer: string
  /** How much of a streamed reading has been shown. */
  partialAt: number
  /** The draft the applied reading was for. */
  readFor: string | null
  /** The draft changed while a reading was on its way. */
  dirty: boolean
  error: boolean
  shownAt: number | null
  sketch: Sketch | null
  sketchDue: number | null
  amendDue: number | null
  submittedAt: number | null
  /** The decision lines that travelled with the prompt. */
  sent: string[]
  /** The follow-up text this card last put in the composer. */
  fill: string | null
}

const AMEND_MS = 3500
/** A reading starts at a sentence end at most this often, or after this long without an edit. */
const CARD_GAP_MS = 3000
const CARD_IDLE_MS = 900
const CARD_MIN_WORDS = 6
const SKETCH_DELAY_MS = 700
/** alt+down during a turn waits this long for the next press before the change is sent. */
const AMEND_DELAY_MS = 1500
const LEARNED_AFTER = 2
/** Characters of a draft a card reading looks at. */
const DRAFT_MAX = 8000
const REFS_MAX = 4
/** A sketch draws what it can know: something new, or an analysis. A change to existing code or screens it has not seen is not drawn. */
const SKETCH_KINDS = new Set<CardKind>(['build', 'explore'])
/** How a project's stakes are put to the reader. */
const STAKES: Record<Rigor, string> = {
  explore: 'exploring', build: 'building something to use', compete: 'a challenge or competition, scored on held-out data',
  study: 'research meant to stand up to review',
}
/** Words that bring an expert profile's decisions into the card, two or more needed. */
const LENS_WORDS: [string, RegExp][] = [
  ['ml-research', /\b(?:train(?:ing)?|dataset|accuracy|auc|cross-?valid\w*|overfit\w*|leak\w*|regression|classif\w*|features?|labels?|benchmark\w*|baselines?|hyperparam\w*|predict\w*|evaluat\w*|metrics?|test set|validation|fine-?tun\w*|embedding\w*)\b/gi],
  ['system-design', /\b(?:services?|queues?|cach\w+|databases?|scal(?:e|ing|ability)|latency|throughput|replica\w*|shard\w*|load balanc\w*|microservices?|kafka|redis|postgres\w*|consistency|availability|rate limit\w*|backpressure|idempoten\w*|retries|webhooks?)\b/gi],
]

const EMPTY_PROFILE: Profile = { name: 'general', description: '', maxCues: 3, rubric: '', examples: [] }

export function createCore(assets: Assets): Core {
  return new Core(assets)
}

/**
 * Cue identity, in one place: a displayed cue and a cue line are the same cue
 * when they share the anchor (case- and whitespace-insensitive) and the same
 * set of options. (The next wire-format revision moves this to a cue id.)
 */
export function sameCue(a: { anchor: string | null; options: string[] }, b: { anchor: string | null; options: string[] }): boolean {
  return normalize(a.anchor ?? '') === normalize(b.anchor ?? '') && sameOptions(a.options, b.options)
}

export class Core {
  private readonly assets: Assets
  private configured = false
  private enabled = false
  private generation = 0
  private profileName = ''
  private profile: Profile = EMPTY_PROFILE
  private system: string[] = []
  private timing: Timing = { ...DEFAULT_TIMING }
  private streaming = false
  private eagerPlan = false
  /** Absent when the host speaks the original conformance protocol. */
  private mode: Mode | undefined
  private depth: Depth = 'standard'
  private language: LanguageSetting = 'en'
  private audit = false
  private readonly state: DecisionState
  private stateDraft: DecisionDraft | null = null
  private readonly confirmed = new Set<string>()
  private stateDismissed = new Set<string>()
  private submitted = false
  private expert: ExpertView | undefined
  private expertCatalog: ExpertItem[] = []
  private expertReq: number | null = null
  private readonly expertPicks = new Map<string, Decision>()
  private late: { review: Review; submittedAt: number; expires: number } | null = null
  private amendment: { cue: CueView; submittedAt: number; expires: number } | null = null
  /** Undefined under the original conformance protocol; otherwise whether the card runs. */
  private sheetEnabled: boolean | undefined
  private sketchEnabled = true
  private refsEnabled = true
  /** The card on screen: the draft's, or the running turn's while the prompt box is empty. */
  private card: Card | null = null
  /** The running turn's card (the agent's own choices), kept while a follow-up is being written over it. */
  private turnCard: Card | null = null
  /** Decisions of a message typed during a turn: the engine queues it, so they belong to the turn that runs it. */
  private pendingSent: string[] = []
  private nextCard = 1
  private readonly cardCache = new Lru<ParsedCard>(24)
  private readonly sketchCache = new Lru<ParsedSketch | null>(16)
  private lastCardAt: number | null = null
  private index: GroundIndex | null = null
  private mentions: Mention[] = []
  /** Profiles the project calls for, read from its files when it is indexed. */
  private projectLenses: ProjectLens[] = []
  /** Who the person is, from the first-run interview: a line for the reader, their fields, their depth per field. */
  private userLine: string | undefined
  private today: string | undefined
  private prefer: string[] = []
  private depths: Record<string, Depth> = {}
  private learned: Record<string, { label: string; count: number }> = {}
  private receipt: ReceiptView | null = null
  private nextReceipt = 1
  private turnRunning = false

  private now = 0
  private text = ''
  private cursor = 0
  private textAt = 0
  /** When the person last acted without editing (a pick, accept all, switching on): latency counts from here too. */
  private actionAt = 0
  private cues: Cue[] = []
  private focus: string | null = null
  private dismissed: Dismissed[] = []
  private note: string | null = null

  private reviews: Review[] = []
  private nextReq = 1
  private nextReview = 1
  private nextCue = 1
  private appliedSeq = 0
  private lastFireAt: number | null = null
  private lastError = false
  private latencyMs: number | null = null
  private readonly cache: Lru<ParsedCue[]>

  /** When the next review is due (idle gap or rate limit); null when none is. */
  private reviewAt: number | null = null
  private sentTimerAt: number | null = null
  private sentView = ''
  private out: Effect[] = []

  constructor(assets: Assets) {
    this.assets = assets
    this.state = new DecisionState(assets.bundles ?? [], assets.personalProfiles ?? [])
    this.cache = new Lru<ParsedCue[]>(DEFAULT_TIMING.cacheSize)
  }

  handle(event: Event): Effect[] {
    this.out = []
    if ('now' in event && typeof event.now === 'number') this.now = event.now
    switch (event.type) {
      case 'config':
        this.onConfig(event)
        break
      case 'draft':
        this.onDraft(event.text, event.origin, event.edit, event.cursor)
        break
      case 'timer':
        this.onTimer()
        break
      case 'reply':
        this.onReply(event.req, event.text, event.done, event.ok !== false)
        break
      case 'pick':
        this.note = null
        this.onPick(event.cue, event.option)
        break
      case 'dismiss':
        this.note = null
        this.onDismiss(event.cue)
        break
      case 'acceptAll':
        this.note = null
        this.onAcceptAll()
        break
      case 'focus':
        this.onFocus(event.dir, event.cue)
        break
      case 'submit':
        this.onSubmit(event.text, event.amendable !== false)
        break
      case 'loadState':
        this.state.load(event.state)
        if (event.state.submitted !== undefined) this.submitted = event.state.submitted
        this.refreshState()
        break
      case 'set':
        this.onSet(event.slot, event.option, event.scope, event.at, event.text)
        break
      case 'delegate':
        this.onSet(event.slot, 'delegated', event.scope, event.at)
        break
      case 'forget':
        this.onForget(event.slot, event.scope)
        break
      case 'sessionReset':
        this.onReset()
        break
      case 'review':
        this.onExpert(event.profile ?? this.profileName)
        break
      case 'expertPick':
        this.onExpertPick(event)
        break
      case 'amend':
        this.onAmend(event.cue, event.option)
        break
      case 'turnStart':
        if (this.sheetEnabled !== undefined && !this.turnRunning) {
          this.turnRunning = true
          this.turnCard = this.newCard('turn')
          this.turnCard.submittedAt = this.now
          this.turnCard.sent = this.pendingSent
          this.pendingSent = []
          if (this.card?.stage !== 'draft') {
            this.reviewAt = null
            this.clearCard()
            this.card = this.turnCard
          }
        }
        break
      case 'endAmendment':
        this.dropAmendment('turn-ended')
        if (this.turnRunning) {
          this.turnRunning = false
          this.endTurnCard()
          if (this.cardAllowed()) this.schedule('type', null)
        }
        break
      case 'vocabulary':
        this.index = event.vocab ? indexVocabulary(event.vocab) : null
        this.projectLenses = event.vocab ? detectLenses(event.vocab, this.prefer) : []
        if (this.sheetEnabled !== undefined && !this.turnRunning) this.onCardDraft(this.text)
        break
      case 'learned':
        this.learned = { ...event.picks }
        break
      case 'cardFocus':
        this.onCardFocus(event.dir, event.row)
        break
      case 'cardCycle':
        this.onCardChange(event.row, (row, current) => cycleSelection(row, current, event.dir ?? 1), false)
        break
      case 'cardSet':
        this.onCardChange(event.row, (row, current) =>
          row.options[event.option] === undefined ? null : toggleSelection(row, current, event.option), true)
        break
      case 'cardDismiss':
        this.onCardDismiss(event.row)
        break
      case 'cardShown':
        if (this.card?.id === event.id && this.card.shownAt === null && this.card.rows.length) {
          this.card.shownAt = this.now
          this.metric('card-shown', { card: event.id, rows: this.card.rows.length, stage: this.card.stage })
        }
        break
      case 'sketch':
        this.onSketch(event.action)
        break
      case 'blank':
        this.onBlank(event.label, event.choice, event.alternatives)
        break
    }
    this.flush()
    return this.out
  }

  storedDecisions() { return this.state.list() }

  /** The profiles the project calls for and why (for /margincue status). */
  projectProfiles(): ProjectLens[] { return this.projectLenses.filter((lens) => this.state.forProfile(lens.profile).length > 0) }

  /** The view as it stands at the last event's time, without emitting anything. */
  currentView(): View {
    const state = this.mode === undefined ? undefined : this.decisionView()
    const card = this.cardView()
    const cues: CueView[] = state && (state.first || this.mode === 'quiet' || this.stateDraft?.directive === 'delegate')
      ? [] : this.cues.map((cue) => viewCue(cue, this.isHeld(cue)))
    const shown = (id: string | null) => cues.some((c) => c.id === id && !c.held)
    let focus = this.focus
    if (!shown(focus)) {
      const open = cues.find((c) => !c.held && c.chosen === null)
      focus = open ? open.id : (cues.find((c) => !c.held)?.id ?? null)
    }
    return {
      enabled: this.enabled,
      profile: this.profileName,
      phase: !this.enabled ? 'off' : this.reviews.length > 0 ? 'reviewing' : this.lastError ? 'error' : 'idle',
      text: this.text,
      cues,
      focus,
      latencyMs: this.latencyMs,
      decisions: attachDecisions(this.text, this.decisions()).added,
      note: this.note,
      ...(state && { state }),
      ...(this.expert && { expert: this.expert }),
      ...(this.amendment && { amendment: this.amendment.cue }),
      ...(card && { card }),
      ...(this.receipt && this.sheetEnabled === true && { receipt: this.receipt }),
    }
  }

  // ---- events -------------------------------------------------------------

  private onConfig(e: Extract<Event, { type: 'config' }>): void {
    const wasEnabled = this.configured && this.enabled
    this.timing = { ...DEFAULT_TIMING, ...(e.timing ?? {}) }
    this.cache.capacity = this.timing.cacheSize
    const modeChanged = this.mode !== e.mode
    this.mode = e.mode
    const sheetEnabled = this.mode === undefined ? undefined : e.sheet
    const sheetChanged = sheetEnabled !== this.sheetEnabled
    this.sheetEnabled = sheetEnabled
    this.sketchEnabled = e.sketch !== false
    this.refsEnabled = e.refs !== false
    this.userLine = e.user?.trim() || undefined
    this.today = e.today
    this.depths = { ...(e.depths ?? {}) }
    const prefer = [...(e.prefer ?? [])].sort()
    if (prefer.join() !== this.prefer.join()) {
      this.prefer = prefer
      this.projectLenses = this.index ? detectLenses(this.index.vocab, this.prefer) : []
    }
    if (!this.sketchEnabled && this.card?.sketch) {
      if (this.card.sketch.req !== null) this.out.push({ type: 'cancel', req: this.card.sketch.req })
      this.card.sketch = null
    }
    const depthChanged = this.depth !== (e.depth ?? 'standard')
    this.depth = e.depth ?? 'standard'
    const language = e.language ?? 'en'
    const languageChanged = this.language !== language
    this.language = language
    this.audit = e.audit === true
    this.streaming = e.streaming
    this.eagerPlan = e.eagerPlan && this.mode === undefined

    let profileChanged = false
    if (!this.configured || e.profile !== this.profileName) {
      const markdown = this.assets.profiles[e.profile] ??
        (this.state.forProfile(e.profile).length > 0 ? '' : undefined)
      if (markdown !== undefined) {
        this.profile = parseProfile(markdown, e.profile)
        profileChanged = this.configured && e.profile !== this.profileName
        this.profileName = e.profile
      } else {
        this.metric('error', { what: 'unknown-profile', profile: e.profile })
        if (!this.configured) {
          const fallback = this.assets.profiles['general'] !== undefined ? 'general' : Object.keys(this.assets.profiles)[0]
          const md = fallback === undefined ? undefined : this.assets.profiles[fallback]
          this.profile = md === undefined ? EMPTY_PROFILE : parseProfile(md, fallback)
          this.profileName = fallback ?? EMPTY_PROFILE.name
        }
      }
    }
    this.state.use(this.profileName)
    this.system = buildSystem(this.assets.system, this.mode === undefined ? this.profile : { ...this.profile, maxCues: 1 })
    const enabled = this.mode === undefined ? e.enabled : this.mode !== 'off'
    const enabledChanged = this.configured && enabled !== this.enabled
    this.configured = true
    this.enabled = enabled
    this.refreshState()

    // A new generation: whatever is in flight was asked under other settings.
    if (enabledChanged || profileChanged || modeChanged || sheetChanged || languageChanged) {
      this.generation++
      this.cancelAll()
      this.dropAmendment('configuration')
      this.clearExpert()
      this.cues = []
      this.focus = null
      this.dismissed = []
      this.note = null
      this.lastError = false
      this.reviewAt = null
    }
    if (languageChanged) this.expertPicks.clear()
    if (!enabled || sheetEnabled !== true || languageChanged || (profileChanged || depthChanged) && this.card?.stage === 'draft') {
      this.clearCard()
    }
    if (!this.enabled) {
      this.cancelAll()
      this.reviewAt = null
      this.cues = []
      this.focus = null
      return
    }
    if (!wasEnabled || profileChanged || modeChanged || sheetChanged || languageChanged || sheetEnabled && depthChanged) {
      this.actionAt = this.now
      this.schedule('open', null)
    }
  }

  private onDraft(text: string, origin: Origin, edit: Splice | undefined, cursor: number | undefined): void {
    const before = this.text
    this.cursor = cursor === undefined ? text.length : Math.max(0, Math.min(text.length, cursor))
    if (text === before && origin === 'type') return
    const splice = edit !== undefined && spliceFits(before, text, edit) ? edit : diffSplice(before, text)
    this.text = text
    if (text !== before) {
      this.textAt = this.now
      this.note = null
      if (this.sheetEnabled !== undefined) this.onCardDraft(text)
      this.clearExpert()
      if (text.trim() !== '') this.dropAmendment('new-draft')
      const kept: Cue[] = []
      for (const cue of this.cues) {
        if (cue.start === undefined || cue.end === undefined) {
          kept.push({ ...cue, stale: true })
          continue
        }
        const moved = shiftSpan({ start: cue.start, end: cue.end }, splice)
        if (moved && text.slice(moved.start, moved.end) === cue.anchor) {
          kept.push({ ...cue, start: moved.start, end: moved.end, stale: true })
        }
      }
      this.cues = kept
      this.fixFocus()
    }
    if (text.trim() === '' || isHostCommand(text)) {
      this.dismissed = []
      this.stateDismissed.clear()
      this.confirmed.clear()
      this.expertPicks.clear()
    }
    this.refreshState()
    if (origin !== 'restore') this.schedule(origin, splice)
  }

  private onTimer(): void {
    // The host's timer is spent whatever happens next; flush asks again if needed.
    this.sentTimerAt = null
    if (this.late && this.now >= this.late.expires || this.amendment && this.now >= this.amendment.expires) {
      this.dropAmendment('expired')
    }
    if (this.reviewAt !== null && this.now >= this.reviewAt) {
      this.reviewAt = null
      if (this.sheetEnabled === undefined ? this.cloudAllowed() : this.cardAllowed()) this.fireScheduled()
    }
    const card = this.card
    if (card?.sketchDue != null && this.now >= card.sketchDue) {
      card.sketchDue = null
      this.fireSketch()
    }
    if (this.turnCard?.amendDue != null && this.now >= this.turnCard.amendDue) this.sendAgentChanges()
    // A held cue past its settle point is released by the view this flush computes.
  }

  private onReply(req: number, chunk: string, done: boolean, ok: boolean): void {
    if (this.card && req === this.card.req) {
      this.onCardReply(chunk, done, ok)
      return
    }
    if (this.card?.sketch && req === this.card.sketch.req) {
      this.onSketchReply(chunk, done, ok)
      return
    }
    if (req === this.expertReq) {
      this.onExpertReply(chunk, done, ok)
      return
    }
    if (req === this.late?.review.full) {
      this.onLateReply(chunk, done, ok)
      return
    }
    const review = this.reviews.find((r) => r.full === req || r.plan === req)
    if (!review || review.generation !== this.generation) return
    const kind = review.full === req ? 'full' : 'plan'

    if (!ok) {
      if (kind === 'plan') {
        review.planDone = true
        return
      }
      this.removeReview(review, true)
      this.lastError = this.reviews.length === 0
      this.metric('error', { what: 'reply', req })
      return
    }

    const buffer = (review.buffers[kind] ?? '') + chunk
    review.buffers[kind] = buffer
    const current = review.text === this.text
    const maxCues = this.mode === undefined ? this.profile.maxCues : 1

    if (kind === 'plan') {
      let parsed = parseReply(buffer, false, maxCues)
      if (parsed.plan === null && done) {
        const whole = parseReply(buffer, true, maxCues)
        if (whole.none) parsed = whole
      }
      if (done) review.planDone = true
      this.noteFirst(review, req, kind, parsed.plan !== null)
      if (current && parsed.plan !== null) this.addProvisional(parsed.plan)
      return
    }

    const parsed = parseReply(buffer, done, this.mode !== undefined && this.audit ? Math.max(maxCues, this.profile.maxCues) : maxCues)
    const shown = parsed.cues.slice(0, maxCues)
    this.noteFirst(review, req, kind, parsed.plan !== null || shown.length > 0)
    if (!done) {
      if (current && parsed.plan !== null) this.addProvisional(parsed.plan)
      if (shown.length > 0) this.reconcile(shown, current, false)
      return
    }

    this.cache.set(review.key, shown)
    this.reconcile(shown, current, true)
    this.appliedSeq = review.seq
    this.latencyMs = this.now - review.textAt
    this.lastError = false
    this.removeReview(review, true)
    for (const older of this.reviews.filter((r) => r.seq < review.seq)) this.removeReview(older)
    this.metric('reply', { req, ms: this.latencyMs, cues: parsed.cues.length, current })
    if (this.mode !== undefined) this.auditCloud(parsed.cues, this.latencyMs)
  }

  private onPick(id: string, option: number | string | null): void {
    const row = this.card?.rows.find((entry) => entry.id === id)
    if (row && typeof option === 'number') {
      this.onCardChange(id, (r, current) => r.options[option] === undefined ? null : toggleSelection(r, current, option), true)
      return
    }
    const cue = this.cues.find((c) => c.id === id)
    if (!cue || cue.provisional) return
    let chosen: Chosen
    if (option === null) chosen = null
    else if (typeof option === 'number') {
      if (!Number.isInteger(option) || option < 0 || option >= cue.options.length) return
      chosen = option
    } else {
      const typed = option.trim()
      const at = cue.options.findIndex((o) => normalize(o) === normalize(typed))
      chosen = typed === '' ? null : at >= 0 ? at : typed
    }
    if (cue.stale && chosen !== null) {
      // Not validated against the current text: remember it until a reply for
      // the current text says whether the cue still stands.
      cue.pending = chosen
      this.metric('pick', { ...(this.mode && { cue: id, action: 'pending' }), option: typeof chosen === 'string' ? 'text' : chosen, pending: true })
    } else {
      cue.chosen = chosen
      cue.pending = null
      this.metric('pick', { ...(this.mode && { cue: id, action: 'set', scope: 'draft' }), option: typeof chosen === 'string' ? 'text' : chosen, pending: false })
    }
    this.focus = this.nextOpen(cue.id) ?? cue.id
    this.actionAt = this.now
    if (this.mode === undefined && this.cloudAllowed()) this.fire()
  }

  private onDismiss(id: string): void {
    if (this.card?.rows.some((row) => row.id === id)) {
      this.onCardDismiss(id)
      return
    }
    if (this.mode !== undefined && this.decisionView().first?.slot === id) {
      this.stateDismissed.add(id)
      this.metric('dismiss', { slot: id, action: 'dismissed' })
      this.auditState()
      return
    }
    const at = this.cues.findIndex((c) => c.id === id)
    if (at === -1) return
    const cue = this.cues[at] as Cue
    if (cue.statement !== '') this.dismissed.push({ anchor: cue.anchor, statement: cue.statement, options: [...cue.options] })
    this.cues.splice(at, 1)
    if (this.focus === id) {
      const next = this.cues[at] ?? this.cues[0]
      this.focus = next ? next.id : null
    }
    this.fixFocus()
    this.metric('dismiss', this.mode === undefined ? {} : { cue: id, action: 'dismissed' })
  }

  private onAcceptAll(): void {
    let changed = 0
    for (const cue of this.cues) {
      if (cue.provisional || cue.chosen !== null || cue.options.length === 0 || this.isHeld(cue)) continue
      if (cue.stale) cue.pending = 0
      else cue.chosen = 0
      changed++
    }
    if (changed === 0) return
    this.metric('acceptAll', { cues: changed })
    this.actionAt = this.now
    if (this.cloudAllowed()) this.fire()
  }

  private onFocus(dir: 1 | -1 | undefined, id: string | undefined): void {
    if (this.card?.rows.length && (id === undefined ? this.sheetEnabled !== undefined : this.card.rows.some((row) => row.id === id))) {
      this.onCardFocus(dir, id)
      return
    }
    const visible = this.cues.filter((c) => !this.isHeld(c))
    if (id !== undefined) {
      if (visible.some((c) => c.id === id)) this.focus = id
      return
    }
    if (visible.length === 0) return
    const at = Math.max(0, visible.findIndex((c) => c.id === this.currentView().focus))
    const step = dir === -1 ? -1 : 1
    this.focus = (visible[(at + step + visible.length) % visible.length] as Cue).id
  }

  private onSubmit(text: string, amendable: boolean): void {
    const prompt = !isHostCommand(text) && text.trim() !== ''
    const isPrompt = this.enabled && prompt
    if (this.mode !== undefined && text !== this.text) this.refreshState(text)
    const exact = text === this.text
    const decisions = isPrompt ? this.decisions(exact) : []
    const attached = attachDecisions(text, decisions)
    const added = attached.added
    const target = isPrompt && exact ? this.pinnedSketch() : null
    const sent = target ? `${attached.text.replace(/\s+$/, '')}\n\n${target}` : attached.text
    if (this.sheetEnabled !== undefined) this.onCardSubmit(prompt, exact, amendable, added)
    if (this.mode !== undefined) {
      this.dropAmendment('new-submit')
      if (isPrompt && amendable && text === this.text && this.cloudAllowed() &&
        !this.cues.some((cue) => !cue.stale && !cue.provisional)) {
        const key = this.requestText().key
        // Enter can beat the idle timer on an eligible, fast-typed prompt.
        if (!this.reviews.some((review) => review.key === key) && this.cache.get(key) === undefined) {
          this.fire()
        }
        const pending = this.reviews.find((review) => review.key === key)
        if (pending) {
          this.reviews.splice(this.reviews.indexOf(pending), 1)
          this.late = { review: pending, submittedAt: this.now, expires: this.now + AMEND_MS }
        }
      }
      if (prompt) this.submitted = true
      if (this.audit && this.enabled) this.auditSubmit()
    }
    this.out.push({ type: 'submit', text: sent, decisions: added })
    this.metric('submit', {
      enabled: this.enabled,
      shown: this.cues.filter((c) => !c.provisional).length,
      decisions: decisions.length,
    })
    this.resetDraft()
  }

  private resetDraft(): void {
    this.cancelAll()
    this.clearExpert()
    this.reviewAt = null
    this.text = ''
    this.cursor = 0
    this.textAt = this.now
    this.cues = []
    this.focus = null
    this.dismissed = []
    this.note = null
    this.lastError = false
    this.stateDraft = null
    this.confirmed.clear()
    this.expertPicks.clear()
    this.stateDismissed.clear()
  }

  private onReset(): void {
    this.dropAmendment('session-reset')
    this.clearCard()
    this.turnCard = null
    this.pendingSent = []
    this.receipt = null
    this.turnRunning = false
    this.resetDraft()
    this.state.reset()
    this.submitted = false
  }

  // ---- standing decisions -------------------------------------------------

  private refreshState(text = this.text): void {
    this.stateDraft = this.mode === undefined || !this.enabled || isHostCommand(text) || !text.trim()
      ? null : this.state.evaluate(text, this.confirmed)
    this.auditState()
  }

  private stateReason(result: SlotResult): string | null {
    const draft = this.stateDraft!
    if (result.status !== 'open') return result.reason
    if (this.stateDismissed.has(result.slot.id)) return 'dismissed'
    if (draft.directive === 'delegate' && !result.slot.guard) return 'prompt-delegates'
    if (!eligibleSlot(result.slot, this.depth, draft.rigor)) return 'depth-or-rigor'
    return null
  }

  private decisionView() {
    const draft = this.stateDraft
    const language = this.wordingLanguage(draft)
    const marks = draft?.results.flatMap((result) => {
      if (result.status !== 'filled' || !result.span) return []
      const option = result.value && decisionFor(result.slot, result.value, language, this.depth)?.option
      const evidence = result.evidence && this.language === 'en' ? 'set in the draft' : result.evidence
      const value = option ?? evidence ?? (language === 'en' ? 'in project instructions' : 'dans les consignes du projet')
      return [{ slot: result.slot.id, label: result.slot.label[language], value, span: result.span }]
    }) ?? []
    const open = draft?.results.filter((result) => this.stateReason(result) === null) ?? []
    const first = [...open].sort((a, b) => Number(b.slot.guard) - Number(a.slot.guard) || b.slot.cost - a.slot.cost)[0]
    return {
      mode: this.mode!, depth: this.depth, language, model: this.state.model, marks, open: open.length,
      first: first && this.mode !== 'quiet' ? stateCue(first, language, this.depth) : null,
    }
  }

  private wordingLanguage(draft = this.stateDraft): Language {
    return this.language === 'auto' ? draft?.language ?? 'en' : 'en'
  }

  private onSet(id: string, option: string, scope?: Scope, at?: number, text?: string): boolean {
    if (!this.enabled || this.mode === undefined) return false
    const slot = this.state.slot(id)
    if (!slot) return false
    const facts = this.stateDraft?.byId.has(id) ? this.stateDraft.facts : this.state.evaluate(this.text, [id]).facts
    if (slot.requires?.some((fact) => facts.get(fact) !== true)) return false
    if (option !== 'delegated' && option !== 'other'
      && !slot.options.some((item) => item.id === option && (!item.requires || facts.get(item.requires) === true))) return false
    const change = this.state.set(slot, scope ?? slot.scope, option, at ?? this.now, text?.trim())
    if (!change) return false
    this.note = null
    if (this.stateDraft) this.confirmed.add(id)
    this.persist(change)
    this.refreshState()
    return true
  }

  private onForget(id: string, scope?: Scope): void {
    if (!this.enabled || this.mode === undefined) return
    const change = this.state.forget(id, scope)
    if (!change) return
    this.confirmed.delete(id)
    this.stateDismissed.delete(id)
    this.persist(change)
    this.refreshState()
  }

  private persist(change: StateChange): void {
    this.out.push({ type: 'persist', ...change })
    if (change.action === 'forget') this.metric('stateAction', { action: 'forget', slot: change.slot, scope: change.scope })
    else this.metric('stateAction', {
      action: change.action === 'delegate' ? 'delegated' : 'set', slot: change.value.slot,
      scope: change.value.scope, option: change.value.option, sinceEditMs: this.now - this.textAt,
    })
  }

  private auditState(): void {
    if (!this.audit || !this.stateDraft) return
    const first = this.decisionView().first?.slot
    for (const result of this.stateDraft.results) {
      if (!result.span && result.reason !== 'slot-not-touched') continue
      const order = result.options.map((option) => option.id)
      if (!result.slot.guard) order.push('delegated')
      const shown = first === result.slot.id || result.status === 'filled' && result.span !== undefined
      const reason = shown ? (first === result.slot.id ? 'first-touch' : 'mark')
        : this.stateReason(result) ?? (this.mode === 'quiet' ? 'quiet' : 'lower-priority')
      this.metric('candidate', {
        tier: 'state', slot: result.slot.id, status: result.status, shown, reason,
        optionOrder: order, default: order[0] ?? null, sinceEditMs: this.now - this.textAt,
      })
    }
  }

  private auditCloud(parsed: ParsedCue[], ms: number): void {
    if (!this.audit) return
    const view = this.currentView()
    for (const [index, candidate] of parsed.entries()) {
      const cue = this.cues.find((item) => sameCue(item, candidate))
      const visible = view.cues.some((item) => item.id === cue?.id && !item.held)
      const reason = visible ? 'review-cue' : index > 0 ? 'cue-limit' : view.state?.first ? 'state-priority'
        : cue && this.isHeld(cue) ? 'held'
        : this.isDismissed(candidate) ? 'dismissed' : 'settled-or-stale'
      this.metric('candidate', {
        tier: 'cloud', cue: cue?.id ?? `reply-${this.appliedSeq}-${index + 1}`, shown: visible,
        reason, optionOrder: candidate.options.map((_, i) => i), default: 0, ms,
      })
    }
  }

  private auditSubmit(): void {
    const view = this.currentView()
    if (view.state?.first) this.metric('cueAction', { slot: view.state.first.slot, action: 'sent-untouched' })
    for (const cue of view.cues) {
      if (!cue.provisional && !cue.held && cue.chosen === null) this.metric('cueAction', { cue: cue.id, action: 'sent-untouched' })
    }
    for (const [index, item] of (view.expert?.items ?? []).entries()) {
      if (item.chosen === undefined) this.metric('cueAction', {
        ...(item.persistent ? { slot: item.key } : { cue: `expert-${view.expert!.id}-${index + 1}` }),
        action: 'sent-untouched',
      })
    }
  }

  // ---- on-demand review --------------------------------------------------

  private expertBuffer = ''
  private expertStarted = 0

  private onExpert(profile: string): void {
    const system = this.assets.expertSystem
    const slots = this.state.forProfile(profile)
    if (!this.enabled || this.mode === undefined || !system || !slots.length ||
      !this.text.trim() || isHostCommand(this.text)) return
    this.clearExpert()
    this.cancelAll()
    if (this.sheetEnabled === undefined) this.reviewAt = null
    const draft = this.state.evaluate(this.text, slots.map((slot) => slot.id))
    const language = this.wordingLanguage(draft)
    const id = this.nextReq++
    this.expert = { id, profile, phase: 'reviewing', items: [] }
    this.expertReq = id
    this.expertStarted = this.now
    this.expertCatalog = slots.flatMap((slot): ExpertItem[] => {
      const options = draft.available(slot)
      const value = this.state.resolve(slot.id)
      const reason = this.state.instructionSlots.has(slot.id) ? 'project-instruction'
        : value ? 'standing-value' : draft.suppresses(slot) ? 'settled-or-inapplicable'
        : slot.requires?.some((key) => draft.facts.get(key) !== true) || options.length < 2 ? 'prerequisite' : null
      if (reason) {
        if (this.audit) this.metric('candidate', {
          tier: 'expert', slot: slot.id, shown: false, reason, optionOrder: options.map((o) => o.id), default: options[0]?.id ?? null,
        })
        return []
      }
      return [{ ...stateCue({ slot, options }, language, this.depth), key: slot.id, persistent: true }]
    })
    const prompt = buildPrompt({
      draft: applyDecisions(this.text, this.decisions()),
      dismissed: [...this.dismissed.map((d) => d.statement), ...this.stateDismissed],
    })
    this.out.push({
      type: 'request', req: id, kind: 'expert', tier: 'cloud',
      system: [(this.language === 'en' ? system.replace("in the draft's language", 'in English') : system)
        .replace(/\{\{\s*max_cues\s*\}\}/g, String(MAX_EXPERT_CUES)).trim()],
      prompt: `${prompt}\n\n${expertPrompt(this.expertCatalog, slots)}`, maxTokens: 512,
    })
  }

  private onExpertReply(chunk: string, done: boolean, ok: boolean): void {
    if (!this.expert) return
    this.expertBuffer += chunk
    if (ok && !done) return
    const items = ok ? parseExpert(this.expertBuffer, this.text, this.expertCatalog, (key) => this.state.slot(key) !== undefined) : []
    this.expertReq = null
    this.expert = { ...this.expert, phase: ok ? 'ready' : 'error', items }
    this.expertBuffer = ''
    const ms = this.now - this.expertStarted
    this.metric('expertReply', { req: this.expert.id, ms, cues: items.length, ok })
    if (!this.audit) return
    const candidates = [...this.expertCatalog, ...items.filter((item) => !item.persistent)]
    for (const [index, item] of candidates.entries()) {
      const shown = items.some((choice) => choice.key === item.key)
      const order = item.options.map((option) => option.id)
      if (item.persistent && !item.guard) order.push('delegated')
      this.metric('candidate', {
        tier: 'expert', ...(item.persistent ? { slot: item.key } : { cue: `expert-${this.expert.id}-${index - this.expertCatalog.length + 1}` }),
        shown, reason: shown ? 'checklist' : ok ? 'not-returned' : 'review-failed',
        optionOrder: order, default: order[0] ?? null, ms,
      })
    }
    this.expertCatalog = []
  }

  private onExpertPick(event: Extract<Event, { type: 'expertPick' }>): void {
    if (!this.expert || this.expert.id !== event.review) return
    const index = this.expert.items.findIndex((item) => item.key === event.key && item.chosen === undefined)
    const item = this.expert.items[index]
    if (!item) return
    const choice = item.options.find((option) => option.id === event.option)
    if (item.persistent) {
      if (!choice && (event.option !== 'delegated' || item.guard)) return
      if (!this.onSet(item.slot, event.option, event.scope, event.at)) return
    } else {
      if (!choice) return
      this.expertPicks.set(item.key, { statement: item.statement, option: choice.label })
      this.metric('cueAction', { cue: `expert-${this.expert.id}-${index + 1}`, action: 'set', scope: 'draft', option: choice.id })
    }
    this.expert = { ...this.expert, items: this.expert.items.map((entry) => entry === item ? { ...item, chosen: event.option } : entry) }
  }

  private clearExpert(): void {
    if (this.expertReq !== null) this.out.push({ type: 'cancel', req: this.expertReq })
    this.expertReq = null
    this.expert = undefined
    this.expertCatalog = []
    this.expertBuffer = ''
  }

  // ---- the card ------------------------------------------------------------
  //
  // Before Enter the card shows how the agent will read the draft, the names it
  // found (or not) in the code, and the choices left open, each with a control
  // shaped like its value. After Enter it holds the choices the agent marks as
  // it works (blanks), which the person can switch without stopping it; after
  // the turn, a receipt and one-key follow-ups.

  private cardText(text = this.text): boolean {
    return !isHostCommand(text) && wordCount(text) >= CARD_MIN_WORDS
  }

  private cardAllowed(): boolean {
    // A draft written while the agent works is read too: a follow-up deserves its card as much as an opening.
    return this.enabled && this.sheetEnabled === true && Boolean(this.assets.cardSystem) &&
      this.card?.stage === 'draft' && this.cardText()
  }

  private newCard(stage: CardStage): Card {
    return {
      id: this.nextCard++, stage, read: null, kind: null, rows: [], focus: null, dismissed: new Set(),
      req: null, reqText: '', reqKey: '', reqAt: 0, buffer: '', partialAt: 0, readFor: null, dirty: false, error: false,
      shownAt: null, sketch: null, sketchDue: null, amendDue: null, submittedAt: null, sent: [], fill: null,
    }
  }

  private clearCard(): void {
    const card = this.card
    if (!card) return
    if (card.req !== null) this.out.push({ type: 'cancel', req: card.req })
    if (card.sketch && card.sketch.req !== null) this.out.push({ type: 'cancel', req: card.sketch.req })
    if (card === this.turnCard) this.turnCard = null
    this.card = null
    if (this.sheetEnabled !== undefined) this.reviewAt = null
  }

  /** Drops the card on screen unless it is the running turn's, which only steps aside. */
  private setAside(): void {
    if (this.card && this.card === this.turnCard) this.card = null
    else this.clearCard()
  }

  private onCardDraft(text: string): void {
    const card = this.card
    if (card?.stage === 'after' && (text === card.fill || text.trim() === '')) {
      this.mentions = []
      return
    }
    const eligible = this.enabled && this.sheetEnabled === true && this.cardText(text)
    this.mentions = eligible ? ground(text, this.index) : []
    if (!eligible) {
      // During a turn an empty (or too short) box gives the place back to the agent's choices.
      if (card !== this.turnCard || !this.turnRunning) this.setAside()
      if (this.turnRunning && !this.card && this.turnCard) this.card = this.turnCard
      return
    }
    if (!card || card.stage !== 'draft') {
      this.setAside()
      this.card = this.newCard('draft')
    }
    this.syncRepoRows()
  }

  /** A name the draft uses that the code lacks becomes a row: which of the code's names it means. */
  private syncRepoRows(): void {
    const card = this.card!
    const rows: CardRow[] = []
    for (const mention of this.mentions) {
      if (mention.status !== 'missing' || !mention.near.length || rows.length >= 2) continue
      const key = `name_${nameKey(mention.phrase)}`.slice(0, 40)
      if (card.dismissed.has(key)) continue
      const options = [...mention.near.map((near) => near.name), 'new, to be added']
      const hints = [...mention.near.map((near) => near.file), '']
      const old = card.rows.find((row) => row.origin === 'repo' && row.key === key)
      rows.push(old && sameOptions(old.options, options) ? old : {
        id: old?.id ?? this.newId(), key, label: cutLabel(mention.phrase), type: 'one',
        statement: `"${mention.phrase}" is {}`, options, hints, defaults: [], origin: 'repo', picked: null,
        anchor: mention.phrase,
      })
    }
    card.rows = [...rows, ...card.rows.filter((row) => row.origin !== 'repo')]
    this.fixCardFocus()
  }

  private scheduleCard(origin: Origin, splice: Splice | null): void {
    const sentenceEnd = splice !== null && /[.?!\n][)"'”’\]]*[ \t]*$/.test(splice.text)
    const last = this.lastCardAt
    if ((origin !== 'type' || sentenceEnd) && (origin !== 'type' || last === null || this.now - last >= CARD_GAP_MS)) {
      this.fireCard()
      return
    }
    const at = this.textAt + CARD_IDLE_MS
    if (at <= this.now) this.fireCard()
    else this.reviewAt = at
  }

  private fireCard(): void {
    this.reviewAt = null
    const card = this.card
    if (!card || !this.cardAllowed()) return
    if (card.req !== null) {
      card.dirty = card.reqText !== this.text
      return
    }
    if (card.readFor === this.text) return
    const { system, prompt } = this.cardRequest(card)
    const key = `${this.profileName}\n${this.language}\n${this.userLine ?? ''}\n${system.length}\n${prompt}`
    const cached = this.cardCache.get(key)
    if (cached) {
      this.applyCard(card, cached, this.text)
      return
    }
    const req = this.nextReq++
    Object.assign(card, { req, reqText: this.text, reqKey: key, reqAt: this.now, buffer: '', partialAt: 0, dirty: false })
    this.lastCardAt = this.now
    this.out.push({ type: 'request', req, kind: 'card', tier: 'cloud', system, prompt, maxTokens: CARD_MAX_TOKENS })
    this.metric('card-requested', { req, card: card.id, words: wordCount(this.text), mentions: this.mentions.length })
  }

  private cardRequest(card: Card): { system: string[]; prompt: string } {
    const english = this.wordingLanguage() === 'en'
    const system = [this.assets.cardSystem!.replace('{language}', english ? 'in English, even when the draft is not' : "in the draft's language")]
    if (this.userLine) system.push(`About the developer: ${this.userLine}`)
    if (this.index?.vocab.map) system.push(`Repository outline (folders with code, most files first):\n${this.index.vocab.map}`)
    const lenses = this.lensBlocks()
    // The project's profiles are the same for every prompt in it: they sit with the cached system text.
    if (lenses.project) system.push(lenses.project)
    // A pasted wall of text is read from its start and its end: that is where requests and their limits sit.
    const draft = this.text.length > DRAFT_MAX ? `${this.text.slice(0, DRAFT_MAX * 0.7)}\n[…]\n${this.text.slice(-DRAFT_MAX * 0.3)}` : this.text
    const lines = ['Draft:', '<<<', draft, '>>>']
    const found = this.mentions.filter((m) => m.status === 'found').slice(0, 8)
    if (found.length) lines.push(`In the code: ${found.map((m) => `${m.phrase} (${m.files[0] ?? m.match})`).join('; ')}`)
    const missing = this.mentions.filter((m) => m.status === 'missing')
    if (missing.length) lines.push(`Not found in the code, asked about separately (no row for these): ${missing.map((m) => `"${m.phrase}"`).join(', ')}`)
    const folders = this.index ? relatedFolders(this.text, this.index) : []
    if (folders.length) lines.push(`Folders that may already do part of this: ${folders.map((f) => `${f.dir}/ (${f.files.join(', ')})`).join('; ')}`)
    const settled = [
      ...this.decisions(false).map(decisionLine),
      ...card.rows.filter((row) => row.picked !== null).map((row) => decisionLine({ statement: row.statement, option: this.rowText(row, row.picked!) })),
    ]
    if (settled.length) lines.push(`Already decided (no row for these):\n${settled.map((line) => `- ${line}`).join('\n')}`)
    const open = card.rows.filter((row) => (row.origin === 'model' || row.origin === 'lens') && row.picked === null)
    if (open.length) lines.push(`Rows on screen now (keep a key while its choice is still open): ${open.map((row) => row.key).join(', ')}`)
    if (card.dismissed.size) lines.push(`Dismissed by the user (never raise again): ${[...card.dismissed].join(', ')}`)
    if (this.stateDraft?.directive === 'delegate') lines.push('The user leaves the choices to the agent: reply with the read and kind lines only.')
    if (lenses.draft) lines.push(lenses.draft)
    return { system, prompt: lines.join('\n') }
  }

  /** A profile's depth: the person's level in that field when they gave it, else the depth in force. */
  private depthOf(profile: string): Depth {
    return this.depths[profile] ?? this.depth
  }

  /** Profiles for this reading: the project's, the one the person picked, and any the draft's own words call for. */
  private lensProfiles(): string[] {
    const profiles = new Set<string>()
    for (const lens of this.projectLenses) if (this.state.forProfile(lens.profile).length) profiles.add(lens.profile)
    if (this.profileName !== 'general' && this.state.forProfile(this.profileName).length) profiles.add(this.profileName)
    for (const [profile, words] of LENS_WORDS) {
      const hits = new Set((this.text.match(words) ?? []).map((word) => word.toLowerCase()))
      if (hits.size >= 2 && this.state.forProfile(profile).length) profiles.add(profile)
    }
    return [...profiles]
  }

  /**
   * The catalogs of the profiles in play, as candidate rows. A project's profile carries the stakes read from
   * the project (a challenge competes, a paper studies) and sits in the system text; the others in the prompt.
   * Only decisions worth raising at that rigor and at the person's depth are offered, essentials first.
   */
  private lensBlocks(): { project: string; draft: string } {
    const language = this.wordingLanguage()
    const tiers = ['essential', 'standard', 'research']
    const block = (profile: string, rigor: Rigor, stakes: string) => {
      const depth = this.depthOf(profile)
      const slots = this.state.forProfile(profile)
        .filter((slot) => !this.state.resolve(slot.id) && eligibleSlot(slot, depth, rigor))
        .sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier) || b.cost - a.cost).slice(0, 10)
      const lines = slots.map((slot) => {
        const cue = stateCue({ slot, options: slot.options }, language, depth)
        return `${slot.id} | when: ${slot.when} | ${cue.statement} | ${cue.options.map((option) => option.label).join(' | ')}`
      })
      return lines.length
        ? `Expert decisions (${profile}${stakes}). When the draft touches one and leaves it open, add it as a row with this exact key, type one and these options:\n${lines.join('\n')}`
        : ''
    }
    const fromProject = new Map(this.projectLenses.map((lens) => [lens.profile, lens]))
    const project: string[] = []
    const draft: string[] = []
    for (const profile of this.lensProfiles()) {
      const lens = fromProject.get(profile)
      if (lens) project.push(block(profile, lens.rigor, `; this project: ${STAKES[lens.rigor]}`))
      else draft.push(block(profile, this.stateDraft?.rigor ?? 'build', ''))
    }
    return { project: project.filter(Boolean).join('\n'), draft: draft.filter(Boolean).join('\n') }
  }

  private onCardReply(chunk: string, done: boolean, ok: boolean): void {
    const card = this.card!
    card.buffer += chunk
    if (ok && !done) {
      // A streamed reading shows as it comes: its line first, then each row once its line is complete.
      const complete = card.buffer.slice(0, card.buffer.lastIndexOf('\n') + 1)
      if (complete.length > card.partialAt) {
        card.partialAt = complete.length
        const parsed = parseCard(complete)
        if (parsed.read !== null || parsed.rows.length) this.applyCard(card, parsed, card.reqText, true)
      }
      return
    }
    card.partialAt = 0
    const req = card.req
    card.req = null
    if (ok) {
      const parsed = parseCard(card.buffer)
      this.cardCache.set(card.reqKey, parsed)
      this.applyCard(card, parsed, card.reqText)
      this.metric('card-reply', { req, card: card.id, ok, ms: this.now - card.reqAt, rows: parsed.rows.length, kind: parsed.kind, read: parsed.read !== null })
    } else {
      card.error = card.readFor === null
      this.metric('card-reply', { req, card: card.id, ok, ms: this.now - card.reqAt })
    }
    card.buffer = ''
    if (card.dirty || ok && card.readFor !== this.text) {
      card.dirty = false
      if (this.now - this.textAt >= CARD_IDLE_MS) this.fireCard()
      else this.reviewAt = this.textAt + CARD_IDLE_MS
    }
  }

  /** `partial`: part of a streamed reading. Rows it has not reached yet stay, and no sketch is asked for until it ends. */
  private applyCard(card: Card, parsed: ParsedCard, text: string, partial = false): void {
    card.read = parsed.read ?? card.read
    card.kind = parsed.kind ?? card.kind
    if (!partial) card.readFor = text
    card.error = false
    // A question is answered, not built: its card is the reading alone.
    const fresh = this.stateDraft?.directive === 'delegate' || card.kind === 'ask' ? [] : parsed.rows.filter((row) => !card.dismissed.has(row.key))
    const old = card.rows.filter((row) => row.origin === 'model' || row.origin === 'lens')
    const used = new Set<string>()
    const next: CardRow[] = []
    for (const parsedRow of fresh) {
      const row = this.lensRow(parsedRow) ?? { ...parsedRow, origin: 'model' as const }
      const match = old.find((entry) => !used.has(entry.id) && (entry.key === row.key || normalize(entry.statement) === normalize(row.statement)))
      if (match) used.add(match.id)
      if (match && match.picked !== null) next.push(row.anchor ? { ...match, anchor: row.anchor } : match)
      else next.push(this.withLearned({ ...row, id: match?.id ?? this.newId(), picked: null }))
    }
    // A choice the person made stands until they dismiss it, whatever a newer reading says.
    for (const row of old) if (!used.has(row.id) && (partial || row.picked !== null)) next.push(row)
    card.rows = [...card.rows.filter((row) => row.origin === 'repo'), ...next]
    this.fixCardFocus()
    // A reading for the draft as it stands means the draft has rested since it was asked: sketch at once.
    if (!partial && this.sketchEnabled && this.assets.sketchSystem && card.kind && SKETCH_KINDS.has(card.kind) && text === this.text) {
      card.sketchDue = this.now
    }
  }

  /** A row whose key names a decision of an active expert profile takes the catalog's wording. */
  private lensRow(row: ParsedRow): Omit<CardRow, 'id' | 'picked'> | null {
    const slot = this.state.slot(row.key)
    const profile = slot && this.lensProfiles().find((name) => this.state.forProfile(name).includes(slot))
    if (!slot || !profile) return null
    const cue = stateCue({ slot, options: slot.options }, this.wordingLanguage(), this.depthOf(profile))
    return {
      key: slot.id, label: cutLabel(cue.label.toLowerCase()), type: 'one', statement: cue.statement,
      options: cue.options.map((option) => option.label), defaults: [0], origin: 'lens', lens: profile,
      ...(row.anchor && { anchor: row.anchor }),
    }
  }

  private withLearned(row: CardRow): CardRow {
    const habit = this.learned[row.key]
    if (!habit || habit.count < LEARNED_AFTER || row.type === 'many') return row
    const at = row.options.findIndex((option) => normalize(option) === normalize(habit.label))
    return at === -1 || sameSelection([at], row.defaults) ? row : { ...row, learned: [at] }
  }

  private rowText(row: CardRow, selected: number[]): string {
    if (row.hints) {
      const i = selected[0] ?? 0
      return row.hints[i] ? `${row.options[i]} (${row.hints[i]})` : row.options[i] ?? ''
    }
    return rowValue(row, selected)
  }

  private fixCardFocus(): void {
    const card = this.card
    if (!card) return
    if (card.focus !== null && card.rows.some((row) => row.id === card.focus)) return
    card.focus = (card.rows.find((row) => row.picked === null) ?? card.rows[0])?.id ?? null
  }

  private onCardFocus(dir: 1 | -1 | undefined, rowId: string | undefined): void {
    const card = this.card
    if (!card?.rows.length) return
    if (rowId !== undefined) {
      if (card.rows.some((row) => row.id === rowId)) card.focus = rowId
      return
    }
    const at = card.rows.findIndex((row) => row.id === card.focus)
    const n = card.rows.length
    card.focus = card.rows[((at + (dir === -1 ? -1 : 1)) % n + n) % n]!.id
  }

  private onCardChange(rowId: string | undefined, change: (row: CardRow, current: number[]) => number[] | null, commit: boolean): void {
    const card = this.card
    const row = card?.rows.find((entry) => entry.id === (rowId ?? card.focus))
    if (!card || !row) return
    const next = change(row, row.picked ?? row.learned ?? row.defaults)
    if (!next) return
    card.focus = row.id
    // Cycling back onto the default leaves nothing to attach; a direct pick always counts.
    row.picked = !commit && card.stage === 'draft' && sameSelection(next, row.learned ?? row.defaults) ? null : next
    this.actionAt = this.now
    this.metric('card-pick', {
      card: card.id, row: row.key, origin: row.origin, stage: card.stage, option: next.join('+'), commit,
      ms: card.shownAt === null ? null : this.now - card.shownAt,
    })
    if (card.stage === 'turn') {
      if (commit) this.sendAgentChanges()
      else card.amendDue = this.now + AMEND_DELAY_MS
    } else if (card.stage === 'after') this.fillFollowUp()
    else if (card.sketch && card.kind && SKETCH_KINDS.has(card.kind)) card.sketchDue = this.now + SKETCH_DELAY_MS
  }

  private onCardDismiss(rowId: string): void {
    const card = this.card
    const row = card?.rows.find((entry) => entry.id === rowId)
    if (!card || !row) return
    card.dismissed.add(row.key)
    card.rows = card.rows.filter((entry) => entry !== row)
    this.fixCardFocus()
    this.metric('card-dismissed', { card: card.id, row: row.key, origin: row.origin, stage: card.stage })
    if (card.stage === 'after') this.fillFollowUp()
  }

  private cardDecisions(): Decision[] {
    const card = this.card!
    const out: Decision[] = card.rows.filter((row) => row.picked !== null)
      .map((row) => ({ statement: row.statement, option: this.rowText(row, row.picked!) }))
    if (this.refsEnabled) {
      // Only what the draft wrote as code (a path, a file, an identifier, backticks): a product name or a
      // plain word that happens to match a file would send the agent to the wrong place.
      const refs = this.mentions.filter((m) => m.status === 'found' && m.files.length > 0 && m.as === 'code').slice(0, REFS_MAX)
      if (refs.length) out.push({ statement: 'Where things are: {}', option: refs.map((m) => `${m.phrase} (${m.files[0]})`).join(', ') })
    }
    return out
  }

  private cardView(): CardView | undefined {
    const card = this.card
    if (!card || !this.enabled || this.sheetEnabled !== true) return
    const draft = card.stage === 'draft'
    const rows = card.rows.map((row) => this.rowView(row, draft))
    const reading = card.req !== null
    if (draft ? !rows.length && !card.read && !reading && !this.mentions.length && !card.error : !rows.length) return
    const sketch = card.sketch && (card.sketch.lines.length || card.sketch.req !== null) ? card.sketch : null
    return {
      id: card.id, stage: card.stage, reading, error: card.error, read: card.read, kind: card.kind, rows,
      focus: card.focus, mentions: draft ? this.mentions : [], lenses: draft ? this.lensProfiles() : [],
      ...(sketch && { sketch: { title: sketch.title, lines: sketch.lines, drawing: sketch.req !== null, pinned: sketch.pinned, open: sketch.open } }),
      language: this.wordingLanguage(), collapsed: this.mode === 'quiet',
    }
  }

  private rowView(row: CardRow, draft: boolean): CardRowView {
    const span = draft && row.anchor ? resolveAnchor(this.text, row.anchor) : null
    return {
      id: row.id, key: row.key, label: row.label, type: row.type, statement: row.statement, options: [...row.options],
      defaults: [...row.defaults], selected: [...(row.picked ?? row.learned ?? row.defaults)], chosen: row.picked !== null,
      origin: row.origin, ...(row.unit && { unit: row.unit }), ...(row.lens && { lens: row.lens }),
      ...(row.learned && row.picked === null && { learned: true as const }),
      ...(span && { start: span.start, end: span.end }),
    }
  }

  // ---- the sketch: what done looks like ----------------------------------------

  private onSketch(action: 'toggle' | 'pin' | 'refresh'): void {
    const card = this.card
    if (!card || card.stage !== 'draft') return
    if (action === 'refresh') {
      if (card.sketch) card.sketch.key = ''
      this.fireSketch()
      return
    }
    const sketch = card.sketch
    if (!sketch || !sketch.lines.length) return
    if (action === 'toggle') sketch.open = !sketch.open
    else sketch.pinned = !sketch.pinned
    this.metric(`sketch-${action}`, { card: card.id, value: action === 'toggle' ? sketch.open : sketch.pinned })
  }

  private fireSketch(): void {
    const card = this.card
    const system = this.assets.sketchSystem
    if (!card || card.stage !== 'draft' || !system || !this.sketchEnabled || !this.enabled || !this.cardText()) return
    const prompt = this.sketchPrompt(card)
    const key = `${this.language}\n${prompt}`
    const prior = card.sketch
    if (prior && prior.key === key) return
    if (prior && prior.req !== null) this.out.push({ type: 'cancel', req: prior.req })
    const base = { key, buffer: '', title: prior?.title ?? '', lines: prior?.lines ?? [], pinned: prior?.pinned ?? false, open: prior?.open ?? true }
    const cached = this.sketchCache.get(key)
    if (cached !== undefined) {
      card.sketch = cached ? { ...base, req: null, title: cached.title, lines: cached.lines } : null
      return
    }
    const req = this.nextReq++
    card.sketch = { ...base, req }
    const english = this.wordingLanguage() === 'en'
    this.out.push({
      type: 'request', req, kind: 'sketch', tier: 'cloud', maxTokens: SKETCH_MAX_TOKENS, prompt,
      system: [system.replace('{language}', english ? 'in English' : "in the draft's language")],
    })
    this.metric('sketch-requested', { req, card: card.id })
  }

  private sketchPrompt(card: Card): string {
    const choices = card.rows.filter((row) => row.origin !== 'repo' || row.picked !== null).map((row) =>
      `- ${decisionLine({ statement: row.statement, option: this.rowText(row, row.picked ?? row.learned ?? row.defaults) })}`)
    const found = this.mentions.filter((m) => m.status === 'found').slice(0, 8)
    return [
      'Draft:', '<<<', this.text, '>>>',
      ...(card.read ? [`Read as: ${card.read}`] : []),
      ...(choices.length ? ['Choices:', ...choices] : []),
      ...(found.length ? [`Names in the code: ${found.map((m) => m.match ?? m.phrase).join(', ')}`] : []),
      ...(this.today ? [`Today is ${this.today}: sample dates are recent.`] : []),
    ].join('\n')
  }

  private onSketchReply(chunk: string, done: boolean, ok: boolean): void {
    const card = this.card!
    const sketch = card.sketch!
    sketch.buffer += chunk
    if (ok && !done) return
    const req = sketch.req
    sketch.req = null
    const parsed = ok ? parseSketch(sketch.buffer) : null
    sketch.buffer = ''
    if (ok) this.sketchCache.set(sketch.key, parsed)
    if (parsed) Object.assign(sketch, { title: parsed.title, lines: parsed.lines })
    else if (ok || !sketch.lines.length) card.sketch = null
    this.metric('sketch-reply', { req, card: card.id, ok, lines: parsed?.lines.length ?? 0 })
  }

  private pinnedSketch(): string | null {
    const sketch = this.card?.stage === 'draft' ? this.card.sketch : null
    if (!sketch?.pinned || !sketch.lines.length) return null
    return `Target output, as sketched (${sketch.title}):\n\`\`\`text\n${sketch.lines.join('\n')}\n\`\`\``
  }

  // ---- after Enter: the agent's own choices, then the receipt ----------------------

  private onCardSubmit(prompt: boolean, exact: boolean, amendable: boolean, added: string[]): void {
    const card = exact && this.card?.stage === 'draft' ? this.card : null
    if (prompt && this.enabled) {
      this.metric('card-submitted', {
        ...(card && { card: card.id }), rows: card?.rows.length ?? 0,
        picked: card?.rows.filter((row) => row.picked !== null).length ?? 0,
        reading: card ? card.req !== null : false, sketch: card?.sketch?.pinned ?? false,
      })
      for (const row of card?.rows ?? []) {
        if (row.picked !== null && row.origin !== 'repo' && row.type !== 'many') {
          this.out.push({ type: 'learn', key: row.key, label: rowValue(row, row.picked) })
        }
      }
    }
    if (this.turnRunning) {
      // A message typed while the agent works is queued by the engine: its decisions wait for the turn that
      // runs it, and meanwhile the agent's own choices come back on screen.
      if (this.card?.stage === 'draft') this.clearCard()
      this.pendingSent.push(...added.filter((line) => !line.startsWith('Where things are:')))
      if (this.turnCard) this.card = this.turnCard
      return
    }
    this.turnRunning = prompt && amendable
    this.clearCard()
    if (!this.turnRunning) return
    this.card = this.turnCard = this.newCard('turn')
    this.card.submittedAt = this.now
    // The receipt lists the choices that travelled; where names live in the code is not one.
    this.card.sent = added.filter((line) => !line.startsWith('Where things are:'))
  }

  private onBlank(label: string, choice: string, alternatives: string[]): void {
    if (!this.enabled || this.sheetEnabled !== true || !this.turnRunning) return
    if (!this.turnCard) {
      this.turnCard = this.newCard('turn')
      this.turnCard.submittedAt = this.now
      if (this.card?.stage !== 'draft') {
        this.setAside()
        this.card = this.turnCard
      }
    }
    const card = this.turnCard
    const key = `blank_${nameKey(label)}`.slice(0, 40)
    const options = [choice, ...alternatives.filter((alt) => normalize(alt) !== normalize(choice))].slice(0, 5)
    const row = card.rows.find((entry) => entry.key === key)
    if (row) {
      if (normalize(row.options[0] ?? '') === normalize(choice)) return
      // The agent restated the choice with another value: its newer word stands.
      Object.assign(row, { options, defaults: [0], picked: null, sent: undefined })
    } else {
      if (card.rows.length >= 8 || card.dismissed.has(key)) return
      card.rows.push({
        id: this.newId(), key, label: cutLabel(label), type: 'one', statement: `${label}: {}`,
        options, defaults: [0], origin: 'agent', picked: null,
      })
    }
    if (card.focus === null || !card.rows.some((row) => row.id === card.focus)) card.focus = card.rows[0]?.id ?? null
    this.metric('blank', { card: card.id, row: key, options: options.length })
  }

  private sendAgentChanges(): void {
    const card = this.turnCard
    if (!card) return
    card.amendDue = null
    for (const row of card.rows) {
      if (row.origin !== 'agent' || row.picked === null) continue
      const before = row.sent ?? row.defaults
      if (sameSelection(row.picked, before)) continue
      const i = row.picked[0] ?? 0
      row.sent = [i]
      this.sendAmendment(row.id, i, `for ${row.label}, use ${row.options[i]} instead of ${row.options[before[0] ?? 0]}.`, card.submittedAt ?? this.now)
    }
  }

  private endTurnCard(): void {
    const card = this.turnCard
    this.turnCard = null
    const drafting = this.card?.stage === 'draft'
    if (!card) {
      if (!drafting) this.clearCard()
      return
    }
    const agent = card.rows.filter((row) => row.origin === 'agent')
    if (card.sent.length || agent.length) {
      this.receipt = {
        id: this.nextReceipt++, yours: card.sent,
        agent: agent.map((row) => {
          const now = (row.sent ?? row.defaults)[0] ?? 0
          return { label: row.label, value: row.options[now]!, ...(now !== 0 && { was: row.options[0]! }), options: [...row.options] }
        }),
      }
      this.metric('receipt', { id: this.receipt.id, yours: card.sent.length, agent: agent.length, changed: agent.filter((row) => row.sent).length })
    }
    // Someone already writing their next message keeps their draft's card; the receipt holds the switches.
    if (drafting) return
    this.card = null
    if (!agent.length) return
    const after = this.newCard('after')
    after.rows = agent.map((row) => {
      const current = row.sent ?? row.defaults
      const pending = row.picked !== null && !sameSelection(row.picked, current) ? row.picked : null
      return { ...row, defaults: [...current], picked: pending, sent: undefined }
    })
    this.card = after
    this.fixCardFocus()
    if (after.rows.some((row) => row.picked !== null)) this.fillFollowUp()
  }

  /** After the turn, a switched choice becomes a follow-up prompt waiting in the composer. */
  private fillFollowUp(): void {
    const card = this.card
    if (!card || card.stage !== 'after') return
    const lines = card.rows.filter((row) => row.picked !== null && !sameSelection(row.picked, row.defaults))
      .map((row) => `Change ${row.label}: ${row.options[row.picked![0] ?? 0]} instead of ${row.options[row.defaults[0] ?? 0]}.`)
    const text = lines.length ? `${lines.join(' ')} Keep everything else as it is.` : ''
    if (text === (card.fill ?? '')) return
    this.out.push({ type: 'fill', text, replaces: card.fill })
    card.fill = text || null
  }

  // ---- amendments --------------------------------------------------------

  private onLateReply(chunk: string, done: boolean, ok: boolean): void {
    const late = this.late!
    if (this.now >= late.expires) {
      this.dropAmendment('expired')
      return
    }
    const buffer = (late.review.buffers.full ?? '') + chunk
    late.review.buffers.full = buffer
    if (!done && ok) return
    this.late = null
    if (!ok) return
    const parsed = parseReply(buffer, true, 1).cues[0]
    if (!parsed) return
    const id = this.newId()
    this.amendment = {
      cue: {
        id, anchor: parsed.anchor ?? '', statement: parsed.statement, options: parsed.options,
        chosen: null, pending: null, stale: false, provisional: false, held: false,
      },
      submittedAt: late.submittedAt, expires: late.expires,
    }
    if (this.audit) this.metric('candidate', {
      tier: 'amendment', cue: id, shown: true, reason: 'late-reply',
      optionOrder: parsed.options.map((_, i) => i), default: 0, ms: this.now - late.submittedAt,
    })
  }

  private onAmend(id: string, option: number): void {
    const row = this.turnCard?.rows.find((entry) => entry.id === id)
    if (row) {
      if (row.options[option] === undefined) return
      row.picked = [option]
      this.sendAgentChanges()
      return
    }
    const pending = this.amendment
    if (!pending || pending.cue.id !== id || this.now >= pending.expires) return
    const label = pending.cue.options[option]
    if (label === undefined) return
    const line = decisionLine({ statement: pending.cue.statement, option: label })
    this.sendAmendment(id, option, line, pending.submittedAt)
    this.amendment = null
  }

  private sendAmendment(id: string, option: number, line: string, submittedAt: number): void {
    this.out.push({ type: 'amend', cue: id, option, text: `Amendment to my last prompt: ${line}`, ms: this.now - submittedAt })
  }

  private dropAmendment(reason: string): void {
    if (this.late) this.out.push({ type: 'cancel', req: this.late.review.full })
    if (this.audit && this.amendment) this.metric('cueAction', { cue: this.amendment.cue.id, action: 'dismissed', reason })
    this.late = null
    this.amendment = null
  }

  // ---- scheduling ---------------------------------------------------------

  private schedule(origin: Origin, splice: Splice | null): void {
    if (!this.enabled) return
    if (this.sheetEnabled !== undefined) {
      if (this.cardAllowed()) this.scheduleCard(origin, splice)
      else this.reviewAt = null
      return
    }
    if (this.sheetEnabled === undefined && !this.cloudAllowed()) {
      if (this.audit && this.mode !== undefined && this.stateDraft) {
        this.metric('review-suppressed', { tier: 'cloud', reason: this.cloudSuppression() })
      }
      this.cancelAll()
      this.reviewAt = null
      this.cues = this.mode === undefined ? [] : this.cues.filter((cue) => cue.chosen !== null)
      this.fixFocus()
      return
    }
    const { idleMs, minGapMs } = this.timing
    const immediate = origin !== 'type' || (splice !== null && completesClause(splice, this.mode !== undefined))
    const last = this.lastFireAt
    if (immediate && (origin !== 'type' || last === null || this.now - last >= minGapMs)) {
      this.fireScheduled()
      return
    }
    const editedAt = this.sheetEnabled === undefined ? this.now : this.textAt
    let at = immediate ? (last as number) + minGapMs : editedAt + idleMs
    if (last !== null) at = Math.max(at, last + minGapMs)
    if (this.sheetEnabled !== undefined && at <= this.now) this.fireScheduled()
    else this.reviewAt = at
  }

  private fireScheduled(): void {
    if (this.sheetEnabled === undefined) this.fire()
    else this.fireCard()
  }

  private requestText(): { prompt: string; key: string } {
    const prompt = buildPrompt({
      complete: true,
      draft: applyDecisions(this.text, this.decisions()),
      dismissed: this.dismissed.map((d) => d.statement),
    })
    return { prompt, key: `${this.profileName}
${prompt}` }
  }

  private fire(): void {
    this.reviewAt = null
    const { prompt, key } = this.requestText()

    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.appliedSeq = this.nextReview - 1
      for (const review of [...this.reviews]) this.removeReview(review)
      this.reconcile(cached, true, true)
      this.lastError = false
      this.metric('cache', { cues: cached.length })
      return
    }
    if (this.reviews.some((r) => r.key === key)) return

    while (this.reviews.length >= Math.max(1, this.timing.maxInflight)) this.removeReview(this.reviews[0] as Review)
    const review: Review = {
      seq: this.nextReview++,
      generation: this.generation,
      key,
      text: this.text,
      textAt: Math.max(this.textAt, this.actionAt),
      full: 0,
      plan: null,
      planDone: false,
      firstAt: null,
      buffers: {},
    }
    if (this.eagerPlan && !this.streaming) {
      review.plan = this.nextReq++
      this.out.push({ type: 'request', req: review.plan, kind: 'plan', system: [...this.system], prompt, maxTokens: this.timing.planMaxTokens })
    }
    review.full = this.nextReq++
    this.out.push({
      type: 'request', req: review.full, kind: 'full', system: [...this.system], prompt, maxTokens: this.timing.fullMaxTokens,
      ...(this.mode && { tier: 'cloud' as const }),
    })
    this.reviews.push(review)
    this.lastFireAt = this.now
    this.lastError = false
  }

  /** Drops a review, cancelling whichever of its requests are still running. */
  private removeReview(review: Review, fullDone = false): void {
    const at = this.reviews.indexOf(review)
    if (at === -1) return
    this.reviews.splice(at, 1)
    if (review.plan !== null && !review.planDone) this.out.push({ type: 'cancel', req: review.plan })
    if (!fullDone) this.out.push({ type: 'cancel', req: review.full })
  }

  private cancelAll(): void {
    for (const review of [...this.reviews]) this.removeReview(review)
  }

  // ---- cues ---------------------------------------------------------------

  /**
   * Held: the person is still writing the sentence the cue sits in. All of:
   * the caret is at the end; the anchor lies in the last sentence; that
   * sentence is unterminated; the last edit is under settleMs old; and the
   * text runs fewer than holdChars past the anchor's end.
   */
  private isHeld(cue: Cue): boolean {
    if (cue.start === undefined || cue.end === undefined) return false
    const text = this.text
    if (this.cursor !== text.length) return false
    if (isTerminated(text)) return false
    if (cue.start < lastSentenceStart(text)) return false
    if (this.now - this.textAt >= this.timing.settleMs) return false
    return text.length - cue.end < this.timing.holdChars
  }

  private addProvisional(anchors: string[]): void {
    for (const anchor of anchors) {
      if (this.cues.length >= this.profile.maxCues) break
      const span = resolveAnchor(this.text, anchor)
      if (!span) continue
      if (this.cues.some((c) => c.start !== undefined && c.end !== undefined && c.start < span.end && span.start < c.end)) continue
      const found = this.text.slice(span.start, span.end)
      if (this.dismissed.some((d) => d.anchor !== '' && normalize(d.anchor) === normalize(found))) continue
      this.cues.push({
        id: this.newId(),
        start: span.start,
        end: span.end,
        anchor: found,
        statement: '',
        options: [],
        chosen: null,
        pending: null,
        stale: false,
        provisional: true,
      })
    }
    this.fixFocus()
  }

  private reconcile(fresh: ParsedCue[], current: boolean, final: boolean): void {
    const used = new Set<string>()
    const next: Cue[] = []
    for (const parsed of fresh) {
      if (this.isDismissed(parsed)) continue
      const anchorKey = normalize(parsed.anchor ?? '')
      const existing = this.cues.find((c) => !used.has(c.id) && !c.provisional && sameCue(c, parsed))
      if (!existing && this.isSettled(parsed)) continue

      let span: Span | null = null
      if (parsed.anchor !== null) {
        const provisional = this.cues.find((c) => c.provisional && !used.has(c.id) && normalize(c.anchor) === anchorKey)
        span = resolveAnchor(this.text, parsed.anchor, existing?.start ?? provisional?.start)
        if (!span && !current) continue
      }
      const placed: Placed = span
        ? { start: span.start, end: span.end, anchor: this.text.slice(span.start, span.end) }
        : { anchor: parsed.anchor ?? '' }

      if (existing) {
        used.add(existing.id)
        const kept: Cue = { ...existing, stale: !current, provisional: false }
        if (current && final && kept.pending !== null) {
          kept.chosen = kept.pending
          kept.pending = null
        }
        next.push(placeCue(kept, placed))
        continue
      }
      const provisional = span
        ? (this.cues.find((c) => c.provisional && !used.has(c.id) && c.start === span.start && c.end === span.end) ??
          this.cues.find((c) => c.provisional && !used.has(c.id) && normalize(c.anchor) === anchorKey))
        : undefined
      if (provisional) used.add(provisional.id)
      const cue: Cue = {
        id: provisional ? provisional.id : this.newId(),
        anchor: '',
        statement: parsed.statement,
        options: [...parsed.options],
        chosen: null,
        pending: null,
        stale: !current,
        provisional: false,
      }
      next.push(placeCue(cue, placed))
    }
    for (const cue of this.cues) {
      if (used.has(cue.id)) continue
      if (current && final && cue.pending !== null) {
        // The reply for the current text no longer has this cue: its pick goes.
        this.note = NOTE_PICK_DROPPED
        this.metric('pickDropped', {})
        continue
      }
      // A confirmed decision stays until its anchor is edited or it is dismissed.
      if (cue.chosen !== null) next.push(current && final ? { ...cue, stale: false } : cue)
      else if (!final) next.push(cue)
    }
    this.cues = next
    this.fixFocus()
  }

  private isDismissed(parsed: ParsedCue): boolean {
    const statement = normalize(parsed.statement)
    return this.dismissed.some((d) => normalize(d.statement) === statement || sameCue(d, parsed))
  }

  /** A fresh cue restating a decision the user already made. */
  private isSettled(parsed: ParsedCue): boolean {
    const statement = normalize(parsed.statement)
    return this.cues.some((c) => c.chosen !== null && normalize(c.statement) === statement)
      || this.mode !== undefined && this.decisions().some((decision) => normalize(decision.statement) === statement)
  }

  /** The focus stays on its cue while that cue exists; else it goes to the first open cue, else the first. */
  private fixFocus(): void {
    if (this.focus !== null && this.cues.some((c) => c.id === this.focus)) return
    const open = this.cues.find((c) => c.chosen === null && c.pending === null)
    this.focus = open ? open.id : (this.cues[0]?.id ?? null)
  }

  /** The next cue after `id` (cyclic) with nothing chosen or pending. */
  private nextOpen(id: string): string | null {
    const at = this.cues.findIndex((c) => c.id === id)
    for (let i = 1; i < this.cues.length; i++) {
      const cue = this.cues[(at + i) % this.cues.length] as Cue
      if (cue.chosen === null && cue.pending === null) return cue.id
    }
    return null
  }

  private decisions(includeCard = true): Decision[] {
    const out: Decision[] = []
    for (const cue of this.cues) {
      if (cue.provisional || cue.chosen === null) continue
      const option = typeof cue.chosen === 'number' ? cue.options[cue.chosen] : cue.chosen
      if (option !== undefined) out.push({ statement: cue.statement, option })
    }
    if (this.mode === undefined) return out
    if (includeCard && this.card?.stage === 'draft') out.push(...this.cardDecisions())
    const standing: Decision[] = []
    const draft = this.stateDraft
    if (draft && this.enabled) {
      const language = this.wordingLanguage(draft)
      for (const result of draft.results) {
        if (result.status === 'filled' && result.value
          || this.confirmed.has(result.slot.id) && !draft.suppresses(result.slot)) {
          const value = result.value ?? this.state.resolve(result.slot.id)
          if (!value || this.state.instructionSlots.has(result.slot.id)) continue
          if (result.slot.requires?.some((fact) => draft.facts.get(fact) !== true)) continue
          if (value.option !== 'other' && !draft.available(result.slot).some((option) => option.id === value.option)) continue
          const decision = decisionFor(result.slot, value, language, this.depth)
          if (decision) standing.push(decision)
        }
      }
    }
    const unique = new Map<string, Decision>()
    for (const decision of [...out, ...this.expertPicks.values(), ...standing]) {
      unique.set(normalize(decision.statement), decision)
    }
    return [...unique.values()]
  }

  private cloudAllowed(): boolean {
    return this.sheetEnabled === undefined && this.cloudSuppression() === null
  }

  private cloudSuppression(): string | null {
    if (!this.enabled || !this.reviewable()) return 'ineligible'
    if (this.mode === undefined) return null
    if (this.mode === 'quiet') return 'quiet'
    const draft = this.stateDraft
    if (!draft) return 'ineligible'
    if (draft.directive === 'delegate') return 'prompt-delegates'
    if (this.mode === 'on' || draft.directive === 'ask' || !this.submitted) return null
    if (draft.followUp) return 'follow-up'
    return draft.words < 40 ? 'short-follow-up' : null
  }

  private reviewable(): boolean {
    const text = this.text
    if (isHostCommand(text)) return false
    const trimmed = text.trim()
    if (trimmed.length < this.timing.minChars) return false
    return trimmed.split(/\s+/).length >= this.timing.minWords
  }

  private noteFirst(review: Review, req: number, kind: string, hasSignal: boolean): void {
    if (review.firstAt !== null || !hasSignal) return
    review.firstAt = this.now
    this.metric('first', { req, kind, ms: this.now - review.textAt })
  }

  private newId(): string {
    return `c${this.nextCue++}`
  }

  private metric(name: string, values: Record<string, unknown>): void {
    this.out.push({ type: 'metric', name, ...values })
  }

  /** The wake-up the core wants: the next review, or the release of a held cue. */
  private wantedTimer(): number | null {
    let at = this.reviewAt
    if (this.enabled && this.cues.some((c) => this.isHeld(c))) {
      const release = this.textAt + this.timing.settleMs
      at = at === null ? release : Math.min(at, release)
    }
    const expiry = this.late?.expires ?? this.amendment?.expires
    if (expiry !== undefined) at = at === null ? expiry : Math.min(at, expiry)
    for (const due of [this.card?.sketchDue, this.turnCard?.amendDue]) {
      if (due != null) at = at === null ? due : Math.min(at, due)
    }
    return at
  }

  private flush(): void {
    const at = this.wantedTimer()
    if (at !== this.sentTimerAt) {
      this.out.push({ type: 'timer', at })
      this.sentTimerAt = at
    }
    const view = this.currentView()
    const json = JSON.stringify(view)
    if (json !== this.sentView) {
      this.sentView = json
      this.out.push({ type: 'view', view })
    }
  }
}

/** Slash commands, `!` shell lines and `#` memory lines are never reviewed. */
export function isHostCommand(text: string): boolean {
  return /^\s*[/!#]/.test(text)
}

/** Typing that completes a sentence: the inserted text ends in `.`, `?`, `!` or a newline. */
function completesClause(splice: Splice, clauses: boolean): boolean {
  return (clauses ? /[,.?!:;\n][)"'”’»\]]*[ \t]*$/ : /[.?!\n]$/).test(splice.text)
}

function sameOptions(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = a.map(normalize).sort()
  const right = b.map(normalize).sort()
  return left.every((value, i) => value === right[i])
}

type Placed = { start?: number; end?: number; anchor: string }

function placeCue(cue: Cue, placed: Placed): Cue {
  const out: Cue = { ...cue, anchor: placed.anchor }
  delete out.start
  delete out.end
  if (placed.start !== undefined && placed.end !== undefined) {
    out.start = placed.start
    out.end = placed.end
  }
  return out
}

/** A cue as the view carries it, keys in a fixed order so every port serialises it alike. */
function viewCue(cue: Cue, held: boolean): CueView {
  const out = { id: cue.id } as CueView
  if (cue.start !== undefined && cue.end !== undefined) {
    out.start = cue.start
    out.end = cue.end
  }
  out.anchor = cue.anchor
  out.statement = cue.statement
  out.options = [...cue.options]
  out.chosen = cue.chosen
  out.pending = cue.pending
  out.stale = cue.stale
  out.provisional = cue.provisional
  out.held = held
  return out
}

function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}

function cutLabel(text: string): string {
  const label = text.trim().toLowerCase().replace(/\s+/g, ' ')
  return label.length <= 16 ? label : `${label.slice(0, 15).trimEnd()}\u2026`
}

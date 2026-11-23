import { diffSplice, resolveAnchor, shiftSpan, spliceFits } from './anchor'
import type { Span } from './anchor'
import { applyDecisions, attachDecisions, decisionLine } from './decisions'
import { DecisionDraft, DecisionState, decisionFor, eligibleSlot, stateCue } from './state'
import type { SlotResult, StateChange } from './state'
import type { Depth, Language, Mode, Scope } from './bundle'
import { expertPrompt, MAX_EXPERT_CUES, parseExpert } from './expert'
import { startsSomethingNew } from './kickoff'
import { Lru } from './lru'
import { normalize, parseReply } from './parse'
import { parseProfile } from './profile'
import { buildPrompt, buildSystem, isTerminated, lastSentenceStart } from './request'
import { parseSheet, SHEET_MAX_TOKENS } from './sheet'
import type {
  Assets,
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
  SheetItem,
  SheetView,
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

type Sheet = {
  id: number
  startedAt: number
  pending: boolean
  buffer: string
  items: SheetItem[]
  focus: string | null
  language: Language
  pane: { ids: string[]; at: number } | null
  shownAt: number | null
  submittedAt: number | null
}

const AMEND_MS = 3500

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
  private sheetEnabled: boolean | undefined
  private sheet: Sheet | null = null
  private readonly sheetRequested = new Set<string>()
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
        this.onPick(event.cue, event.option, event.cycle)
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
          this.clearSheet()
          this.reviewAt = null
        }
        break
      case 'endAmendment':
        this.dropAmendment('turn-ended')
        if (this.turnRunning) {
          this.turnRunning = false
          this.clearSheet()
          if (this.sheetAllowed()) this.schedule('type', null)
        }
        break
      case 'sheetPane':
        this.onSheetPane(event)
        break
      case 'sheetAnswer':
        this.onSheetAnswer(event)
        break
      case 'sheetShown':
        this.onSheetShown(event.id)
        break
    }
    this.flush()
    return this.out
  }

  storedDecisions() { return this.state.list() }

  /** The view as it stands at the last event's time, without emitting anything. */
  currentView(): View {
    const state = this.mode === undefined ? undefined : this.decisionView()
    const sheet = this.sheetView()
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
      ...(sheet && { sheet }),
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
    if (!enabled || sheetEnabled !== true || languageChanged || (profileChanged || depthChanged) && this.sheet?.submittedAt === null) {
      this.clearSheet()
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
      if (this.sheetEnabled !== undefined && !this.turnRunning) {
        this.clearSheet()
        this.reviewAt = null
      }
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
      if (this.sheetEnabled === undefined ? this.cloudAllowed() : this.sheetAllowed()) this.fireScheduled()
    }
    // A held cue past its settle point is released by the view this flush computes.
  }

  private onReply(req: number, chunk: string, done: boolean, ok: boolean): void {
    if (this.sheet?.id === req && this.sheet.pending) {
      this.onSheetReply(chunk, done, ok)
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

  private onPick(id: string, option: number | string | null, cycle = false): void {
    const item = this.sheet?.items.find((item) => item.id === id)
    if (item && this.sheet) {
      this.onSheetPick(this.sheet, item, option, cycle)
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
    const sheet = this.sheet
    if (sheet && (id === `sheet-${sheet.id}` || sheet.items.some((item) => item.id === id))) {
      const all = id === `sheet-${sheet.id}`
      this.metric('sheet-dismissed', {
        req: sheet.id, ...(all ? {} : { item: id }), items: all ? sheet.items.length : 1, afterSubmit: sheet.submittedAt !== null,
      })
      if (all) this.clearSheet()
      else this.removeSheetItem(sheet, id)
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
    const sheet = this.sheet
    if (sheet?.items.length && (id === undefined || sheet.items.some((item) => item.id === id))) {
      if (id !== undefined) sheet.focus = id
      else {
        const index = sheet.items.findIndex((item) => item.id === sheet.focus)
        const next = index === -1 && dir === -1 ? sheet.items.length - 1 : index + (dir ?? 1)
        sheet.focus = sheet.items[next]?.id ?? null
      }
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
    const { text: sent, added } = attachDecisions(text, decisions)
    if (this.sheetEnabled !== undefined) this.onSheetSubmit(prompt, exact, amendable)
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
    this.clearSheet()
    this.sheetRequested.clear()
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

  // ---- kick-off sheet -----------------------------------------------------

  private sheetAllowed(): boolean {
    return this.enabled && this.sheetEnabled === true && Boolean(this.assets.sheetSystem) && !this.turnRunning &&
      !this.sheetRequested.has(this.text) && !isHostCommand(this.text) &&
      startsSomethingNew(this.text, { firstOfSession: !this.submitted })
  }

  private fireSheet(): void {
    this.reviewAt = null
    const req = this.nextReq++
    const language = this.wordingLanguage()
    const instruction = this.language === 'en' ? 'in English' : 'in the language of the request'
    const reminder = this.language === 'en' && this.stateDraft?.language === 'fr'
      ? 'Write every question and option in English, even when the draft is in French.\n\n' : ''
    const system = [reminder + this.assets.sheetSystem!.replace('{language}', instruction)]
    if (this.profileName !== 'general') {
      const cards = this.state.forProfile(this.profileName).slice(0, 12).map((slot) => {
        const cue = stateCue({ slot, options: slot.options }, language, this.depth)
        return `- ${cue.statement.replace('{}', '…')} (${cue.options.map((option) => option.label).join(' / ')})`
      })
      if (cards.length) system.push(`\n\nPrefer these profile decisions when the request touches them.\n${cards.join('\n')}`)
    }
    this.sheetRequested.add(this.text)
    this.sheet = {
      id: req, startedAt: this.now, pending: true, buffer: '', items: [], focus: null, language,
      pane: null, shownAt: null, submittedAt: null,
    }
    this.lastFireAt = this.now
    this.out.push({ type: 'request', req, kind: 'sheet', system, prompt: this.text, maxTokens: SHEET_MAX_TOKENS })
    this.metric('sheet-requested', { req })
  }

  private onSheetReply(chunk: string, done: boolean, ok: boolean): void {
    const sheet = this.sheet!
    sheet.buffer += chunk
    if (ok && !done) return
    sheet.pending = false
    sheet.items = ok ? parseSheet(sheet.buffer).map((item) => ({ ...item, id: this.newId(), chosen: null, pending: null })) : []
    sheet.buffer = ''
    this.metric('sheet-reply', { req: sheet.id, items: sheet.items.length, ms: this.now - sheet.startedAt, empty: !sheet.items.length, ok })
  }

  private sheetView(): SheetView | undefined {
    const sheet = this.sheet
    if (!sheet || (!sheet.pending && !sheet.items.length)) return
    const pane = sheet.pane
    return {
      id: sheet.id, items: sheet.items, pending: sheet.pending, focus: sheet.focus, language: sheet.language,
      afterSubmit: sheet.submittedAt !== null, collapsed: this.mode === 'quiet',
      ...(pane && { pane: {
        item: pane.ids[pane.at]!, position: pane.at + 1, total: pane.ids.length,
        canGoBack: pane.ids.slice(0, pane.at).some((id) => sheet.items.some((item) => item.id === id)),
      } }),
    }
  }

  private onSheetPane({ id, move, cue }: Extract<Event, { type: 'sheetPane' }>): void {
    const sheet = this.sheet
    if (sheet?.id !== id) return
    if (move === 'open') {
      const at = sheet.items.findIndex((item) => cue === undefined ? item.chosen === null : item.id === cue)
      if (at < 0 || sheet.pane) return
      sheet.pane = { ids: sheet.items.map((item) => item.id), at }
      this.metric('sheet-pane-opened', { req: id, afterSubmit: sheet.submittedAt !== null })
    } else if (move === 'close') this.closeSheetPane(sheet)
    else this.moveSheetPane(sheet, move === 'back' ? -1 : 1)
  }

  private moveSheetPane(sheet: Sheet, direction: -1 | 1): void {
    const pane = sheet.pane
    if (!pane) return
    for (let i = pane.at + direction; i >= 0 && i < pane.ids.length; i += direction) {
      const item = sheet.items.find((entry) => entry.id === pane.ids[i])
      if (item && (direction < 0 || item.chosen === null)) {
        pane.at = i
        return
      }
    }
    if (direction > 0) this.closeSheetPane(sheet)
  }

  private closeSheetPane(sheet: Sheet): void {
    if (!sheet.pane) return
    sheet.pane = null
    const open = sheet.items.filter((item) => item.chosen === null).length
    if (open) this.metric('sheet-pane-closed', { req: sheet.id, open, afterSubmit: sheet.submittedAt !== null })
  }

  private onSheetAnswer(event: Extract<Event, { type: 'sheetAnswer' }>): void {
    const sheet = this.sheet
    if (sheet?.id !== event.id) return
    const afterSubmit = sheet.submittedAt !== null
    const pane = sheet.pane
    const current = event.via === 'pane' ? pane?.ids[pane.at]
      : !pane && afterSubmit && this.mode !== 'quiet' ? sheet.items[0]?.id : undefined
    if (current !== event.cue) return
    const item = sheet.items.find((entry) => entry.id === current)
    if (item?.options[event.option] === undefined) return
    this.onSheetPick(sheet, item, event.option, false)
    this.metric(event.via === 'pane' ? 'sheet-pane-answer' : 'sheet-composer-answer',
      { req: sheet.id, item: item.id, option: event.option, afterSubmit })
    if (pane) this.moveSheetPane(sheet, 1)
  }

  private onSheetShown(id: number): void {
    const sheet = this.sheet
    if (sheet?.id !== id || !sheet.items.length || sheet.shownAt !== null) return
    sheet.shownAt = this.now
    this.metric('sheet-shown', { req: id, items: sheet.items.length, afterSubmit: sheet.submittedAt !== null })
  }

  private onSheetPick(sheet: Sheet, item: SheetItem, option: Chosen, cycle: boolean): void {
    if (option !== null && (typeof option !== 'number' || item.options[option] === undefined)) return
    const afterSubmit = sheet.submittedAt !== null
    if (afterSubmit && !cycle) {
      if (option !== null) this.onAmend(item.id, option)
      return
    }
    const selection = afterSubmit ? 'pending' : 'chosen'
    sheet.focus = item.id
    if (item[selection] === option) return
    sheet.items = sheet.items.map((entry) => entry === item ? { ...entry, [selection]: option } : entry)
    if (!afterSubmit) this.sheetPickMetric(sheet, item.id, option)
  }

  private sheetPickMetric(sheet: Sheet, item: string, option: number | null): void {
    this.metric('sheet-pick', { req: sheet.id, item, option, afterSubmit: sheet.submittedAt !== null,
      ms: sheet.shownAt === null ? null : this.now - sheet.shownAt })
  }

  private onSheetSubmit(prompt: boolean, exact: boolean, amendable: boolean): void {
    if (prompt && exact && amendable && this.sheetAllowed()) this.fireSheet()
    const sheet = exact && !this.turnRunning ? this.sheet : null
    if (prompt && this.enabled) {
      const picked = sheet?.items.filter((item) => item.chosen !== null).length ?? 0
      this.metric('sheet-submitted', { ...(sheet && { req: sheet.id }), picked,
        open: (sheet?.items.length ?? 0) - picked, pending: sheet?.pending ?? false })
    }
    if (this.turnRunning) return
    this.turnRunning = prompt && amendable
    if (!this.turnRunning || !sheet) {
      this.clearSheet()
      return
    }
    sheet.submittedAt = this.now
    this.closeSheetPane(sheet)
    sheet.items = sheet.items.filter((item) => item.chosen === null)
    sheet.focus = null
  }

  private removeSheetItem(sheet: Sheet, id: string): void {
    const at = sheet.items.findIndex((item) => item.id === id)
    sheet.items = sheet.items.filter((item) => item.id !== id)
    if (sheet.focus === id) sheet.focus = (sheet.items[at] ?? sheet.items[0])?.id ?? null
  }

  private clearSheet(): void {
    if (this.sheet?.pending) this.out.push({ type: 'cancel', req: this.sheet.id })
    if (this.sheet) this.closeSheetPane(this.sheet)
    this.sheet = null
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
    const sheet = this.sheet
    const item = sheet?.items.find((item) => item.id === id)
    const choice = item?.options[option]
    if (sheet && sheet.submittedAt !== null && item && choice !== undefined) {
      this.sendAmendment(id, option, decisionLine({ statement: item.statement, option: choice, question: true }), sheet.submittedAt)
      this.sheetPickMetric(sheet, id, option)
      this.removeSheetItem(sheet, id)
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
    if (this.sheetEnabled !== undefined && !this.sheetAllowed()) {
      this.reviewAt = null
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
    else this.fireSheet()
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

  private decisions(includeSheet = true): Decision[] {
    const out: Decision[] = []
    for (const cue of this.cues) {
      if (cue.provisional || cue.chosen === null) continue
      const option = typeof cue.chosen === 'number' ? cue.options[cue.chosen] : cue.chosen
      if (option !== undefined) out.push({ statement: cue.statement, option })
    }
    if (this.mode === undefined) return out
    if (includeSheet && this.sheet?.submittedAt === null) {
      for (const item of this.sheet.items) {
        if (item.chosen !== null) out.push({ statement: item.statement, option: item.options[item.chosen]!, question: true })
      }
    }
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

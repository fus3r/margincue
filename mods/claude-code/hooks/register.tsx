// MarginCue for Claude Code: the thin host around the core.
//
// Host events become core events; `request` effects are fulfilled with
// $.model.complete; `view` effects are painted as underlines on the prompt box
// (returned from prompt.edit, or $.prompt.paint when a reply lands) and as one
// band above the prompt; the `submit` effect rewrites the sent text.

import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, PromptDecoration, Register, RenderSurface } from 'claude-code'

import { createCore, DEPTHS, isHostCommand, MODES, SCOPES } from '../core/index'
import type { Assets, Core, Depth, Effect, Event, LanguageSetting, Mode, Origin, Scope, StateLoad, Timing, View } from '../core/index'
import type { MargincueBand, MargincueExpert, MargincueReceipt } from '../types'
import { BLANK_OPEN, parseBlanks, renderBlanks } from '../core/card'
import type { ParsedBlank } from '../core/card'
import { nameKey } from '../core/grounding'
import { ASSETS } from './assets'
import { DARK, currentOption, layoutBandRows, paletteFor, scopeLabel, thinkingLabel } from './band'
import type { Action, Palette, Segment } from './band'
import { layoutReceipt, layoutSent, splitSent } from './card-view'
import { EventLog, loggedArm, trialCounts } from './event-log'
import type { Arm, LogIO } from './event-log'
import { depthFor, describeUser, interview, preferredProfiles, readUser } from './onboarding'
import type { UserProfile } from './onboarding'
import { collectVocabulary } from './repo-index'
import { optionalText, personalAssets, readAccount, readInstructionSlots, readLearned, readProject, saveDecision, saveLearned } from './storage'

type $ = EngineInterface
type RequestEffect = Extract<Effect, { type: 'request' }>
type MetricEffect = Extract<Effect, { type: 'metric' }>
type SubmitEffect = Extract<Effect, { type: 'submit' }>

const MODEL = 'haiku'
/** Measured (bench/latency/claude-mod.md): `low` keeps the model from thinking first. */
const EFFORT = 'low' as const
const TIMEOUT_MS = 8000
/** How long a `clear` of the box waits for the prompt.submit that usually follows it. */
const CLEAR_GRACE_MS = 1500
/** Timing the core gets from this host. */
const TIMING: Partial<Timing> = { idleMs: 280, minGapMs: 300, settleMs: 700, holdChars: 16, maxInflight: 2 }
/** The parallel capped `plan` request: off, measured not to help with this transport. */
const EAGER_PLAN = false

type Settings = {
  mode: Mode; profile: string; language: LanguageSetting; inline: boolean; sheet: boolean; ab: boolean; depths: Record<string, Depth>
  sketch: boolean; refs: boolean; blanks: boolean
  /** The first-run interview's answers, and whether it ran (or was closed, which is not asked again). */
  user: UserProfile | null; onboarded: 'done' | 'skipped' | null
}
const DEFAULTS: Settings = {
  mode: 'auto', profile: 'general', language: 'en', inline: false, sheet: true, ab: false, depths: {},
  sketch: true, refs: true, blanks: true, user: null, onboarded: null,
}
/** Re-read the project's names after a turn at most this often. */
const REINDEX_MS = 45000
const POLL_MS = 1200
const REVIEW_PANE = 'margincue-review'

const band = atom({ plugin: 'margincue', key: 'band' } as const, null)
const expert = atom({ plugin: 'margincue', key: 'expert' } as const, null)

// The module's own state. A hot reload starts it over; session.start then
// rebuilds the core from the stored settings and the box as it stands.
const host = {
  core: null as Core | null,
  settings: { ...DEFAULTS } as Settings,
  assets: ASSETS as Assets,
  root: '',
  epoch: 0,
  revision: 0,
  sample: null as StateLoad | null,
  sampleJson: '',
  storageWarning: '',
  pendingIO: Promise.resolve(),
  watcher: null as { cancel: () => void } | null,
  scopes: new Map<string, Scope>(),
  lastDraft: '',
  restoring: false,
  /** During a turn: the focused agent choice's options, which a bare digit in the empty composer picks. */
  bandChoices: [] as { row: string; option: number }[],
  receipts: new Map<number, MargincueReceipt>(),
  placed: new Set<number>(),
  blankSeen: new Set<string>(),
  /** Choices marked in replies from before the running turn: drawn again later, they are not this turn's. */
  blankOld: new Set<string>(),
  indexedAt: -Infinity,
  indexing: false,
  /** The follow-up text MarginCue last put in the composer; only that (or an empty box) is ever replaced. */
  lastFill: '',
  /** The first-run interview waits for the prompt to be drawn, then runs once. */
  onboardPending: false,
  onboarding: false,
  /** Only an amendment tied to this exact main turn is offered. */
  turn: null as { text: string; id: string | null } | null,
  activeTurn: null as string | null,
  interactive: false,
  sentExpert: '',
  view: null as View | null,
  timer: null as { cancel: () => void } | null,
  /** A `clear` of the box held back briefly: Enter clears the box before prompt.submit runs. */
  clear: null as { timer: { cancel: () => void }; cursor: number } | null,
  /**
   * The box is in shell mode. The editor takes a leading `!` as the mode switch
   * and leaves it out of the draft (no prompt.edit carries it), and no API says
   * which mode the box is in; the hint line under the prompt does ("! for shell
   * mode"), so a PromptHint hook reads it.
   */
  shell: false,
  inflight: new Map<number, AbortController>(),
  sentBand: '',
  eventLog: new EventLog(),
  trialLog: new EventLog(),
  arm: null as Arm | null,
  stats: { first: [] as number[], full: [] as number[], requests: 0, failures: 0, submits: 0, attached: 0 },
  /** The card's colours, from the person's theme (dark unless it is a light one). */
  palette: DARK as Palette,
}

/** A fired timer moves time to at least its due point: real timers fire late, never early, and a test's clock jumps. */
let timeFloor = 0
function now(): number {
  return Math.max(timeFloor, typeof performance !== 'undefined' ? performance.now() : Date.now())
}

function currentDepth(): Depth {
  return host.settings.depths[host.settings.profile] ?? 'standard'
}

function enabled(): boolean { return host.settings.mode !== 'off' }

function localDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function configEvent(): Event {
  return {
    type: 'config',
    enabled: enabled(),
    mode: host.settings.mode,
    language: host.settings.language,
    sheet: host.settings.sheet && host.arm !== 'control',
    sketch: host.settings.sketch,
    refs: host.settings.refs,
    today: localDate(),
    ...(host.settings.user && { user: describeUser(host.settings.user), prefer: preferredProfiles(host.settings.user) }),
    depths: host.settings.depths,
    depth: currentDepth(),
    audit: host.eventLog.active,
    profile: host.settings.profile,
    timing: TIMING,
    streaming: false,
    eagerPlan: EAGER_PLAN,
  }
}

function ensure($: $): Core {
  if (host.core) return host.core
  host.core = createCore(host.assets)
  run($, configEvent())
  return host.core
}

/** Feeds one event to the core and carries out its effects. */
function run($: $, event: Event, paint = true): Effect[] {
  const effects = ensure($).handle(event)
  const view = effects.find((fx) => fx.type === 'view')
  if (view) {
    // Dispatch the local view before starting any model or storage work.
    host.view = view.view
    publish($, view.view)
    if (paint) repaint($)
  }
  for (const fx of effects) {
    if (fx.type === 'request') request($, fx)
    else if (fx.type === 'cancel') {
      host.inflight.get(fx.req)?.abort()
      host.inflight.delete(fx.req)
    } else if (fx.type === 'timer') schedule($, fx.at)
    else if (fx.type === 'metric') metric($, fx)
    else if (fx.type === 'persist') save($, fx)
    else if (fx.type === 'amend') void deliverAmendment($, fx)
    else if (fx.type === 'fill') void fillComposer($, fx.text, fx.replaces)
    else if (fx.type === 'learn') learn($, fx.key, fx.label)
  }
  return effects
}

function schedule($: $, at: number | null): void {
  host.timer?.cancel()
  host.timer = null
  if (at === null) return
  const wait = Math.max(0, Math.round(at - now()))
  host.timer = $.clock.after(wait, () => fireTimer($, at))
}

/** Enter empties the box (prompt.change `clear`) before prompt.submit is raised. The core
 * would drop the cues and their decisions on that clear, so it waits: a submit that
 * follows takes its place, and any other event lets it through first. */
function holdClear($: $, cursor: number): void {
  flushClear($)
  host.clear = { cursor, timer: $.clock.after(CLEAR_GRACE_MS, () => flushClear($)) }
}

function flushClear($: $): void {
  const pending = host.clear
  if (!pending) return
  host.clear = null
  pending.timer.cancel()
  host.scopes.clear()
  run($, { type: 'draft', now: now(), text: '', origin: 'type', cursor: 0 })
}

function dropClear(): void {
  host.clear?.timer.cancel()
  host.clear = null
}

function fireTimer($: $, at: number): void {
  host.timer = null
  timeFloor = Math.max(timeFloor, at)
  run($, { type: 'timer', now: now() })
}

function repaint($: $): void {
  const view = host.view
  if (!view) return
  void $.prompt.paint({ text: view.text, decorations: decorate(view, view.text) }).catch(() => {})
}

function request($: $, fx: RequestEffect): void {
  const abort = new AbortController()
  host.inflight.set(fx.req, abort)
  host.stats.requests++
  const requestedAt = now()
  log($, 'request', { req: fx.req, tier: fx.kind === 'full' || fx.kind === 'plan' ? 'cloud' : fx.kind })
  // The fixed system text is the same on every call: mark its end for the prompt cache.
  const system = fx.system.map((text, i) => (i === fx.system.length - 1 ? { text, cache: true as const } : { text }))
  void $.model
    .complete(
      { model: MODEL, system, prompt: fx.prompt, maxTokens: fx.maxTokens, effort: EFFORT, timeoutMs: TIMEOUT_MS },
      { signal: abort.signal },
    )
    .then((r) => {
      if (abort.signal.aborted) return
      host.inflight.delete(fx.req)
      if (r.isAnswered) {
        run($, { type: 'reply', now: now(), req: fx.req, text: r.text, done: true })
        return
      }
      host.stats.failures++
      log($, 'request-failed', { req: fx.req, reason: r.reason, ms: Math.round(now() - requestedAt) })
      run($, { type: 'reply', now: now(), req: fx.req, text: '', done: true, ok: false })
    })
    .catch(() => {
      if (!abort.signal.aborted) failed($, fx.req)
    })
}

function failed($: $, req: number): void {
  host.inflight.delete(req)
  host.stats.failures++
  run($, { type: 'reply', now: now(), req, text: '', done: true, ok: false })
}

function metric($: $, fx: MetricEffect): void {
  const { stats } = host
  const ms = fx['ms']
  if (fx.name === 'first' && typeof ms === 'number') stats.first.push(Math.round(ms))
  if (fx.name === 'reply' && typeof ms === 'number') stats.full.push(Math.round(ms))
  if (fx.name === 'submit') {
    stats.submits++
    const n = fx['decisions']
    if (typeof n === 'number' && n > 0) stats.attached++
  }
  for (const list of [stats.first, stats.full]) if (list.length > 200) list.splice(0, list.length - 200)
  const { type: _type, name: _name, ...rest } = fx
  log($, fx.name, rest)
}

function logIO($: $): LogIO {
  return {
    read: (path) => optionalText($, path),
    write: (path, text) => $.fs.write(path, text),
    getSalt: () => $.store.get('log-salt'),
    setSalt: (value) => $.store.set('log-salt', value),
    getSession: () => $.session.id(),
    after: (ms, work) => $.clock.after(ms, work),
    warn: () => { void $.ui.toast('MarginCue could not append to the log. Check the path and the 4 MiB mod file limit.') },
  }
}

function log($: $, event: string, entry: Record<string, unknown> = {}): void {
  if (host.settings.mode === 'off') return
  const trial = host.arm && host.trialLog.active && (event === 'session-arm' || /^(?:card|sketch|blank|receipt)/.test(event))
  if (!host.eventLog.active && !trial) return
  const row = {
    event, mode: host.settings.mode, profile: host.settings.profile,
    bundles: (host.assets.bundles ?? []).map(({ profile, version }) => ({ profile, version })),
    ...(host.arm && { arm: host.arm }),
    ...entry,
  }
  const io = logIO($)
  host.eventLog.add(io, row)
  if (trial) host.trialLog.add(io, row)
}

async function trialFolder($: $): Promise<string> {
  const home = await $.env.get('HOME').catch(() => undefined) ?? await $.env.get('USERPROFILE')
  if (!home) throw new Error('No home directory for the A/B log')
  return home.replace(/[\\/]+$/, '') + '/.margincue/ab'
}

async function startTrial($: $, newSession: boolean): Promise<void> {
  if (!host.interactive || !host.settings.ab || !enabled()) return
  try {
    const folder = await trialFolder($)
    const io = logIO($)
    const prior = await host.trialLog.start(io, (session) => `${folder}/${session}.jsonl`, host.root)
    const previous = loggedArm(prior ?? '')
    if (!previous && !newSession) {
      await host.trialLog.stop(io)
      return
    }
    host.arm = previous ?? (Math.random() < 0.5 ? 'sheet' : 'control')
    if (!previous) {
      log($, 'session-arm', { sheetEnabled: host.settings.sheet })
      await host.trialLog.flush(io)
    }
  } catch {
    host.arm = null
    void $.ui.toast('MarginCue could not start the A/B event log.')
  }
}

async function trialStatus($: $): Promise<string> {
  await host.trialLog.flush(logIO($))
  const folder = await trialFolder($)
  const files = await $.fs.list(folder).catch(() => [])
  const logs = await Promise.all(files.filter((file) => file.kind === 'file' && /^[a-f0-9]{24}\.jsonl$/.test(file.name))
    .map((file) => $.fs.read(`${folder}/${file.name}`)))
  const arm = host.arm ? ` This session is in the ${host.arm} arm.` : ''
  return [`MarginCue A/B is ${host.settings.ab ? 'on' : 'off'}.${arm}`, ...trialCounts(logs)].join('\n')
}

function selectedScope(slot: string, fallback: Scope): Scope {
  const scope = host.scopes.get(slot) ?? fallback
  return scope === 'model' && !host.view?.state?.model ? fallback : scope
}

function publish($: $, v: View): void {
  const first = v.state?.first
  const canAmend = host.turn?.id && host.turn.id === host.activeTurn
  const next: MargincueBand = {
    enabled: v.enabled,
    phase: v.phase,
    profile: v.profile,
    hasDraft: v.text.trim() !== '' && !isHostCommand(v.text),
    cues: v.cues.filter((cue) => !cue.held),
    focus: v.focus,
    latencyMs: v.latencyMs === null ? null : Math.round(v.latencyMs),
    note: v.note,
    mode: v.state?.mode,
    depth: v.state?.depth,
    language: v.state?.language,
    marks: v.state?.marks,
    first: first ? { ...first, scope: selectedScope(first.slot, first.scope) } : null,
    open: v.state?.open,
    ...(canAmend && v.amendment && { amendment: v.amendment }),
    ...(v.card && (v.card.stage !== 'turn' || host.activeTurn !== null) && { card: v.card }),
    ...(v.expert?.phase === 'reviewing' && { reviewPending: true }),
    canReview: (host.assets.bundles ?? []).some((bundle) => bundle.profile === v.profile),
  }
  const json = JSON.stringify(next)
  if (json !== host.sentBand) {
    host.sentBand = json
    void $.state.set({ plugin: 'margincue', key: 'band' }, next).catch(() => {})
  }
  const checklist: MargincueExpert | null = v.expert ? {
    ...v.expert, language: v.state?.language ?? 'en', model: Boolean(v.state?.model),
    items: v.expert.items.map((item) => ({ ...item, scope: selectedScope(item.slot, item.scope) })),
  } : null
  const expertJson = JSON.stringify(checklist)
  if (expertJson !== host.sentExpert) {
    host.sentExpert = expertJson
    void $.state.set({ plugin: 'margincue', key: 'expert' }, checklist).catch(() => {})
  }
}

/** Underlines for the view's cues over `text`; none when the view is for another text. */
function decorate(v: View | null, text: string): PromptDecoration[] {
  if (!v || !v.enabled || v.text !== text) return []
  const out: PromptDecoration[] = []
  for (const mention of v.card?.mentions ?? []) {
    out.push({ start: mention.start, end: mention.end, underline: true, color: mention.status === 'found' ? 'suggestion' : 'warning' })
  }
  for (const row of v.card?.rows ?? []) {
    if (row.start === undefined || row.end === undefined || row.origin === 'repo') continue
    const focused = row.id === v.card?.focus
    out.push({
      start: row.start, end: row.end, underline: true,
      ...(row.chosen ? { color: 'success' } : focused ? {} : { dimColor: true }),
      ...(focused && { backgroundColor: host.palette.focus }),
    })
  }
  if (v.state?.first?.span) out.push({ ...v.state.first.span, underline: true, color: 'warning' })
  for (const mark of v.state?.marks ?? []) {
    if (mark.span) out.push({ ...mark.span, underline: true, color: 'success' })
  }
  for (const cue of v.cues) {
    if (cue.start === undefined || cue.end === undefined || cue.held) continue
    const focused = cue.id === v.focus
    const mark: PromptDecoration = { start: cue.start, end: cue.end, underline: true }
    if (cue.provisional || cue.stale) mark.dimColor = true
    else if (cue.chosen !== null) mark.color = 'success'
    else if (focused) mark.color = 'warning'
    out.push(mark)
    if (host.settings.inline && focused && !cue.provisional && cue.statement !== '') {
      const { text: option } = currentOption(cue)
      out.push({ start: cue.end, end: cue.end, virtualText: cue.chosen === null ? ` ‹${option}›` : ` ‹✓ ${option}›`, dimColor: true })
    }
  }
  return out
}

async function saveSettings($: $): Promise<void> {
  const { mode, profile, language, inline, sheet, ab, depths, sketch, refs, blanks, user, onboarded } = host.settings
  await $.store.set('settings', { mode, enabled: mode !== 'off', profile, language, inline, sheet, ab, depths, sketch, refs, blanks, user, onboarded })
}

function enqueue(work: () => Promise<void>): Promise<void> {
  const task = host.pendingIO.then(work)
  host.pendingIO = task.catch(() => {})
  return task
}

async function refresh($: $, submitted?: boolean): Promise<void> {
  if (!enabled()) return
  const epoch = host.epoch
  const revision = host.revision
  const [root, model, account] = await Promise.all([
    $.session.root().catch(() => host.root),
    $.session.model().catch(() => host.sample?.model ?? null),
    readAccount($).catch(() => host.sample?.values.filter((v) => v.scope !== 'project') ?? []),
  ])
  let warning = ''
  const [project, instructionSlots] = await Promise.all([
    readProject($, root).catch(() => {
      warning = 'Could not read .margincue/decisions.json. Project decisions are unavailable.'
      return null
    }),
    readInstructionSlots($, root),
  ])
  if (host.epoch !== epoch || host.revision !== revision) return
  if (root !== host.root) await Promise.all([host.eventLog.setProject(root), host.trialLog.setProject(root)])
  if (host.epoch !== epoch || host.revision !== revision || !enabled()) return
  host.root = root
  host.storageWarning = warning
  const state: StateLoad = {
    model, values: [...account, ...(project?.decisions ?? [])],
    facts: project?.facts ?? {}, instructionSlots,
  }
  const json = JSON.stringify(state)
  if (json !== host.sampleJson || submitted !== undefined) {
    host.sample = state
    host.sampleJson = json
    run($, { type: 'loadState', now: now(), state: { ...state, submitted } })
  }
}

function watch($: $): void {
  host.watcher?.cancel()
  host.watcher = null
  if (host.settings.mode === 'off') return
  let pending = false
  // There is no fs.watch hook. Refresh outside prompt.edit.
  host.watcher = $.clock.every(POLL_MS, async () => {
    if (pending) return
    pending = true
    try { await enqueue(() => refresh($)) } finally { pending = false }
  })
}

function save($: $, change: Extract<Effect, { type: 'persist' }>): void {
  if ((change.action === 'forget' ? change.scope : change.value.scope) === 'session') return
  const root = host.root
  const epoch = host.epoch
  const revision = ++host.revision
  const task = enqueue(async () => {
    try {
      await saveDecision($, root, change)
    } catch {
      if (host.epoch === epoch) {
        void $.ui.toast('MarginCue could not save this decision. Check state and try again.')
        host.sampleJson = ''
        log($, 'persist-failed', { scope: change.action === 'forget' ? change.scope : change.value.scope })
      }
    }
    if (host.epoch === epoch && host.revision === revision) await refresh($)
  })
  void task.catch(() => {})
}

async function deliverAmendment($: $, effect: Extract<Effect, { type: 'amend' }>): Promise<void> {
  let accepted = false
  try {
    const result = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: effect.text }] } })
    accepted = !('deny' in result)
  } catch {}
  log($, 'amendment', { cue: effect.cue, option: effect.option, action: accepted ? 'amended' : 'refused', ms: effect.ms })
  void $.ui.toast(accepted ? 'Amendment queued for the next model request.' : 'Claude Code did not accept the amendment.')
}

function cycleScope(slot: string, fallback: Scope): void {
  const scopes: Scope[] = host.view?.state?.model ? ['project', 'user', 'model', 'session'] : ['project', 'user', 'session']
  const current = selectedScope(slot, fallback)
  host.scopes.set(slot, scopes[(scopes.indexOf(current) + 1) % scopes.length]!)
}

function act($: $, action: Action): void | Promise<void> {
  const t = now()
  if (action.type === 'cardFocus') run($, { type: 'cardFocus', dir: action.dir, row: action.row })
  else if (action.type === 'cardCycle') run($, { type: 'cardCycle', now: t, row: action.row })
  else if (action.type === 'cardSet') run($, { type: 'cardSet', now: t, row: action.row, option: action.option })
  else if (action.type === 'cardDismiss') run($, { type: 'cardDismiss', now: t, row: action.row })
  else if (action.type === 'sketch') run($, { type: 'sketch', now: t, action: action.action })
  else if (action.type === 'receiptPick') return followUp($, action.receipt, action.item, action.option)
  else if (action.type === 'pick' || action.type === 'cycle') {
    run($, { type: 'pick', now: t, cue: action.cue, option: action.option })
    if (action.type === 'cycle') run($, { type: 'focus', cue: action.cue })
  } else if (action.type === 'set') {
    const first = host.view?.state?.first
    if (first?.slot !== action.slot) return
    const scope = selectedScope(first.slot, first.scope)
    if (action.option === 'delegated') run($, { type: 'delegate', now: t, at: Date.now(), slot: first.slot, scope })
    else run($, { type: 'set', now: t, at: Date.now(), slot: first.slot, option: action.option, scope })
  } else if (action.type === 'scope' || action.type === 'why') {
    const first = host.view?.state?.first
    if (first?.slot !== action.slot) return
    if (action.type === 'scope') {
      cycleScope(action.slot, first.scope)
      publish($, host.view!)
      log($, 'scope', { slot: first.slot, scope: selectedScope(first.slot, first.scope) })
    } else {
      void $.ui.toast(`${first.why}\n${first.source}`)
    }
  } else if (action.type === 'dismiss') run($, { type: 'dismiss', now: t, cue: action.cue })
  else if (action.type === 'acceptAll') run($, { type: 'acceptAll', now: t })
  else if (action.type === 'focus') run($, { type: 'focus', dir: action.dir })
  else if (action.type === 'review') void review($, host.settings.profile).catch(() => {})
  else if (action.type === 'depth') {
    host.settings.depths[host.settings.profile] = DEPTHS[(DEPTHS.indexOf(currentDepth()) + 1) % DEPTHS.length]!
    run($, configEvent())
    log($, 'depth', { depth: currentDepth() })
    void saveSettings($).catch(() => {})
  }
  else if (action.type === 'amend' && host.turn?.id && host.turn.id === host.activeTurn) {
    run($, { type: 'amend', now: t, cue: action.cue, option: action.option })
  }
}

/** Puts a follow-up in the composer: only into an empty box or over MarginCue's own earlier fill. */
async function fillComposer($: $, text: string, replaces: string | null): Promise<void> {
  const box = await $.prompt.read()
  if (box.text !== '' && box.text !== replaces && box.text !== host.lastFill) return
  if (text === '' && box.text === '') return
  host.lastFill = text
  await $.prompt.fill({ text, mode: 'replace' }).catch(() => {})
}

/** A choice switched on a receipt in the transcript: the follow-up prompt that asks for it. */
async function followUp($: $, receiptId: number, item: number, option: number): Promise<void> {
  const choice = host.receipts.get(receiptId)?.agent[item]
  const value = choice?.options[option]
  if (!choice || value === undefined || value === choice.value) return
  log($, 'receipt-pick', { receipt: receiptId, item, option })
  await fillComposer($, `Change ${choice.label}: ${value} instead of ${choice.value}. Keep everything else as it is.`, host.lastFill)
}

function learn($: $, key: string, label: string): void {
  const root = host.root
  void enqueue(async () => {
    const picks = await saveLearned($, root, key, label)
    if (root === host.root) run($, { type: 'learned', picks })
  }).catch(() => {})
}

/** The project's names, collected in the background: at start, then after turns (throttled). */
async function reindex($: $, force: boolean): Promise<void> {
  if (host.indexing || host.settings.mode === 'off' || !host.settings.sheet || !host.interactive) return
  if (!force && now() - host.indexedAt < REINDEX_MS) return
  host.indexing = true
  const epoch = host.epoch
  try {
    const vocab = await collectVocabulary($, host.root)
    if (epoch !== host.epoch) return
    host.indexedAt = now()
    run($, { type: 'vocabulary', vocab })
    log($, 'indexed', { files: vocab?.files.length ?? 0, names: vocab?.entries.length ?? 0 })
  } catch {
    // No index: the card still reads the draft, without names from the code.
  } finally {
    host.indexing = false
  }
}

const blankKey = (blank: Pick<ParsedBlank, 'label' | 'choice' | 'alternatives'>) =>
  `${blank.label}|${blank.choice}|${blank.alternatives.join('|')}`

/**
 * When a turn starts, the choices already marked in the conversation (this
 * session's earlier turns, or a resumed one's) are noted as old, so a reply
 * drawn again while the turn runs (scrolling back) adds nothing to its card.
 */
async function markTurnStart($: $, turn: string): Promise<void> {
  const found = await $.session.messages({ last: 400 }).catch(() => null)
  if (!found || 'deny' in found || host.activeTurn !== turn) return
  for (const entry of found) {
    if (entry.role === 'assistant') for (const blank of parseBlanks(entry.text)) host.blankOld.add(blankKey(blank))
  }
}

/** A choice the agent marked in a reply of the running turn, once per wording. */
function noteBlank($: $, blank: Pick<ParsedBlank, 'label' | 'choice' | 'alternatives'>): void {
  const seen = blankKey(blank)
  if (host.blankSeen.has(seen) || host.blankOld.has(seen)) return
  host.blankSeen.add(seen)
  run($, { type: 'blank', now: now(), label: blank.label, choice: blank.choice, alternatives: blank.alternatives })
}

/** What a blank reads now: the person's switch, during or after the turn. */
function blankValue(blank: ParsedBlank): string | undefined {
  const card = host.view?.card
  const key = `blank_${nameKey(blank.label)}`.slice(0, 40)
  const row = card?.rows.find((entry) => entry.key === key)
  if (!card || !row) return undefined
  return row.options[(card.stage === 'turn' ? row.selected : row.defaults)[0] ?? 0]
}

async function placeReceipt($: $): Promise<void> {
  const receipt = host.view?.receipt
  if (!receipt || host.placed.has(receipt.id)) return
  host.placed.add(receipt.id)
  host.receipts.set(receipt.id, receipt)
  if (host.receipts.size > 20) host.receipts.delete(host.receipts.keys().next().value!)
  await $.ui.place({ id: `receipt-${receipt.id}` }).catch(() => {})
}

function drawRows($: $, ui: Elements[RenderSurface], rows: Segment[][], focus?: string) {
  const { Box, Text, Button, Progress } = ui
  const draw = (s: Segment) => {
    if (s.kind === 'progress') return <Progress label={s.label} valueText="" />
    if (s.kind === 'text') {
      const style = s.style
      return <Text dimColor={style?.dim} bold={style?.bold} italic={style?.italic} underline={style?.underline}
        color={style?.color} backgroundColor={style?.bg} wrap="truncate-end">{s.text}</Text>
    }
    const style = s.style
    // A chip draws its face (padding included) in its own colours; the label still names the control.
    const face = s.face !== undefined
      ? <Text dimColor={s.dim || style?.dim} bold={style?.bold} italic={style?.italic} color={style?.color} backgroundColor={style?.bg}>{s.face}</Text>
      : (s.bold || s.color) ? <Text bold={s.bold} color={s.color}>{s.label}</Text> : null
    const button = <Button key={s.key} plain={s.primary ? undefined : true} variant={s.primary ? 'primary' : undefined}
      hotkey={s.hotkey} action={s.chord} label={s.label + (s.detail ?? '')} dimColor={s.dim}
      autoFocus={focus === s.key ? true : undefined} onPress={() => act($, s.action)}>
      {face}
      {s.detail && <Text dimColor>{s.detail}</Text>}
    </Button>
    return s.hidden ? <Box key={s.key} display="none">{button}</Box> : button
  }
  const row = (segments: Segment[], i: number) =>
    <Box key={`row-${i}`} flexDirection="row" flexWrap="nowrap" overflow="hidden">{segments.map(draw)}</Box>
  return rows.length === 1 ? row(rows[0]!, 0) : <Box flexDirection="column">{rows.map(row)}</Box>
}

async function start($: $, cwd: string, interactive: boolean): Promise<void> {
  host.epoch++
  host.revision = 0
  host.watcher?.cancel()
  host.watcher = null
  host.timer?.cancel()
  host.timer = null
  dropClear()
  for (const abort of host.inflight.values()) abort.abort()
  host.inflight.clear()
  host.root = cwd
  host.core = null
  host.sample = null
  host.sampleJson = ''
  host.turn = null
  host.activeTurn = null
  host.interactive = interactive
  host.arm = null
  host.lastDraft = ''
  host.restoring = false
  host.bandChoices = []
  host.scopes.clear()
  host.sentExpert = ''
  host.sentBand = ''
  const [stored, loaded, turns] = await Promise.all([
    $.store.get('settings').catch(() => undefined) as Promise<(Partial<Settings> & { enabled?: boolean; depth?: Depth }) | undefined>,
    personalAssets($, ASSETS),
    $.session.turns().catch(() => 0),
  ])
  host.assets = loaded.assets
  void $.config.list().then((rows) => { host.palette = paletteFor(rows.find((row) => row.key === 'theme')?.value) }).catch(() => {})
  host.settings = {
    ...DEFAULTS,
    mode: stored?.mode && MODES.includes(stored.mode) ? stored.mode : stored?.enabled === false ? 'off' : DEFAULTS.mode,
    profile: stored?.profile && Object.hasOwn(host.assets.profiles, stored.profile) ? stored.profile : DEFAULTS.profile,
    language: stored?.language === 'auto' ? 'auto' : DEFAULTS.language,
    inline: stored?.inline === true,
    sheet: stored?.sheet !== false,
    ab: stored?.ab === true,
    sketch: stored?.sketch !== false,
    refs: stored?.refs !== false,
    blanks: stored?.blanks !== false,
    user: readUser(stored?.user),
    onboarded: stored?.onboarded === 'done' || stored?.onboarded === 'skipped' ? stored.onboarded : null,
    depths: Object.fromEntries(Object.keys(host.assets.profiles).flatMap((profile) => {
      const depth = stored?.depths?.[profile] ?? (profile === stored?.profile ? stored?.depth : undefined)
      return depth && DEPTHS.includes(depth) ? [[profile, depth]] : []
    })),
  }
  await host.trialLog.stop(logIO($))
  await startTrial($, turns === 0)
  ensure($)
  if (host.settings.mode !== 'off') await enqueue(() => refresh($, turns > 0))
  else run($, { type: 'loadState', now: now(), state: { model: null, values: [], submitted: turns > 0 } })
  if (loaded.skipped && host.settings.mode !== 'off') void $.ui.toast(`MarginCue skipped ${loaded.skipped} invalid or conflicting personal bundle(s).`)
  if (interactive) watch($)
  host.indexedAt = -Infinity
  host.blankSeen.clear()
  host.blankOld.clear()
  // First run: a few questions about the person's work, once the screen is up and only into an empty prompt;
  // someone who started typing straight away is asked in their next session instead.
  // MARGINCUE_NO_SETUP=1 keeps them away from a session that is not the person's own (a recording, a test harness).
  const noSetup = await $.env.get('MARGINCUE_NO_SETUP').catch(() => undefined)
  host.onboardPending = interactive && host.settings.mode !== 'off' && host.settings.onboarded === null && turns === 0 &&
    !(noSetup && noSetup !== '0')
  if (host.onboardPending) {
    const epoch = host.epoch
    $.clock.after(1500, async () => {
      if (epoch !== host.epoch || !host.onboardPending) return
      host.onboardPending = false
      const box = await $.prompt.read().catch(() => ({ text: 'unknown' }))
      if (box.text.trim() === '' && host.activeTurn === null) void onboard($, false)
    })
  }
  if (host.settings.mode !== 'off') {
    void readLearned($, host.root).then((picks) => run($, { type: 'learned', picks })).catch(() => {})
    void reindex($, true)
  }
  await $.command.register({
    name: 'margincue',
    description: 'MarginCue card, sketch, blanks, decisions, expert review and session status',
    argumentHint: '[setup [reset]|state|mode|language en|auto|card on|off|sketch on|off|refs on|off|blanks on|off|ab on|off|status|review [profile]|profile|status]',
    immediate: true,
  })
  await reopen($)
}

/** Reviews whatever the box holds now, as a draft just opened. */
async function reopen($: $): Promise<void> {
  const box = await $.prompt.read()
  if (box.text !== '') rememberDraft($, box.text, 'open', box.cursor)
}

function rememberDraft($: $, text: string, origin: Origin, cursor: number, edit?: { start: number; end: number; text: string }): void {
  if (text.trim() && !isHostCommand(text)) host.lastDraft = text
  run($, { type: 'draft', now: now(), text, origin, ...(edit && { edit }), cursor }, origin !== 'type' && origin !== 'paste')
}

async function review($: $, profile: string, fromCommand = false): Promise<string> {
  if (host.settings.mode === 'off') return 'MarginCue is off.'
  if (!(host.assets.bundles ?? []).some((bundle) => bundle.profile === profile)) return `No decision bundle for "${profile}".`
  let view = host.view
  if (fromCommand && (!view?.text.trim() || isHostCommand(view.text)) && host.lastDraft) {
    const text = host.lastDraft
    dropClear()
    host.restoring = true
    try {
      const filled = await $.prompt.fill({ text, mode: 'replace' })
      if (!filled.isFilled && filled.refusal !== 'unanswered') return 'The draft could not be restored to the composer.'
      rememberDraft($, text, 'restore', text.length)
    } finally {
      host.restoring = false
    }
    view = host.view
  }
  if (!view?.text.trim() || isHostCommand(view.text)) return 'Type a draft, then press ctrl+x tab and r to review it.'
  run($, { type: 'review', now: now(), profile })
  const opened = await $.ui.open({ id: REVIEW_PANE, title: `MarginCue review · ${profile}` })
  return opened.isPlaced ? `Reviewing the draft against ${profile}.` : 'The review pane is unavailable on this surface.'
}

function stateText(): string {
  const values = ensureStateList()
  const labels = { user: 'Everywhere', model: 'Model only', project: 'This project', session: 'This session' }
  const groups = SCOPES.flatMap((scope) => {
    const group = values.filter((value) => value.scope === scope)
    if (!group.length) return []
    return [labels[scope], ...group.map((value) => {
      const slot = host.assets.bundles?.flatMap((bundle) => bundle.slots).find((slot) => slot.id === value.slot)
      const option = slot?.options.find((option) => option.id === value.option)
      const text = value.text ?? (value.option === 'delegated' ? 'you decide' : option?.wording.en.plain ?? value.option)
      return `  ${value.slot}${value.model ? ` (${value.model})` : ''} — ${text}`
    })]
  })
  return [host.storageWarning, ...(groups.length ? groups : ['No decisions are set.'])].filter(Boolean).join('\n')
}

function ensureStateList() {
  return (host.core?.storedDecisions() ?? []).sort((a, b) => a.slot.localeCompare(b.slot) || (a.model ?? '').localeCompare(b.model ?? ''))
}

async function command($: $, args: string): Promise<{ text: string; isTextDisplayOnly: true }> {
  const [verb = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  const done = (text: string) => ({ text, isTextDisplayOnly: true as const })
  const names = Object.keys(host.assets.profiles).join(', ')
  const { settings } = host
  try {
    switch (verb.toLowerCase()) {
      case 'mode':
      case 'on':
      case 'off': {
        const mode = (verb === 'mode' ? arg : verb).toLowerCase() as Mode
        if (!mode) return done(`MarginCue mode is ${settings.mode}.`)
        if (!MODES.includes(mode)) return done('Choose off, on, quiet or auto.')
        const previousMode = settings.mode
        if (mode === 'off') log($, 'mode-changed', { previousMode, selectedMode: mode })
        settings.mode = mode
        if (mode !== 'off') log($, 'mode-changed', { previousMode, selectedMode: mode })
        run($, configEvent())
        watch($)
        if (mode !== 'off') await enqueue(() => refresh($))
        await saveSettings($)
        return done(`MarginCue is ${mode}.`)
      }
      case 'why': {
        const slot = host.assets.bundles?.flatMap((bundle) => bundle.slots).find((slot) => slot.id === arg)
        return done(slot ? `${slot.why}
${slot.source}` : 'Use /margincue why <slot>.')
      }
      case 'state':
        if (settings.mode !== 'off') await enqueue(() => refresh($))
        return done(stateText())
      case 'forget': {
        if (settings.mode === 'off') return done('MarginCue is off.')
        const [slot, scope] = rest as [string?, Scope?]
        if (!slot || scope && !SCOPES.includes(scope)) return done('Use /margincue forget <slot> [user|model|project|session].')
        await enqueue(() => refresh($))
        const effects = run($, { type: 'forget', now: now(), slot, scope })
        const forgotten = effects.find((fx) => fx.type === 'persist' && fx.action === 'forget')
        if (!forgotten || forgotten.action !== 'forget') return done(`No matching decision for "${slot}".`)
        await host.pendingIO
        return done(ensureStateList().some((value) => value.slot === slot && value.scope === forgotten.scope && value.model === forgotten.model)
          ? `Could not forget ${slot}. The decision is still set.` : `Forgot ${slot} (${forgotten.scope}).`)
      }
      case 'profile':
        if (!arg) return done(`Profile ${settings.profile}. Available profiles are ${names}.`)
        if (!Object.hasOwn(host.assets.profiles, arg)) return done(`No profile named "${arg}". Available profiles are ${names}.`)
        const previousProfile = settings.profile
        settings.profile = arg
        log($, 'profile-changed', { previousProfile })
        run($, configEvent())
        await saveSettings($)
        return done(`MarginCue profile is ${arg}.`)
      case 'depth': {
        const depth = arg as Depth
        if (!DEPTHS.includes(depth)) return done(`Depth is ${currentDepth()}. Choose essentials, standard or research.`)
        settings.depths[settings.profile] = depth
        log($, 'depth', { depth })
        run($, configEvent())
        await saveSettings($)
        return done(`MarginCue depth is ${depth}.`)
      }
      case 'inline':
        settings.inline = arg.toLowerCase() !== 'off'
        await saveSettings($)
        repaint($)
        return done(`Inline defaults ${settings.inline ? 'on' : 'off'}.`)
      case 'language': {
        const language = arg.toLowerCase()
        if (language !== 'en' && language !== 'auto') return done('Use /margincue language en|auto.')
        settings.language = language
        run($, configEvent())
        await saveSettings($)
        return done(language === 'en' ? 'MarginCue uses English.' : 'MarginCue follows the draft’s language.')
      }
      case 'setup':
        if (arg.toLowerCase() === 'reset') {
          Object.assign(settings, { user: null, onboarded: null })
          run($, configEvent())
          await saveSettings($)
          return done('MarginCue forgot your answers. The questions come back in the next new session, or now with /margincue setup.')
        }
        return done(await onboard($, true))
      case 'card':
      case 'sheet': {
        const setting = arg.toLowerCase()
        if (setting !== 'on' && setting !== 'off') return done('Use /margincue card on|off.')
        settings.sheet = setting === 'on'
        run($, configEvent())
        if (settings.sheet) void reindex($, true)
        await saveSettings($)
        return done(`MarginCue card is ${setting}.`)
      }
      case 'sketch':
      case 'refs':
      case 'blanks': {
        const setting = arg.toLowerCase()
        if (setting !== 'on' && setting !== 'off') return done(`Use /margincue ${verb} on|off.`)
        settings[verb as 'sketch' | 'refs' | 'blanks'] = setting === 'on'
        run($, configEvent())
        await saveSettings($)
        const note = verb === 'blanks' ? ' It applies from the next session.' : ''
        return done(`MarginCue ${verb} ${setting}.${note}`)
      }
      case 'ab': {
        const setting = arg.toLowerCase()
        if (!setting || setting === 'status') return done(await trialStatus($))
        if (setting !== 'on' && setting !== 'off') return done('Use /margincue ab on|off|status.')
        settings.ab = setting === 'on'
        if (!settings.ab) {
          host.arm = null
          await host.trialLog.stop(logIO($))
          run($, configEvent())
        }
        await saveSettings($)
        return done(settings.ab ? 'MarginCue A/B is on for new sessions.' : 'MarginCue A/B is off.')
      }
      case 'review':
        return done(await review($, arg || settings.profile, true))
      case 'log':
        if (!arg || arg === 'off') {
          await host.eventLog.stop(logIO($))
          run($, configEvent())
          return done('Logging off.')
        }
        if (settings.mode === 'off') return done('MarginCue is off.')
        await host.eventLog.start(logIO($), arg, host.root)
        run($, configEvent())
        log($, 'log-start')
        return done(`Logging decision events to ${arg}.`)
      default: {
        const { stats } = host
        const med = (list: number[]) => list.length ? `${median(list)} ms` : '–'
        return done([
          `MarginCue is ${settings.mode} · profile ${settings.profile} · language ${settings.language} · depth ${currentDepth()} · card ${settings.sheet ? 'on' : 'off'} · sketch ${settings.sketch ? 'on' : 'off'} · refs ${settings.refs ? 'on' : 'off'} · blanks ${settings.blanks ? 'on' : 'off'}`,
          `This session: ${stats.requests} model calls, ${stats.failures} failed · median first ${med(stats.first)} · median reply ${med(stats.full)}`,
          `${stats.submits} prompts sent, ${stats.attached} with decisions attached.`,
          `Project index: ${host.indexing ? 'reading…' : host.indexedAt > 0 ? 'ready' : 'none (not a git repository, or off)'}.`,
          ...profileLines(),
          host.settings.user ? `You: ${describeUser(host.settings.user)} (/margincue setup changes this.)`
            : 'You: not set up yet (/margincue setup asks three or four questions).',
          'On the card, alt+↑ moves to the next row and alt+↓ changes its value, without leaving the prompt.',
          'ctrl+x tab focuses the card: a number picks, x drops the row, s opens or closes the sketch, p attaches it to the prompt.',
          'During a turn the card lists the choices the agent marked; switch one and it reaches the agent at its next step.',
          'After the turn, switching one writes the follow-up prompt into the composer.',
          'Use /margincue card|sketch|refs|blanks on|off, and /margincue ab on|off|status for the trial.',
        ].join('\n'))
      }
    }
  } catch {
    return done('MarginCue could not complete the command. Check the file path or Claude Code mod permissions.')
  }
}

/**
 * The first-run interview, in Claude Code's own question dialog. Closing it is an answer too: the
 * questions are not asked again unasked (/margincue setup asks them). Only counts are logged.
 */
async function onboard($: $, asked: boolean): Promise<string> {
  if (host.onboarding) return 'The MarginCue questions are already open.'
  host.onboarding = true
  try {
    const user = await interview((question, options) => $.ui.ask(question, options))
    host.settings.user = user
    host.settings.onboarded = 'done'
    for (const [profile, level] of Object.entries(user.levels)) host.settings.depths[profile] = depthFor(level)
    run($, configEvent())
    await saveSettings($)
    log($, 'onboarded', { work: user.work.length, levels: Object.keys(user.levels).length, decide: user.decide.length })
    if (!asked) void $.ui.toast('Thanks. MarginCue fits its cards to this; /margincue setup changes it.')
    return `MarginCue knows: ${describeUser(user)}`
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // A session that cannot show the dialog (no AskUserQuestion tool, nobody at the terminal) is not an answer:
    // the questions wait for a session that can. Only the person closing them counts as skipping.
    if (/no tool named|not available|unavailable|no surface|headless|no one to ask|-p run/i.test(reason)) {
      return 'The question dialog is not available in this session (Claude Code has no AskUserQuestion tool here); ' +
        'the questions will come in a session that has it.'
    }
    if (host.settings.onboarded === null) {
      host.settings.onboarded = 'skipped'
      await saveSettings($).catch(() => {})
    }
    if (!asked) void $.ui.toast('Skipped. /margincue setup asks these questions whenever you like.')
    return 'The questions were closed; nothing changed.'
  } finally {
    host.onboarding = false
  }
}

/** Which expert profiles the project calls for, read from its files, and why. */
function profileLines(): string[] {
  if (!(host.indexedAt > 0)) return []
  const lenses = host.core?.projectProfiles() ?? []
  if (!lenses.length) return ['Profiles from this project: none detected (/margincue profile <name> adds one).']
  return [`Profiles from this project: ${lenses.map((lens) => `${lens.profile}, ${lens.rigor} (${lens.reasons.join(', ')})`).join('; ')}.`]
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await start($, e.cwd, e.isInteractive)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await host.pendingIO
    if (e.reason === 'clear') {
      dropClear()
      host.turn = null
      host.activeTurn = null
      host.lastDraft = ''
      host.scopes.clear()
      run($, { type: 'sessionReset', now: now() })
      await Promise.all([host.eventLog.flush(logIO($)), host.trialLog.stop(logIO($))])
      host.arm = null
      $.clock.after(0, async () => {
        await host.eventLog.resetSession(logIO($)).catch(() => {})
        await startTrial($, true)
        run($, configEvent())
      })
    } else {
      host.watcher?.cancel()
      await Promise.all([host.eventLog.stop(logIO($)), host.trialLog.stop(logIO($))])
    }
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    ensure($)
    flushClear($)
    const started = now()
    // Some terminal presentations pass a bare band digit on to the composer.
    // Handle that edit only for an empty box and a visible numbered choice.
    const key = e.key
    if (!host.shell && e.text === '' && key && !key.ctrl && !key.meta && !key.shift && key.key === e.inputText &&
        host.turn?.id && host.turn.id === host.activeTurn) {
      const answer = host.bandChoices.find((choice) => String(choice.option + 1) === key.key)
      if (answer && run($, { type: 'amend', now: started, cue: answer.row, option: answer.option }, false).some((effect) => effect.type === 'amend')) {
        return next({ ...e, inputText: '' })
      }
    }
    const r = await next(e)
    if (host.shell) {
      rememberDraft($, `!${r.text}`, 'type', r.cursor + 1)
      return { ...r, decorations: [] }
    }
    const pasted = e.key === undefined && (e.inputText.length >= 16 || (e.inputText.includes('\n') && e.inputText.length > 1))
    const origin: Origin = pasted ? 'paste' : 'type'
    rememberDraft($, r.text, origin, r.cursor, { start: e.start, end: e.end, text: e.inputText })
    log($, 'draft', { origin, ms: Math.round((now() - started) * 100) / 100 })
    return { ...r, decorations: decorate(host.view, r.text) }
  })

  on('prompt.change', ($, e, next) => {
    const kind = e.origin.kind
    if (kind === 'clear' && e.text === '') {
      holdClear($, e.cursor)
      return next(e)
    }
    flushClear($)
    const origin: Origin = host.restoring ? 'restore' : kind === 'history' || kind === 'undo' ? 'history' : kind === 'clear' ? 'type' : 'fill'
    rememberDraft($, e.text, origin, e.cursor)
    log($, 'draft', { origin })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true || e.origin.kind !== 'composer' || isHostCommand(e.text) || host.shell) {
      flushClear($)
      return next(e)
    }
    dropClear()
    const core = ensure($)
    const values = core.storedDecisions()
    if (host.settings.mode !== 'off' && values.some((value) => value.scope === 'model')) {
      const model = await $.session.model().catch(() => null)
      if (model !== host.view?.state?.model) run($, {
        type: 'loadState', now: now(), state: { ...host.sample, model, values },
      }, false)
    }
    host.lastDraft = ''
    host.scopes.clear()
    const amendable = !e.turnId && !host.activeTurn && !host.turn
    const effects = run($, { type: 'submit', now: now(), text: e.text, amendable }, false)
    const sent = effects.find((fx): fx is SubmitEffect => fx.type === 'submit')
    const text = sent?.text ?? e.text
    if (amendable) host.turn = { id: null, text }
    const result = await next(text === e.text ? e : { ...e, text })
    if (amendable && 'drop' in result && host.turn?.text === text) {
      host.turn = null
      run($, { type: 'endAmendment', now: now() })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      host.activeTurn = e.turnId
      if (host.turn?.text === e.text) host.turn.id = e.turnId
      void markTurnStart($, e.turnId)
      run($, { type: 'turnStart', now: now() })
      if (host.view) publish($, host.view)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && host.activeTurn === e.turnId) {
      for (const blank of parseBlanks(result?.text ?? '')) noteBlank($, blank)
      host.activeTurn = null
      host.turn = null
      run($, { type: 'endAmendment', now: now() })
      if (host.view) publish($, host.view)
      void placeReceipt($)
      void reindex($, false)
    }
    return result
  })

  on('session.stop', ($, e, next) => {
    if (host.turn && !host.activeTurn) {
      host.turn = null
      run($, { type: 'endAmendment', now: now() })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      host.bandChoices = []
      return next(e)
    }
    const state = await read($, band)
    const card = state?.card
    const rows = state?.enabled && (state.hasDraft || state.amendment || card || state.reviewPending)
      ? layoutBandRows(state, e.props.bodyColumns, 'ctrl+x tab', e.props.maxRows, host.palette) : []
    const focused = card?.stage === 'turn' && !e.props.isCollapsed ? card.rows.find((row) => row.id === card.focus) : undefined
    host.bandChoices = e.surface === 'terminal' && focused ? focused.options.map((_, option) => ({ row: focused.id, option })) : []
    if (!rows.length) return next(e)
    if (card && !e.props.isCollapsed) run($, { type: 'cardShown', now: now(), id: card.id }, false)
    return drawRows($, $.ui.resolve(e), rows)
  })

  // The agent's marked choices: drawn as their value in bold, registered as levers while the turn runs.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (!text.includes(BLANK_OPEN) || host.settings.mode === 'off') return next(e)
    const blanks = parseBlanks(text)
    if (!blanks.length) return next(e)
    const live = host.activeTurn !== null
    if (live) $.clock.after(0, () => { if (host.activeTurn !== null) for (const blank of blanks) noteBlank($, blank) })
    const drawn = await next({ ...e, props: { ...e.props, text: renderBlanks(text, blankValue) } })
    if (!live) return drawn
    const { Box, Text } = $.ui.resolve(e)
    const n = blanks.length
    const accent = host.palette.accent
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={accent} bold>{'  ◆ '}</Text>
          <Text bold>{`${n} choice${n === 1 ? '' : 's'} made for you`}</Text>
          <Text dimColor>{' · '}</Text>
          <Text color={accent}>{'alt↑ alt↓'}</Text>
          <Text dimColor>{' to switch one, it keeps working'}</Text>
        </Box>
      </Box>
    )
  })

  // The receipt: what travelled with the prompt, what the agent chose, and one press to ask for another.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const id = /^receipt-(\d+)$/.exec(e.props.id)?.[1]
    const receipt = e.props.plugin === 'margincue' && id ? host.receipts.get(Number(id)) : undefined
    if (!receipt) return next(e)
    return drawRows($, $.ui.resolve(e), layoutReceipt(receipt, e.viewport?.columns ?? 100, host.palette))
  })

  // The prompt as sent: what MarginCue attached is listed under it rather than shown as raw text.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.origin.kind !== 'composer' || host.settings.mode === 'off') return next(e)
    const sent = splitSent(e.props.text)
    if (!sent) return next(e)
    const drawn = await next({ ...e, props: { ...e.props, text: sent.body } })
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{drawn}{drawRows($, $.ui.resolve(e), layoutSent(sent, e.viewport?.columns ?? 100, host.palette))}</Box>
  }).catch(($, e, next) => next(e))

  // The agent learns to mark its own choices, so the person can switch them while it works.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const protocol = host.assets.blanksProtocol
    if (!protocol || !host.settings.blanks || !host.settings.sheet || host.settings.mode === 'off') return result
    return { ...result, sections: [...result.sections, { id: 'margincue:blanks', text: protocol, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: REVIEW_PANE }, async ($, e) => {
    const checklist = await read($, expert)
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    if (!checklist) return <Text>The draft changed. Start a new review when ready.</Text>
    if (checklist.phase === 'reviewing') return <Progress label={thinkingLabel(checklist.language)} valueText="" />
    if (checklist.phase === 'error') return <Text>Claude Code did not return a review.</Text>
    if (!checklist.items.length) return <Text>No open decisions found.</Text>
    const P = host.palette
    const open = checklist.items.filter((item) => item.chosen === undefined).length
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={P.tag.color} backgroundColor={P.tag.bg} bold>{' MarginCue '}</Text>
          <Text dimColor>{`  ${checklist.profile} review · ${open} open of ${checklist.items.length}`}</Text>
        </Box>
        {checklist.items.map((item) => {
          const options = item.persistent && !item.guard
            ? [...item.options, { id: 'delegated', label: checklist.language === 'fr' ? 'tu décides' : 'you decide' }]
            : item.options
          const picked = options.find((option) => option.id === item.chosen)
          return (
            <Box key={item.key} flexDirection="column" marginTop={1}>
              <Box flexDirection="row">
                <Text color={picked ? 'success' : item.guard ? 'warning' : P.accent} bold>{picked ? '✓ ' : item.guard ? '◆ ' : '◇ '}</Text>
                <Text bold>{item.statement.replace('{}', '…')}</Text>
              </Box>
              {picked ? (
                <Box flexDirection="row">
                  <Text>{'  '}</Text>
                  <Text color={P.yours.color} backgroundColor={P.yours.bg} bold>{` ${picked.label} `}</Text>
                </Box>
              ) : (
                <Box flexDirection="row" flexWrap="wrap">
                  <Text>{'  '}</Text>
                  {options.map((option, i) => (
                    <Button key={`${item.key}-${option.id}`} plain label={option.label} onPress={() => run($, {
                      type: 'expertPick', now: now(), at: Date.now(), review: checklist.id, key: item.key,
                      option: option.id, scope: selectedScope(item.slot, item.scope),
                    })}>
                      <Text {...(i === 0 ? { color: P.suggested.color, backgroundColor: P.suggested.bg } : {})}>{` ${option.label} `}</Text>
                    </Button>
                  ))}
                  {item.persistent && (
                    <Button key={`${item.key}-scope`} plain dimColor label={scopeLabel(item.scope, checklist.language)} onPress={() => {
                      cycleScope(item.slot, item.scope)
                      if (host.view) publish($, host.view)
                    }}>
                      <Text dimColor>{`  · ${scopeLabel(item.scope, checklist.language)}`}</Text>
                    </Button>
                  )}
                </Box>
              )}
              {item.why && <Text dimColor>{`  ${item.why}`}</Text>}
              {item.source && <Text dimColor italic>{`  ${item.source}`}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })

  // The editor strips the shell prefix; the unchanged hint reveals its mode.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    host.shell = /shell mode/i.test(e.props.hint)
    return next(e)
  })

  on('command.run', { command: 'margincue' }, async ($, e) => command($, e.args))

  // Only follows the theme the person picks; a failure here must never stand in the way of their setting.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (!('deny' in result && result.deny)) host.palette = paletteFor(e.value)
    return result
  }).catch(($, e, next) => next.called ? next(e) : next(e))
}

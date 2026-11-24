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
import type { MargincueBand, MargincueExpert, MargincueReceipt, MargincueRow } from '../types'
import { BLANK_CLOSE, BLANK_OPEN, parseBlanks, renderBlanks } from '../core/card'
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
/** How long a prompt sent from an app waits on its card before it goes as it stands. */
/** Longest wait for the reading at Enter. A model call never counts against a hook's own 10 s, so this is wall time. */
const READ_WAIT_MS = 60000
/** Claude's own dialog under MarginCue's card in an app: send with the card, or as written; "Other" adds to the prompt. */
const GATE_QUESTION = 'Send your prompt with these choices?'
const GATE_SEND = 'Send'
const GATE_RAW = 'Send as written'

/**
 * A prompt the person wrote: Enter at the terminal, or sent from an app attached to this session (the desktop
 * app and VS Code send theirs through the SDK, a phone through the bridge). A script's prompt (claude -p, the SDK
 * with no app) is not, and is left alone.
 */
const personal = (kind: string) =>
  // The desktop app stamps what the person typed as `human`; the terminal as `composer`.
  kind === 'composer' || kind === 'human' || ((kind === 'sdk' || kind === 'bridge') && host.interactive)

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
  /** MarginCue's card is up in an app, above Claude's own dialog, waiting for the person to send. */
  gate: false,
  /** When the core next wants its timer, recorded so the dialog's own watcher can fire it while the card is up. */
  timerAt: null as number | null,
  /** The app running this session (the desktop app, VS Code), from the engine's entrypoint; null at a terminal or in a script. */
  appHost: null as string | null,
  /** MARGINCUE_NO_SETUP: no first-run questions in this session (a recording, a test harness). */
  setupOff: false,
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
  host.timerAt = at
  // While MarginCue's card is up in an app, the dialog's watcher fires it, on a handle that outlives the drawing.
  if (at === null || host.gate) return
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
  host.timerAt = null
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

type Held = 'send' | 'raw'

/** A question of the app's own panel and the card row it answers. */
type PanelQuestion = {
  row: string
  many: boolean
  question: string
  header: string
  /** The labels as the panel shows them, and the row option each stands for. */
  labels: string[]
  indexes: number[]
}

/**
 * The card for a prompt sent from an app whose draft MarginCue never saw (the desktop app, VS Code, a phone): read at
 * Enter, then its open choices asked in Claude's own question panel, one after another. Each keeps the panel's
 * "Other", where the person adds what the question made them think of: their words go as that choice's Decision.
 * The panel is the engine's own (`$.ui.ask`), never counted against a hook's 10 s, so the person answers in their
 * own time. Closing it stops the questions; what is set so far goes. Nothing open: the prompt goes once read.
 */
async function askAtEnter($: $, text: string): Promise<{ how: Held; addition?: string }> {
  run($, { type: 'draft', now: now(), text, origin: 'paste', cursor: text.length })
  const card = await readAtEnter($)
  if (!card) return { how: 'send' }
  if (host.appHost) return gateAtEnter($)
  for (const question of panelQuestions(card)) {
    let answer: string
    try {
      answer = await $.ui.ask(question.question, { options: question.labels, header: question.header, ...(question.many && { multiSelect: true as const }) })
    } catch {
      break
    }
    // Skip answers with a bracketed marker ("[No preference]"): that choice is left to Claude.
    if (skipped(answer)) continue
    answerRow($, question, answer)
  }
  return { how: 'send' }
}

const skipped = (answer: string) => !answer.trim() || /^\s*\[[^\]]*\]\s*$/.test(answer)

/**
 * In an app (the desktop app, VS Code), MarginCue draws its own card where Claude's dialog opens (`ui.render` on
 * AskUserQuestion): the reading, every open choice as buttons, the preview. Claude's dialog stays under it as one
 * question, send or send as written, and what the person types under its "Other" is added to the prompt. The
 * dialog is the engine's own (`$.ui.ask`): the prompt waits on the person, never on a hook's 10 s.
 */
async function gateAtEnter($: $): Promise<{ how: Held; addition?: string }> {
  host.gate = true
  // A pick on the card runs on its drawing's handle, which ends with the drawing; what the pick sets off later (the
  // preview redrawn for the new choice) is fired here instead, on this hook's handle, alive until the person sends.
  // Its own ticks count the time too, so it keeps pace under any clock.
  const start = now()
  let ticks = 0
  const pump = $.clock.every(250, () => {
    ticks++
    const at = host.timerAt
    if (at !== null && Math.max(now(), start + ticks * 250) >= at) fireTimer($, at)
  })
  if (host.view) publish($, host.view)
  try {
    const answer = await $.ui.ask(GATE_QUESTION, { options: [GATE_SEND, GATE_RAW], header: 'MarginCue' })
    if (answer === GATE_RAW) return { how: 'raw' }
    if (answer === GATE_SEND || skipped(answer)) return { how: 'send' }
    return { how: 'send', addition: answer.trim() }
  } catch {
    return { how: 'send' }
  } finally {
    pump.cancel()
    host.gate = false
  }
}

/** The options a card shows of a row: a long range shows its ends, the assumed step and one between. */
function shownOptions(row: MargincueRow): number[] {
  const last = row.options.length - 1
  if (row.type !== 'range' || last <= 4) return row.options.map((_, i) => i)
  const at = row.selected[0] ?? 0
  return [...new Set([0, at, Math.round((at + last) / 2), last])].sort((a, b) => a - b)
}

/** A choice's name on its chip: the card's label, acronyms kept whole. */
function chipName(row: MargincueRow): string {
  if (row.origin === 'repo') return `${row.statement.replace(/\s+is\s+\{\}\s*$/, '').replace(/^"(.*)"$/, '\u201c$1\u201d')} is`
  const words = row.label.split(' ').map((word) => /^(csv|api|ui|url|id|ids|db|sql|pdf|json|ux)$/i.test(word) ? word.toUpperCase() : word)
  const name = words.join(' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** What a pick-any chip shows: the first of what is set and how many more. */
function chipSummary(row: MargincueRow): string {
  const set = row.selected.map((i) => row.options[i]!).filter(Boolean)
  return set.length === 0 ? 'nothing more' : set.length === 1 ? set[0]! : `${set[0]} +${set.length - 1}`
}

/**
 * One choice as a chip in an app: its name, then the app's own dropdown with the value in force. A pick-any chip's
 * menu ticks what is set; each entry names the state it leads to, so a pick that arrives twice still lands once.
 */
function choiceChip($: $, ui: Elements[RenderSurface], row: MargincueRow) {
  const { Select } = ui
  const options = shownOptions(row)
  if (row.type === 'many') {
    // The menu's first entry is what the chip shows; each one under it adds or drops its option.
    const items: { key: string; value: string; label: string }[] = [{ key: `card-${row.id}-set`, value: 'set', label: chipSummary(row) }]
    for (const i of options) {
      const on = row.selected.includes(i)
      items.push({ key: `card-${row.id}-${i}`, value: `${on ? 'drop' : 'add'}-${i}`, label: `${on ? '\u2713' : '\u25cb'} ${row.options[i]}` })
    }
    const toggle = (value: string): void => {
      const [verb, at] = value.split('-')
      const option = Number(at)
      const now = host.view?.card?.rows.find((entry) => entry.id === row.id)
      if (!now || Number.isNaN(option) || (verb === 'add') === now.selected.includes(option)) return
      void act($, { type: 'cardSet', row: row.id, option })
    }
    return <Select key={`card-${row.id}`} label={chipName(row)} value="set" options={items} onSelect={toggle} />
  }
  return (
    <Select key={`card-${row.id}`} label={chipName(row)} value={String(row.selected[0] ?? options[0] ?? 0)}
      options={options.map((i) => ({ key: `card-${row.id}-${i}`, value: String(i), label: row.options[i]! }))}
      onSelect={(value) => act($, { type: 'cardSet', row: row.id, option: Number(value) })} />
  )
}

/**
 * The preview as a picture: the sketch's lines in a monospaced face on a panel of its own, scaled to the card's
 * width, so a line never wraps and the box drawing keeps its shape. The panel's colours follow the system's scheme.
 */
function sketchSvg(lines: readonly string[]): { source: string; height: number } {
  const CHAR = 7.2
  const LINE = 16
  const PAD = 12
  const width = Math.ceil(Math.max(20, ...lines.map((line) => [...line].length)) * CHAR + PAD * 2)
  const height = lines.length * LINE + PAD * 2 - 4
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows = lines.map((line, i) => `<text x="${PAD}" y="${PAD + 12 + i * LINE}" xml:space="preserve">${esc(line)}</text>`).join('')
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    '<style>rect{fill:#f4f3ef;stroke:#e2e0da}text{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#3d3b36}' +
    '@media (prefers-color-scheme:dark){rect{fill:#262624;stroke:#3a3936}text{fill:#d6d4cd}}</style>' +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8"/>${rows}</svg>`
  return { source, height }
}

/**
 * MarginCue's card above Claude's dialog in an app: each choice Claude would make is one chip, its name and its
 * value, and a click opens the app's own menu right there. A pick-any chip's menu ticks what is set and a pick
 * toggles it. The app takes at most 48 rows there, counted at 40 columns, and draws nothing of a tree past that:
 * the card keeps under it, the preview only whole.
 */
function drawGateCard($: $, ui: Elements[RenderSurface], card: NonNullable<MargincueBand['card']>) {
  const { Box, Text } = ui
  // Drawn only in an app, whose table has a vector picture.
  const { Svg } = ui as Elements['desktop']
  // Inside the frame: 40 columns less its padding; a Code block draws its own inset too.
  const COLS = 34
  const rowsOf = (text: string, cols = COLS) => text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0)
  const valueOf = (row: MargincueRow) => row.type === 'many' ? chipSummary(row) : row.options[row.selected[0] ?? 0] ?? ''
  const count = card.rows.length
  const yours = card.rows.filter((row) => row.chosen).length
  const head = `\u00b7 ${count} choice${count === 1 ? '' : 's'} Claude would make${yours ? `, ${yours} yours` : ''}`
  const hint = 'Anything to add? Pick Other below.'
  // 48 rows, less the frame (border and padding, 4), the gaps between its parts (3) and the dialog's (1), a margin (2).
  let budget = 48 - 4 - 3 - 1 - 2 - rowsOf(`MarginCue ${head}`) - rowsOf(hint)
  // Chips flow in a row: each takes its name, its value and a chevron, wrapping at the frame's width.
  let used = COLS
  const shown: MargincueRow[] = []
  for (const row of card.rows) {
    const width = chipName(row).length + valueOf(row).length + 6
    const extra = used + 1 + width > COLS ? Math.max(1, Math.ceil(width / COLS)) + 1 : 0
    if (extra > budget) break
    budget -= extra
    used = extra ? Math.min(width, COLS) : used + 1 + width
    shown.push(row)
  }
  const left = card.rows.length - shown.length
  if (left) budget -= 1
  // The picture keeps its own measure: about one row a sketch line.
  const sketch = card.sketch && card.sketch.lines.length && card.sketch.lines.length + 3 <= budget ? card.sketch : null
  const chip = (row: MargincueRow) => choiceChip($, ui, row)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={2} paddingY={1} rowGap={1}>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text weight="semibold" color={host.palette.accent}>MarginCue</Text>
        <Text dimColor>{head}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
        {shown.map(chip)}
      </Box>
      {left ? <Text dimColor>{`${left} more left to Claude`}</Text> : null}
      {sketch ? (
        <Box flexDirection="column" rowGap={0}>
          <Text dimColor>{`Preview \u00b7 ${sketch.title}`}</Text>
          <Svg source={sketchSvg(sketch.lines).source} alt={`A sketch of ${sketch.title}: ${sketch.lines.join(' ').replace(/\s+/g, ' ').slice(0, 300)}`} />
        </Box>
      ) : null}
      <Text dimColor>{hint}</Text>
    </Box>
  )
}

/** The card once read, or null when nothing in it is open. A model call in flight costs the hook nothing. */
function readAtEnter($: $): Promise<NonNullable<View['card']> | null> {
  return new Promise((resolve) => {
    const timer = $.clock.after(READ_WAIT_MS, () => finish(null))
    const watch = $.clock.every(250, () => {
      const card = host.view?.card
      if (!card || card.stage !== 'draft') return finish(null)
      if (card.reading) return
      const open = card.rows.length > 0 || card.mentions.some((mention) => mention.status === 'missing')
      finish(open ? card : null)
    })
    const finish = (card: NonNullable<View['card']> | null) => {
      timer.cancel()
      watch.cancel()
      resolve(card)
    }
  })
}

/** The panel's questions: names the code lacks first, then the open choices; four at most. */
function panelQuestions(card: NonNullable<View['card']>): PanelQuestion[] {
  const rows = [...card.rows.filter((row) => row.origin === 'repo'), ...card.rows.filter((row) => row.origin !== 'repo')]
  const out: PanelQuestion[] = []
  for (const row of rows) {
    if (out.length === 4) break
    // The panel takes four options and preselects the first: the one Claude would assume goes first, and says so.
    // A range offers the assumed step, its ends and one between.
    const last = row.options.length - 1
    const assumed = row.selected[0]
    let indexes = row.options.map((_, i) => i).slice(0, 4)
    if (row.type === 'range' && last > 3) {
      const at = assumed ?? 0
      indexes = [...new Set([0, at, Math.round((at + last) / 2), last])].sort((a, b) => a - b)
    } else if (assumed !== undefined && !indexes.includes(assumed) && indexes.length === 4) indexes[3] = assumed
    if (row.origin !== 'repo' && assumed !== undefined && indexes.includes(assumed)) indexes = [assumed, ...indexes.filter((i) => i !== assumed)]
    const mark = row.learned ? ' (your usual)' : ' (assumed)'
    const labels = indexes.map((i) => `${row.options[i]}${row.origin !== 'repo' && row.selected.includes(i) ? mark : ''}`)
    if (new Set(labels).size < 2 || new Set(labels).size !== labels.length) continue
    const repo = row.origin === 'repo'
    const name = repo ? row.statement.replace(/\s+is\s+\{\}\s*$/, '') : ''
    // The app shows the question alone, not its header chip: a choice's label leads its question.
    const label = row.label.charAt(0).toUpperCase() + row.label.slice(1)
    const ask = row.statement.replace('{}', '…').replace(/[.:]?\s*$/, '')
    // …unless the question already opens on it ("Placed: place the page" reads as a stutter).
    const [said, named] = [ask, row.label].map((text) => (text.toLowerCase().match(/[a-z]+/) ?? [''])[0]!)
    let common = 0
    while (common < said!.length && common < named!.length && said![common] === named![common]) common++
    const echoes = common >= 3 && common >= Math.min(said!.length, named!.length) - 1
    const question = repo ? `${name} isn't in your code. Which do you mean?`
      : echoes ? `${ask}?` : `${label}: ${ask.charAt(0).toLowerCase()}${ask.slice(1)}?`
    if (out.some((entry) => entry.question === question)) continue
    const header = (repo ? name.replace(/["“”]/g, '') : label).slice(0, 12)
    out.push({ row: row.id, many: row.type === 'many', question, header, labels, indexes })
  }
  return out
}

/** One answer onto its row: the options it names, or else the person's own words. */
function answerRow($: $, question: PanelQuestion, answer: string): void {
  const row = host.view?.card?.rows.find((entry) => entry.id === question.row)
  if (!row) return
  // A label can hold a comma and a multi-select answer comes comma-joined: find the labels in it, longest first.
  let rest = answer
  const named = new Set<number>()
  const order = question.labels.map((label, k) => ({ label, k })).sort((a, b) => b.label.length - a.label.length)
  for (const { label, k } of order) {
    if (question.many ? rest.includes(label) : rest === label) {
      named.add(question.indexes[k]!)
      rest = rest.replace(label, '')
    }
  }
  if (!named.size || rest.replace(/[\s,]+/g, '')) {
    run($, { type: 'cardSay', now: now(), row: row.id, text: answer })
    return
  }
  if (!question.many) {
    run($, { type: 'cardSet', now: now(), row: row.id, option: [...named][0]! })
    return
  }
  for (let i = 0; i < row.options.length; i++) {
    if (named.has(i) !== row.selected.includes(i)) run($, { type: 'cardSet', now: now(), row: row.id, option: i })
  }
}

/**
 * What a prompt carries once the person sends it: the Decisions they set (and the sketch they attached), with the
 * turn noted for the switches and the follow-up.
 */
async function submitted($: $, typed: string, turnId?: string, addition?: string): Promise<{ text: string; amendable: boolean }> {
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
  const amendable = !turnId && !host.activeTurn && !host.turn
  const effects = run($, { type: 'submit', now: now(), text: typed, amendable }, false)
  const sent = effects.find((fx): fx is SubmitEffect => fx.type === 'submit')
  const decided = sent?.text ?? typed
  // What the person added under "Other" joins the prompt itself, ahead of its Decisions.
  const at = decided.lastIndexOf('\n\nDecisions:\n')
  const text = !addition ? decided : at < 0 ? `${decided.replace(/\s+$/, '')}\n\n${addition}` : `${decided.slice(0, at)}\n\n${addition}${decided.slice(at)}`
  if (amendable) host.turn = { id: null, text }
  return { text, amendable }
}

/**
 * The agent's marked choices in an app (the desktop app, VS Code, a phone), in the app's own type and buttons:
 * one line each, its label then its options, the one in force filled. Switching one reaches the agent at its
 * next step, or after the turn writes the follow-up.
 */
function drawChoicesApp($: $, ui: Elements[RenderSurface], card: NonNullable<MargincueBand['card']>, maxRows: number) {
  const { Box, Text } = ui
  const turn = card.stage === 'turn'
  const count = card.rows.length
  const shown = card.rows.slice(0, Math.max(1, maxRows - 2))
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text weight="semibold" color={host.palette.accent}>MarginCue</Text>
        <Text dimColor>{`\u00b7 Claude made ${count} choice${count === 1 ? '' : 's'} for you \u00b7 ${turn ? 'switch one and it adapts at its next step' : 'switch one to write the follow-up'}`}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={0}>
        {shown.map((row: MargincueRow) => choiceChip($, ui, row))}
      </Box>
      {count > shown.length ? <Text dimColor>{`${count - shown.length} more in the terminal card`}</Text> : null}
    </Box>
  )
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

/**
 * The part of a session's start that needs a person at the prompt: the project index, the first-run questions,
 * the trial and the file watch. The REPL has one from the start; a session driven through the SDK (the desktop
 * app, VS Code, a phone) gains one when its client attaches.
 */
async function present($: $, turns: number): Promise<void> {
  host.interactive = true
  // The index first: it runs in the background while the rest settles.
  if (host.settings.mode !== 'off') void reindex($, true)
  watch($)
  await startTrial($, turns === 0)
  // The arm decides whether the card shows: the core hears it.
  if (host.arm && host.core) run($, configEvent())
  // First run: a few questions about the person's work, once the screen is up and only into an empty prompt;
  // someone who started typing straight away is asked in their next session instead.
  // MARGINCUE_NO_SETUP=1 keeps them away from a session that is not the person's own (a recording, a test harness).
  const noSetup = await $.env.get('MARGINCUE_NO_SETUP').catch(() => undefined)
  host.setupOff = Boolean(noSetup && noSetup !== '0')
  // The desktop app starts a session with its first message, so the box is never empty and idle at the start:
  // there the questions come after the first answer instead (turn.complete).
  host.onboardPending = !host.appHost && host.settings.mode !== 'off' && host.settings.onboarded === null && turns === 0 && !host.setupOff
  if (host.onboardPending) {
    const epoch = host.epoch
    $.clock.after(1500, async () => {
      if (epoch !== host.epoch || !host.onboardPending) return
      host.onboardPending = false
      const box = await $.prompt.read().catch(() => ({ text: 'unknown' }))
      if (box.text.trim() === '' && host.activeTurn === null) void onboard($, false)
    })
  }
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
  ensure($)
  if (host.settings.mode !== 'off') await enqueue(() => refresh($, turns > 0))
  else run($, { type: 'loadState', now: now(), state: { model: null, values: [], submitted: turns > 0 } })
  if (loaded.skipped && host.settings.mode !== 'off') void $.ui.toast(`MarginCue skipped ${loaded.skipped} invalid or conflicting personal bundle(s).`)
  host.indexedAt = -Infinity
  host.blankSeen.clear()
  host.blankOld.clear()
  host.onboardPending = false
  if (host.settings.mode !== 'off') void readLearned($, host.root).then((picks) => run($, { type: 'learned', picks })).catch(() => {})
  // The desktop app and VS Code drive the engine through its SDK and say so in its entrypoint: a person is there.
  // Elsewhere an SDK session gains one when an app attaches; a -p run or a script never does, and is left alone.
  const entry = await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)
  host.appHost = entry && /desktop|vscode|jetbrains|mobile/i.test(entry) ? entry : null
  if (interactive || host.appHost) await present($, turns)
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
    if (e.command !== undefined || e.isMeta === true || !personal(e.origin.kind) || isHostCommand(e.text) || host.shell) {
      flushClear($)
      return next(e)
    }
    dropClear()
    let addition: string | undefined
    // An app (desktop, VS Code, phone) never shows MarginCue the draft while it is typed: the card comes at Enter,
    // before Claude starts, and the prompt goes when the person sends it (or as written).
    // The engine stamps the desktop app's typed prompts `composer` as well: the app, not the stamp, says the draft was unseen.
    if ((host.appHost || e.origin.kind !== 'composer') && !e.turnId && !host.activeTurn && host.view?.text !== e.text && host.settings.mode !== 'off') {
      const asked = await askAtEnter($, e.text)
      addition = asked.addition
      if (asked.how === 'raw') run($, { type: 'draft', now: now(), text: '', origin: 'type', cursor: 0 }, false)
    }
    const { text, amendable } = await submitted($, e.text, e.turnId, addition)
    // An app never clears its box through MarginCue: once the prompt goes, its card goes too.
    if (host.appHost || e.origin.kind !== 'composer') run($, { type: 'draft', now: now(), text: '', origin: 'type', cursor: 0 }, false)
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
      // In the desktop app the first-run questions wait for the first answer: the session never starts idle.
      if (host.appHost && host.settings.onboarded === null && host.settings.mode !== 'off' && !host.setupOff && !host.onboarding) {
        void onboard($, false)
      }
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

  // Claude's dialog while MarginCue's card is up in an app: the card above, Claude's send question under it. Any
  // other question (Claude's own) is drawn as asked.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const asked = (e.props.questions[0] as { question?: unknown } | undefined)?.question
    if (!host.gate || asked !== GATE_QUESTION || e.surface === 'terminal') return next(e)
    const state = await read($, band)
    const card = state?.card
    if (!card || card.stage !== 'draft') return next(e)
    const ui = $.ui.resolve(e)
    const drawing = await next(e)
    return <ui.Box flexDirection="column" rowGap={1}>{drawGateCard($, ui, card)}{drawing}</ui.Box>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      host.bandChoices = []
      return next(e)
    }
    const state = await read($, band)
    const card = state?.card
    // An app (the desktop app, VS Code, a phone) asks the card's questions in its own panel at Enter; above its box
    // it shows only the agent's marked choices, in its own type and buttons.
    if (e.surface !== 'terminal') {
      if (!state?.enabled || !card || card.stage === 'draft' || !card.rows.length || e.props.isCollapsed) return next(e)
      run($, { type: 'cardShown', now: now(), id: card.id }, false)
      return drawChoicesApp($, $.ui.resolve(e), card, e.props.maxRows ?? 12)
    }
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
    // A mark still streaming in ("⟦week starts: Mon") is held back until it closes: the reader never sees the markup.
    const full = e.props.text
    const open = full.lastIndexOf(BLANK_OPEN)
    const text = open > full.lastIndexOf(BLANK_CLOSE) ? full.slice(0, open) : full
    if (!full.includes(BLANK_OPEN) || host.settings.mode === 'off') return next(e)
    if (text !== full && !text.includes(BLANK_OPEN)) return next({ ...e, props: { ...e.props, text } })
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
          <Text dimColor>{' to switch one'}</Text>
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
    if (e.props.isExpanded || !personal(e.props.origin.kind) || host.settings.mode === 'off') return next(e)
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
    // A scripted run (claude -p) has nobody to switch a choice: its output stays exactly as it would be without MarginCue.
    if (!protocol || !host.interactive || !host.settings.blanks || !host.settings.sheet || host.settings.mode === 'off') return result
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
  // A client attaching (the desktop app, VS Code, a phone) means a person is at this session.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (!host.interactive && host.core) void present($, await $.session.turns().catch(() => 0)).catch(() => {})
    return result
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (!('deny' in result && result.deny)) host.palette = paletteFor(e.value)
    return result
  }).catch(($, e, next) => next.called ? next(e) : next(e))
}

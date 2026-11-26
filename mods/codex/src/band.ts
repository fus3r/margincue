// The card under Codex's prompt box. `margincue codex` starts margincue-relay
// (crates/margincue-relay), which runs Codex a few rows short of the terminal and draws
// these rows below it. The relay reports the draft as Codex shows it; this side runs the
// same card as the ctrl+g composer and Claude Code (the core, readings through the
// person's own Codex login, names checked against the code) and answers with the rows to
// draw, the keys it wants, and what Enter adds to the prompt.
//
// One JSON object per line each way; see crates/margincue-relay/src/protocol.rs.

import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { diffSplice } from '../../claude-code/core/anchor'
import { FILE_REFERENCES_HEADING } from '../../claude-code/core/decisions'
import { createCore } from '../../claude-code/core/index'
import type { Effect, Event, View } from '../../claude-code/core/index'
import { ASSETS } from '../../claude-code/hooks/assets'
import { layoutCard } from '../../claude-code/hooks/card-view'
import { collectVocabulary } from '../../claude-code/hooks/repo-index'
import { CARD_KEEP_KEY, DARK } from '../../claude-code/hooks/segments'
import type { Action, Segment, Style } from '../../claude-code/hooks/segments'
import type { MargincueCard } from '../../claude-code/types'
import { cardConfig } from './card-config'
import { CodexModel } from './model'
import type { Completion } from './model'
import { PATHS, learn, processEngine, readJson, readLearned, readSettings, watchSettings, writeJson } from './store'
import type { Settings, TurnRecord } from './store'
import { drawLine } from './terminal'
import type { Hit } from './terminal'
import { agentCard, markSent, mergeTurn, pick, readTurn } from './turn-card'
import type { Agent } from './turn-card'

export const PROTOCOL = 1

/** Relay to MarginCue. */
export type Up =
  | { t: 'hello'; protocol: number; cols: number; rows: number; max: number; full: boolean; readKey?: boolean; keepKey?: boolean }
  | { t: 'size'; cols: number; rows: number; max: number; full: boolean }
  | { t: 'draft'; text: string | null; approx: boolean; end: boolean; plain: boolean }
  | { t: 'key'; key: 'up' | 'down' | 'read' | 'keep' }
  | { t: 'click'; x: number; y: number }
  | { t: 'enter'; text: string; approx: boolean }
  | { t: 'wrote'; id: number; ok: boolean }
  | { t: 'toggle'; on: boolean }
  | { t: 'dismiss' }

/** MarginCue to the relay. */
export type Down =
  | { t: 'band'; lines: string[] }
  | { t: 'claims'; enter: boolean; arrows: boolean; read?: boolean; keep?: boolean }
  | { t: 'enter'; do: 'pass' | 'append' | 'replace'; text?: string }
  | { t: 'write'; id: number; text: string; expect?: string }

export type Reader = {
  start(): Promise<string | null>
  complete(system: string, prompt: string, options?: { signal?: AbortSignal; onDelta?: (delta: string) => void }): Promise<Completion>
  close(): void
  readonly problem: string | null
}

export type BandOptions = {
  cwd: string
  send: (message: Down) => void
  model?: Reader
  /** The repo index for names in the draft (tests leave it out). */
  vocabulary?: boolean
  /** How often the turn the hooks saw is read again. */
  turnEveryMs?: number
}

const P = DARK
const SPIN_MS = 90
const now = () => performance.now()

type Seen = { text: string | null; approx: boolean; end: boolean; plain: boolean }

export class Band {
  private readonly cwd: string
  private readonly send: (message: Down) => void
  private readonly model: Reader
  private readOnDemand = false
  private sendOpen = false
  private readonly stopWatching: () => void
  private readonly core = createCore(ASSETS)
  private readonly inflight = new Map<number, AbortController>()
  private timer: NodeJS.Timeout | null = null
  private spinner: NodeJS.Timeout | null = null
  private turnTimer: NodeJS.Timeout | null = null
  private view: View | null = null
  private size = { cols: 80, rows: 24, max: 1, full: false }
  private draft: Seen = { text: null, approx: false, end: true, plain: false }
  /** The text the core last saw. */
  private coreText = ''
  private on = true
  private readKey = false
  private keepKey = false
  /** The draft the card was hidden for (ctrl+] d), until it changes. */
  private dismissed: string | null = null
  private agent: Agent | null = null
  private turnRunning = false
  private turnStamp = ''
  private ready = false
  private modelName: string | null = null
  /** After Enter: how many Decisions went with the prompt, until the next draft. */
  private sent: number | null = null
  /** Until the box empties after Enter, what it shows is the prompt on its way, not a new draft. */
  private sendingUntil = 0
  private height = 1
  private hits: Hit[] = []
  private frame = 0
  private lastBand = ''
  private lastClaims = ''
  private marked = ''
  private writes = 0
  private closed = false

  constructor(options: BandOptions) {
    this.cwd = options.cwd
    this.send = options.send
    this.model = options.model ?? new CodexModel(options.cwd)
    this.configure(readSettings())
    this.stopWatching = watchSettings((settings) => this.configure(settings))
    this.run({ type: 'learned', picks: readLearned(this.cwd) })
    void this.model.start().then((name) => {
      this.ready = true
      this.modelName = name
      this.render()
    })
    if (options.vocabulary !== false) {
      void collectVocabulary(processEngine, this.cwd)
        .then((vocab) => this.run({ type: 'vocabulary', vocab }))
        .catch(() => {})
    }
    this.readTurn()
    this.turnTimer = setInterval(() => this.readTurn(), options.turnEveryMs ?? 1000)
    this.turnTimer.unref?.()
  }

  close(): void {
    this.closed = true
    this.stopWatching()
    if (this.timer) clearTimeout(this.timer)
    if (this.spinner) clearInterval(this.spinner)
    if (this.turnTimer) clearInterval(this.turnTimer)
    for (const abort of this.inflight.values()) abort.abort()
    this.model.close()
  }

  private configure(settings: Settings): void {
    const config = cardConfig(settings)
    this.readOnDemand = settings.mode !== 'off' && config.read === 'key'
    this.sendOpen = config.send === 'open'
    this.run(config)
  }

  receive(message: Up): void {
    if (this.closed) return
    switch (message.t) {
      case 'hello':
        this.readKey = message.readKey === true
        this.keepKey = message.keepKey === true
        this.size = { cols: message.cols, rows: message.rows, max: message.max, full: message.full }
        break
      case 'size':
        this.size = { cols: message.cols, rows: message.rows, max: message.max, full: message.full }
        break
      case 'draft':
        this.onDraft(message)
        break
      case 'key':
        this.onKey(message.key)
        break
      case 'click': {
        const hit = this.hits.find((h) => h.y === message.y && message.x >= h.x0 && message.x < h.x1)
        if (hit) this.act(hit.action)
        break
      }
      case 'enter':
        this.onEnter(message.text, message.approx)
        break
      case 'wrote':
        break
      case 'toggle':
        this.on = message.on
        break
      case 'dismiss':
        this.dismissed = this.draft.text ?? ''
        this.height = 1
        break
    }
    this.render()
  }

  // ---- the core, as the composer drives it --------------------------------------------

  private run(event: Event): void {
    for (const fx of this.core.handle(event)) this.effect(fx)
    this.render()
  }

  private effect(fx: Effect): void {
    if (fx.type === 'view') this.view = fx.view
    else if (fx.type === 'request') this.request(fx.req, fx.system, fx.prompt)
    else if (fx.type === 'cancel') {
      this.inflight.get(fx.req)?.abort()
      this.inflight.delete(fx.req)
    } else if (fx.type === 'timer') {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      const at = fx.at
      if (at !== null) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.run({ type: 'timer', now: Math.max(now(), at) })
        }, Math.max(0, at - now()))
      }
    } else if (fx.type === 'fill') {
      // A follow-up the core offers goes in an empty box only.
      if (!(this.draft.text ?? '').trim()) this.write(fx.text, fx.replaces ?? undefined)
    } else if (fx.type === 'learn') {
      try {
        learn(this.cwd, fx.key, fx.label)
      } catch {}
    }
  }

  private request(req: number, system: string[], prompt: string): void {
    const abort = new AbortController()
    this.inflight.set(req, abort)
    void this.model.complete(system.join('\n\n'), prompt, {
      signal: abort.signal,
      onDelta: (delta) => {
        if (!abort.signal.aborted) this.run({ type: 'reply', now: now(), req, text: delta, done: false })
      },
    }).then((outcome) => {
      if (abort.signal.aborted || this.closed) return
      this.inflight.delete(req)
      this.run(outcome.ok
        ? { type: 'reply', now: now(), req, text: '', done: true }
        : { type: 'reply', now: now(), req, text: '', done: true, ok: false })
    })
  }

  // ---- what the relay reports ----------------------------------------------------------

  private onDraft(seen: Seen): void {
    const before = this.draft.text
    this.draft = seen
    const text = seen.text
    if (text === null || !this.on) return
    if (this.sendingUntil) {
      if (text.trim() && Date.now() < this.sendingUntil) return
      this.sendingUntil = 0
    }
    if (this.agent && this.agent.text && before === this.agent.text && !text.trim()) {
      // The amendment went into the turn: what it asked for is now what the turn has.
      markSent(this.agent)
      this.turnStamp = ''
      this.readTurn()
    }
    if (this.agent && text === this.agent.text) return
    if (text !== this.dismissed) this.dismissed = null
    if (text !== this.coreText) {
      if (text.trim()) this.sent = null
      const edit = diffSplice(this.coreText, text)
      this.coreText = text
      if (!text.trim()) this.height = 1
      this.run({
        type: 'draft', now: now(), text, origin: 'type', edit,
        cursor: seen.end ? text.length : edit.start + edit.text.length,
      })
    }
  }

  /** Enter on a plain box while it is claimed: say what goes with the prompt. */
  private onEnter(text: string, approx: boolean): void {
    // The card hidden for this prompt (ctrl+] d): it goes as written.
    if ((this.agent && text === this.agent.text) || (this.dismissed !== null && this.dismissed === text)) {
      this.send({ t: 'enter', do: 'pass' })
      return
    }
    if (text !== this.coreText) {
      this.coreText = text
      this.run({ type: 'draft', now: now(), text, origin: 'type', edit: diffSplice(this.view?.text ?? '', text), cursor: text.length })
    }
    let sent = text
    let decisions: string[] = []
    for (const fx of this.core.handle({ type: 'submit', now: now(), text, amendable: false })) {
      if (fx.type === 'submit') {
        sent = fx.text
        decisions = fx.decisions
      } else this.effect(fx)
    }
    this.coreText = ''
    this.sent = decisions.filter((line) => !line.startsWith(FILE_REFERENCES_HEADING)).length
    this.sendingUntil = Date.now() + 3000
    this.height = 1
    const head = text.replace(/\s+$/, '')
    let answer: Down
    if (sent === text) answer = { t: 'enter', do: 'pass' }
    else if (sent.startsWith(head)) answer = { t: 'enter', do: 'append', text: sent.slice(head.length) }
    else if (!approx) answer = { t: 'enter', do: 'replace', text: sent }
    else answer = { t: 'enter', do: 'pass' }
    // The prompt hook knows a prompt whose card was seen by this text.
    const final = answer.do === 'append' ? `${head}${answer.text}` : answer.do === 'replace' ? sent : text
    this.mark(final, true)
    this.send(answer)
  }

  private onKey(key: 'up' | 'down' | 'read' | 'keep'): void {
    if (key === 'read') {
      if (this.on && this.draft.plain && this.shownCard()?.awaitingRead) this.run({ type: 'cardRead', now: now() })
      return
    }
    if (key === 'keep') {
      if (this.on && this.draft.plain && this.shownCard()?.stage === 'draft') this.act({ type: 'cardKeep' })
      return
    }
    const agent = this.shownAgent()
    if (agent) {
      if (key === 'up') agent.focus = (agent.focus + 1) % agent.blanks.length
      else this.switchAgent(agent, agent.focus, 'next')
      return
    }
    const focus = this.view?.card?.focus ?? null
    if (key === 'up') this.run({ type: 'cardFocus', dir: 1 })
    else this.run({ type: 'cardCycle', now: now(), ...(focus && { row: focus }) })
  }

  private act(action: Action): void {
    const agent = this.shownAgent()
    if (agent) {
      if (action.type === 'cardSet') return this.switchAgent(agent, Number(action.row.slice(1)), action.option)
      if (action.type === 'cardCycle' && action.row) return this.switchAgent(agent, Number(action.row.slice(1)), 'next')
      if (action.type === 'cardFocus' && action.row) agent.focus = Number(action.row.slice(1))
      return
    }
    const t = now()
    if (action.type === 'cardFocus') this.run({ type: 'cardFocus', ...(action.dir && { dir: action.dir }), ...(action.row && { row: action.row }) })
    else if (action.type === 'cardCycle') this.run({ type: 'cardCycle', now: t, ...(action.row && { row: action.row }) })
    else if (action.type === 'cardSet') this.run({ type: 'cardSet', now: t, row: action.row, option: action.option })
    else if (action.type === 'cardKeep') this.run({ type: 'cardKeep', now: t })
    else if (action.type === 'cardDismiss') this.run({ type: 'cardDismiss', now: t, row: action.row })
    else if (action.type === 'chapter') this.run(action)
    else if (action.type === 'sketch') this.run({ type: 'sketch', now: t, action: action.action })
  }

  // ---- the agent's choices ---------------------------------------------------------------

  /** The turn the hooks saw last on this project; its transcript is read again only when it grew. */
  private readTurn(): void {
    if (this.closed) return
    const record = readJson<TurnRecord | null>(PATHS.turn, null)
    const mine = record && record.cwd === this.cwd ? record : null
    const stamp = mine ? `${mine.turn}:${mine.endedAt}:${fileStamp(mine.transcript)}` : ''
    if (stamp === this.turnStamp) return
    this.turnStamp = stamp
    const running = Boolean(mine && mine.endedAt === null)
    const next = mine ? mergeTurn(this.agent, readTurn(this.cwd)) : null
    const shape = (agent: Agent | null) => JSON.stringify([agent?.turn, agent?.running, agent?.blanks.map((b) => [b.label, b.choice])])
    const changed = shape(next) !== shape(this.agent)
    this.agent = next
    if (changed || running !== this.turnRunning) {
      this.turnRunning = running
      this.render()
    }
  }

  /** The agent's switches show while the box is empty or holds their own amendment. */
  private shownAgent(): Agent | null {
    const agent = this.agent
    if (!agent || !agent.blanks.length || !this.on) return null
    const text = this.draft.text
    if (text === null) return null
    return !text.trim() || text === agent.text ? agent : null
  }

  private switchAgent(agent: Agent, row: number, option: number | 'next'): void {
    const before = agent.text
    const text = pick(agent, row, option)
    if (text !== before) this.write(text, before || undefined)
  }

  private write(text: string, expect?: string): void {
    this.send({ t: 'write', id: ++this.writes, text, ...(expect !== undefined && { expect }) })
  }

  /** Mark the prompt as one whose card was seen, for the prompt hook. */
  private mark(text: string, force = false): void {
    if (!text.trim() || (!force && text === this.marked)) return
    this.marked = text
    try {
      writeJson(PATHS.composed, { text, at: Date.now() })
    } catch {}
  }

  // ---- drawing ---------------------------------------------------------------------------

  private shownCard(): MargincueCard | null {
    const agent = this.shownAgent()
    if (agent) return agentCard(agent)
    const card = this.view?.card
    const text = this.draft.text
    if (!card || card.stage !== 'draft' || text === null || !text.trim()) return null
    if (this.dismissed !== null && this.dismissed === text) return null
    if (this.view?.text !== this.coreText) return null
    return card
  }

  private render(): void {
    if (this.closed) return
    const { cols, max, full } = this.size
    // A popup or dialog hides the box for a moment: the card stays as it was, and so does Codex's layout.
    if (this.draft.text === null && this.lastBand && this.on) {
      this.emit({ t: 'claims', enter: false, arrows: false })
      return
    }
    this.hits = []
    let lines: string[] = []
    const card = this.on && max > 0 ? this.shownCard() : null
    const regularCard = Boolean(card && (card.rows.length || card.read || card.reading || card.mentions.length || card.error || card.awaitingRead))
    if (max > 0) {
      if (card) {
        // Until its first rows arrive the card is one line; then it takes its room in one step.
        const budget = full && (card.chapter || card.rows.length || (card.read && !card.reading)) ? max : 1
        lines = layoutCard(card, cols, budget, {
          chords: true, extra: [], palette: P, sketchKey: 'ctrl+g', readHint: this.readHint(),
          keepHint: this.keepKey ? `ctrl+] ${CARD_KEEP_KEY}` : undefined,
          chapterKeys: false,
        })
          .slice(0, budget)
          .map((line, y) => drawLine(line, cols, y, this.hits, this.frame))
        if (regularCard && !this.shownAgent()) this.mark(this.coreText)
      } else lines = [drawLine(this.status(), cols, 0, this.hits, this.frame)]
    }
    // The card keeps its height while the prompt is written, so the box above it stays put.
    // Each change of height resizes Codex and moves its prompt box, so the card takes all the
    // room it may need as soon as rows start streaming in, and keeps it until the prompt is sent.
    const streaming = Boolean(card && (card.reading || card.sketch?.drawing) && card.rows.length)
    const want = !full || !card ? 1 : streaming ? max : lines.length
    this.height = !full || !card ? 1 : Math.max(this.height, want)
    if (full) while (lines.length < this.height) lines.push('')
    this.emit({ t: 'band', lines })
    const decisions = this.view?.decisions.length ?? 0
    const agentShown = Boolean(this.shownAgent())
    // A question about a name can go with the prompt as soon as its candidates are known.
    const openName = this.sendOpen && card?.rows.some((row) => row.origin === 'repo' && !row.chosen)
    const plan = regularCard && card?.stage === 'draft' && (openName || !card.reading && !card.awaitingRead)
    const hidden = this.dismissed !== null && this.dismissed === this.draft.text
    const read = this.readKey && this.readOnDemand && this.on && this.draft.plain
    const keep = this.keepKey && this.draft.plain && card?.stage === 'draft' &&
      card.rows.some((row) => !row.chosen && !row.openOnSend && row.selected.length)
    this.emit({
      t: 'claims',
      enter: this.on && !agentShown && !hidden && (decisions > 0 || plan) && Boolean(this.draft.text?.trim()),
      arrows: this.on && Boolean(card?.rows.length),
      ...(read && { read }),
      ...(keep && { keep }),
    })
    this.spin(Boolean(card?.reading || card?.sketch?.drawing))
  }

  private readHint(): string {
    return this.readKey ? 'ctrl+] c to read' : 'ctrl+g, then tab, c to read'
  }

  private status(): Segment[] {
    const tag: Segment = { kind: 'text', text: ' MarginCue ', style: P.tag }
    const say = (text: string, style: Style = { dim: true }): Segment[] => [tag, { kind: 'text', text: `  ${text}`, style }]
    if (!this.on) return say('off · ctrl+] t turns it back on')
    if (this.model.problem) return say(`readings unavailable: ${this.model.problem}`, { color: 'warning' })
    const text = this.draft.text
    if (this.sent !== null && !(text ?? '').trim()) {
      return say(this.sent ? `sent with ${this.sent} decision${this.sent === 1 ? '' : 's'}` : 'sent')
    }
    if (text === null) return say('')
    if (this.dismissed !== null && this.dismissed === text) return say('card hidden for this prompt · ctrl+] d')
    if (!this.ready) return say('starting…')
    if (this.readOnDemand && !this.turnRunning) return say(this.readHint())
    if (!text.trim()) {
      if (this.turnRunning) return say('Codex is working · the choices it makes for you show here')
      return say(`reads your prompt as you type · alt↑ alt↓ change a choice · ctrl+g full card${this.modelName ? ` · ${this.modelName}` : ''}`)
    }
    return say('reads the prompt once you pause')
  }

  private spin(busy: boolean): void {
    if (busy && !this.spinner) {
      this.spinner = setInterval(() => {
        this.frame++
        this.render()
      }, SPIN_MS)
    } else if (!busy && this.spinner) {
      clearInterval(this.spinner)
      this.spinner = null
    }
  }

  private emit(message: Down): void {
    const line = JSON.stringify(message)
    if (message.t === 'band') {
      if (line === this.lastBand) return
      this.lastBand = line
    } else if (message.t === 'claims') {
      if (line === this.lastClaims) return
      this.lastClaims = line
    }
    this.send(message)
  }
}

function fileStamp(file: string): string {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

/** Serves the relay on `link` until it closes. */
export function serveBand(link: Duplex, cwd: string, model?: Reader): Band {
  const band = new Band({
    cwd,
    send: (message) => {
      if (!link.destroyed) link.write(`${JSON.stringify(message)}\n`)
    },
    ...(model && { model }),
  })
  createInterface({ input: link }).on('line', (line) => {
    try {
      band.receive(JSON.parse(line) as Up)
    } catch {}
  })
  link.on('close', () => band.close())
  link.on('error', () => band.close())
  return band
}

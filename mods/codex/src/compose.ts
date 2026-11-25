// The composer: the editor Codex opens on ctrl+g. It shows the same card as Claude Code
// (how the agent will read the prompt, the names checked against the code, a control per
// open choice, a sketch) above the draft, and hands the prompt back with its Decisions.
// During a turn it shows the agent's own choices instead: switching one writes the
// amendment, which Enter in Codex sends into the running turn. After the turn, switching
// one writes the follow-up prompt.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createCore } from '../../claude-code/core/index'
import type { Effect, Event, View } from '../../claude-code/core/index'
import { ASSETS } from '../../claude-code/hooks/assets'
import { layoutCard } from '../../claude-code/hooks/card-view'
import { collectVocabulary } from '../../claude-code/hooks/repo-index'
import { DARK } from '../../claude-code/hooks/segments'
import type { Action, Segment, Style } from '../../claude-code/hooks/segments'
import { cardConfig } from './card-config'
import { runnable } from './command'
import { Draft } from './editor'
import { CodexModel } from './model'
import { PATHS, learn, processEngine, readLearned, readSettings, writeJson } from './store'
import { drawLine, parseKeys, sgr } from './terminal'
import type { Hit, Key } from './terminal'
import { agentCard, pick, readTurn } from './turn-card'

const P = DARK
const now = () => performance.now()

export async function compose(file: string): Promise<void> {
  const seed = readFileSync(file, 'utf8')
  const cwd = process.cwd()
  const settings = readSettings()
  const draft = new Draft(seed.replace(/\s+$/, ''))
  const core = createCore(ASSETS)
  const model = new CodexModel(cwd)
  const inflight = new Map<number, AbortController>()
  let view: View | null = null
  let timer: NodeJS.Timeout | null = null
  let cardKeys = false
  let hits: Hit[] = []
  let frame = 0
  let drawPending = false
  let spinner: NodeJS.Timeout | null = null
  let modelName = 'starting Codex…'
  let finished = false
  // Opened empty on this project during or soon after a turn: its choices become switches.
  const agent = draft.text.trim() ? null : readTurn(cwd)

  // ---- the core, as Claude Code's host drives it ----------------------------------------

  function run(event: Event): void {
    const effects = core.handle(event)
    for (const fx of effects) effect(fx)
    draw()
  }

  function effect(fx: Effect): void {
    if (fx.type === 'view') view = fx.view
    else if (fx.type === 'request') request(fx.req, fx.system, fx.prompt)
    else if (fx.type === 'cancel') {
      inflight.get(fx.req)?.abort()
      inflight.delete(fx.req)
    } else if (fx.type === 'timer') {
      if (timer) clearTimeout(timer)
      timer = null
      const at = fx.at
      if (at !== null) timer = setTimeout(() => {
        timer = null
        run({ type: 'timer', now: Math.max(now(), at) })
      }, Math.max(0, at - now()))
    } else if (fx.type === 'submit') finish(fx.text)
    else if (fx.type === 'fill') replaceText(fx.text)
    else if (fx.type === 'learn') {
      try {
        learn(cwd, fx.key, fx.label)
      } catch {}
    }
  }

  function request(req: number, system: string[], prompt: string): void {
    const abort = new AbortController()
    inflight.set(req, abort)
    void model.complete(system.join('\n\n'), prompt, {
      signal: abort.signal,
      onDelta: (delta) => {
        if (!abort.signal.aborted) run({ type: 'reply', now: now(), req, text: delta, done: false })
      },
    }).then((outcome) => {
      if (abort.signal.aborted) return
      inflight.delete(req)
      run(outcome.ok
        ? { type: 'reply', now: now(), req, text: '', done: true }
        : { type: 'reply', now: now(), req, text: '', done: true, ok: false })
    })
  }

  function edited(splice: { start: number; end: number; text: string } | null, origin: 'type' | 'paste'): void {
    if (!splice) return draw()
    if (agent && draft.text !== agent.text) leaveAgent()
    run({ type: 'draft', now: now(), text: draft.text, origin, edit: splice, cursor: draft.cursor })
  }

  function replaceText(text: string): void {
    draft.replace(0, draft.text.length, text)
    run({ type: 'draft', now: now(), text: draft.text, origin: 'fill', cursor: draft.cursor })
  }

  // ---- the agent's choices, during and after a turn -------------------------------------

  function switchAgent(row: number, option: number | 'next'): void {
    if (!agent || !agent.blanks[row]) return
    const text = pick(agent, row, option)
    draft.replace(0, draft.text.length, text)
    draw()
  }

  function leaveAgent(): void {
    if (!agent) return
    agent.blanks = []
  }

  const inAgent = () => Boolean(agent && agent.blanks.length && draft.text === agent.text)

  // ---- keys ----------------------------------------------------------------------------

  const keyState = { paste: null as string | null }

  function onKeys(data: Buffer): void {
    for (const key of parseKeys(data.toString('utf8'), keyState)) handle(key)
  }

  function handle(key: Key): void {
    if (finished) return
    const card = view?.card
    const focus = card?.focus ?? null
    if (key.kind === 'click') return click(key.x, key.y)
    if (key.kind === 'ctrl' && key.key === 'c') return cancel()
    if (key.kind === 'escape') {
      if (cardKeys) {
        cardKeys = false
        return draw()
      }
      return cancel()
    }
    if (key.kind === 'enter' && !key.newline) return submit()
    if (key.kind === 'tab') {
      cardKeys = !cardKeys
      return draw()
    }
    // alt+↑ next row, alt+↓ change its value: the same chords as in Claude Code (ctrl works too).
    if (key.kind === 'arrow' && (key.alt || key.ctrl) && (key.dir === 'up' || key.dir === 'down')) {
      if (inAgent()) {
        if (key.dir === 'up') agent!.focus = (agent!.focus + 1) % agent!.blanks.length
        else return switchAgent(agent!.focus, 'next')
        return draw()
      }
      if (key.dir === 'up') run({ type: 'cardFocus', dir: 1 })
      else run({ type: 'cardCycle', now: now(), ...(focus && { row: focus }) })
      return
    }
    if (cardKeys) return cardKey(key, focus)
    if (key.kind === 'text') return edited(draft.insert(key.text), 'type')
    if (key.kind === 'paste') return edited(draft.insert(key.text), 'paste')
    if (key.kind === 'enter') return edited(draft.insert('\n'), 'type')
    if (key.kind === 'backspace') return edited(draft.backspace(key.word), 'type')
    if (key.kind === 'delete') return edited(draft.deleteForward(), 'type')
    if (key.kind === 'ctrl') {
      if (key.key === 'u') return edited(draft.killLine(true), 'type')
      if (key.key === 'k') return edited(draft.killLine(false), 'type')
      if (key.key === 'a') draft.home()
      else if (key.key === 'e') return void ownEditor()
      else if (key.key === 'b') draft.move('left', false)
      else if (key.key === 'f') draft.move('right', false)
      return draw()
    }
    if (key.kind === 'alt') {
      if (key.key === 'b') draft.move('left', true)
      else if (key.key === 'f') draft.move('right', true)
      return draw()
    }
    if (key.kind === 'arrow') {
      if (key.dir === 'left' || key.dir === 'right') draft.move(key.dir, key.alt || key.ctrl)
      else draft.vertical(key.dir, editorWidth())
      return draw()
    }
    if (key.kind === 'home') draft.home()
    else if (key.kind === 'end') draft.end()
    draw()
  }

  /** Tab gives the card its keys. */
  function cardKey(key: Key, focus: string | null): void {
    if (inAgent()) {
      if (key.kind === 'text' && /^[1-9]$/.test(key.text)) return switchAgent(agent!.focus, Number(key.text) - 1)
      if (key.kind === 'arrow') {
        const n = agent!.blanks.length
        if (key.dir === 'down') agent!.focus = (agent!.focus + 1) % n
        else if (key.dir === 'up') agent!.focus = (agent!.focus + n - 1) % n
        else return switchAgent(agent!.focus, 'next')
      }
      return draw()
    }
    if (key.kind === 'text') {
      const ch = key.text.toLowerCase()
      if (/^[1-9]$/.test(ch) && focus) run({ type: 'cardSet', now: now(), row: focus, option: Number(ch) - 1 })
      else if (ch === 'c') run({ type: 'cardRead', now: now() })
      else if (ch === 'x' && focus) run({ type: 'cardDismiss', now: now(), row: focus })
      else if (ch === 's') run({ type: 'sketch', now: now(), action: 'toggle' })
      else if (ch === 'p') run({ type: 'sketch', now: now(), action: 'pin' })
      return
    }
    if (key.kind === 'arrow') {
      if (key.dir === 'down') run({ type: 'cardFocus', dir: 1 })
      else if (key.dir === 'up') run({ type: 'cardFocus', dir: -1 })
      else run({ type: 'cardCycle', now: now(), ...(focus && { row: focus }), dir: key.dir === 'left' ? -1 : 1 })
    }
  }

  function click(x: number, y: number): void {
    const hit = hits.find((h) => h.y === y && x >= h.x0 && x < h.x1)
    if (hit) act(hit.action)
  }

  function act(action: Action): void {
    if (inAgent()) {
      if (action.type === 'cardSet') return switchAgent(Number(action.row.slice(1)), action.option)
      if (action.type === 'cardCycle' && action.row) return switchAgent(Number(action.row.slice(1)), 'next')
      if (action.type === 'cardFocus' && action.row) agent!.focus = Number(action.row.slice(1))
      return draw()
    }
    const t = now()
    if (action.type === 'cardFocus') run({ type: 'cardFocus', ...(action.dir && { dir: action.dir }), ...(action.row && { row: action.row }) })
    else if (action.type === 'cardCycle') run({ type: 'cardCycle', now: t, ...(action.row && { row: action.row }) })
    else if (action.type === 'cardSet') run({ type: 'cardSet', now: t, row: action.row, option: action.option })
    else if (action.type === 'cardDismiss') run({ type: 'cardDismiss', now: t, row: action.row })
    else if (action.type === 'sketch') run({ type: 'sketch', now: t, action: action.action })
  }

  // ---- leaving -------------------------------------------------------------------------

  function submit(): void {
    if (inAgent() || !draft.text.trim()) return finish(draft.text)
    const effects = core.handle({ type: 'submit', now: now(), text: draft.text, amendable: false })
    const sent = effects.find((fx): fx is Extract<Effect, { type: 'submit' }> => fx.type === 'submit')
    finish(sent?.text ?? draft.text)
  }

  function cancel(): void {
    finish(seed, true)
  }

  function finish(text: string, unchanged = false): void {
    if (finished) return
    finished = true
    if (!unchanged || text !== seed) writeFileSync(file, text)
    if (!unchanged && text.trim()) {
      try {
        writeJson(PATHS.composed, { text, at: Date.now() })
      } catch {}
    }
    restore()
    for (const abort of inflight.values()) abort.abort()
    model.close()
    process.exit(0)
  }

  /** ctrl+e: the person's own editor on the draft, then back here. */
  function ownEditor(): void {
    const command = process.env['MARGINCUE_EDITOR'] || (process.platform === 'win32' ? 'notepad' : 'vi')
    const temp = join(tmpdir(), `margincue-${process.pid}.md`)
    writeFileSync(temp, draft.text)
    restore()
    // A quoted program keeps its spaces: "C:\Program Files\Notepad++\notepad++.exe" -multiInst
    const [cmd, ...args] = process.platform === 'win32'
      ? (command.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"(.*)"$/, '$1'))
      : command.split(/\s+/).filter(Boolean)
    const editor = runnable(cmd!, [...args, temp])
    spawnSync(editor.command, editor.args, { ...editor.options, stdio: 'inherit' })
    enter()
    try {
      replaceText(readFileSync(temp, 'utf8').replace(/\s+$/, ''))
    } catch {
      draw()
    }
  }

  // ---- drawing -------------------------------------------------------------------------

  const editorWidth = () => Math.max(10, (process.stdout.columns || 100) - 4)

  function draw(): void {
    if (drawPending || finished) return
    drawPending = true
    setImmediate(() => {
      drawPending = false
      paint()
    })
  }

  function paint(): void {
    const width = process.stdout.columns || 100
    const height = process.stdout.rows || 30
    hits = []
    const layout = draft.layout(editorWidth())
    const editorRows = Math.min(layout.rows.length, Math.max(3, Math.floor(height * 0.3)))
    const footer = 1
    // As in Claude Code and Codex, the text sits at the bottom with the card right above it.
    const budget = Math.max(3, height - 1 - editorRows - footer - 1)
    const card = inAgent() ? agentCard(agent!) : view?.card ?? null
    const busy = Boolean(card?.reading || card?.sketch?.drawing)
    const body: Segment[][] = card
      ? layoutCard(card, width, budget, { chords: true, extra: [], palette: P, sketchKey: 'tab, s', readHint: 'tab, c to read' })
      : [[{ kind: 'text', text: ' MarginCue ', style: P.tag }, { kind: 'text', text: settings.read === 'key' ? '  tab, c to read the draft.' : draft.text.trim()
        ? '  reads the prompt once you pause.' : '  Write the prompt; MarginCue reads it as you go.', style: { dim: true } }]]
    const lines = body.slice(0, budget)
    const top = height - footer - editorRows - 1 - lines.length - 1
    const out: string[] = []
    for (let y = 0; y < top; y++) out.push('')
    lines.forEach((line, i) => out.push(drawLine(line, width, top + i, hits, frame)))
    out.push('')
    out.push(sgr({ color: P.frame }) + '─'.repeat(width) + '\x1b[0m')
    const first = Math.max(0, Math.min(layout.cursorRow - editorRows + 1, layout.rows.length - editorRows))
    const styles = decorations()
    for (let r = first; r < first + editorRows; r++) {
      const row = layout.rows[r]
      if (!row) {
        out.push('')
        continue
      }
      const marker = r === 0 ? `${sgr({ bold: true })}›\x1b[0m ` : '  '
      out.push(` ${marker}${styledText(row.start, row.end, styles)}`)
    }
    out.push(drawLine(footerLine(width), width, height - 1, hits, frame))
    const screen = out.slice(0, height).map((line) => `${line}\x1b[K`).join('\r\n')
    // The editor's first row is the screen's (height - editorRows)th, counted from 1.
    const cursorY = height - editorRows + (layout.cursorRow - first)
    const cursorX = 4 + layout.cursorCol
    process.stdout.write(`\x1b[?25l\x1b[H${screen}\x1b[J\x1b[${cursorY};${cursorX}H\x1b[?25h`)
    if (busy && !spinner) spinner = setInterval(() => {
      frame++
      draw()
    }, 90)
    if (!busy && spinner) {
      clearInterval(spinner)
      spinner = null
    }
  }

  /** The keys on the left, where the readings come from on the right. */
  function footerLine(width: number): Segment[] {
    const keys = footerKeys()
    const status = model.problem ? `Codex unavailable: ${model.problem}` : modelName
    const used = keys.reduce((n, seg) => n + (seg.kind === 'text' ? seg.text.length : 0), 0)
    const gap = width - used - status.length - 1
    return gap > 1 ? [...keys, { kind: 'text', text: ' '.repeat(gap) }, { kind: 'text', text: status, style: model.problem ? { color: 'warning' } : { dim: true } }] : keys
  }

  function footerKeys(): Segment[] {
    const key = (k: string, what: string): Segment[] => [
      { kind: 'text', text: k, style: { color: P.accent } }, { kind: 'text', text: ` ${what}   `, style: { dim: true } }]
    if (inAgent()) {
      return [{ kind: 'text', text: ' ' }, ...key('enter', agent!.running ? 'back to Codex, then enter sends the change' : 'back to Codex with the follow-up'),
        ...key('alt↑ alt↓', 'switch'), ...key('esc', 'cancel')]
    }
    if (cardKeys) return [{ kind: 'text', text: ' ' }, ...key('1-9', 'pick'), ...key('x', 'drop row'), ...key('s', 'sketch'), ...key('p', 'attach sketch'), ...key('tab', 'back to the text')]
    return [{ kind: 'text', text: ' ' }, ...key('enter', 'back to Codex'), ...key('shift+enter', 'new line'), ...key('alt↑ alt↓', 'rows'),
      ...key('tab', 'card keys'), ...key('ctrl+e', 'your editor'), ...key('esc', 'cancel')]
  }

  /** Underlines in the draft: names found in the code, names it lacks, the words a row is about. */
  function decorations(): { start: number; end: number; style: Style }[] {
    const card = view?.card
    if (!card || inAgent() || view?.text !== draft.text) return []
    const out: { start: number; end: number; style: Style }[] = []
    for (const m of card.mentions) out.push({ start: m.start, end: m.end, style: { underline: true, color: m.status === 'found' ? 'suggestion' : 'warning' } })
    for (const row of card.rows) {
      if (row.start === undefined || row.end === undefined || row.origin === 'repo') continue
      const focused = row.id === card.focus
      out.push({ start: row.start, end: row.end, style: { underline: true, ...(row.chosen ? { color: 'success' } : focused ? { bg: P.focus } : { dim: true }) } })
    }
    return out
  }

  function styledText(start: number, end: number, styles: { start: number; end: number; style: Style }[]): string {
    let out = ''
    let at = start
    const text = draft.text
    while (at < end) {
      const active = styles.filter((s) => s.start <= at && at < s.end)
      const nextEdge = Math.min(end, ...styles.flatMap((s) => [s.start, s.end]).filter((edge) => edge > at))
      const piece = text.slice(at, nextEdge).replace(/\n/g, '')
      const style = active.reduce<Style>((acc, s) => ({ ...acc, ...s.style }), {})
      const open = sgr(style)
      out += open ? `${open}${piece}\x1b[0m` : piece
      at = nextEdge
    }
    return out
  }

  // ---- the terminal --------------------------------------------------------------------

  function enter(): void {
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[>1u\x1b[H\x1b[2J')
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
  }

  function restore(): void {
    if (spinner) clearInterval(spinner)
    spinner = null
    process.stdout.write('\x1b[<u\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l')
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
  }

  // ---- start ---------------------------------------------------------------------------

  enter()
  process.stdin.on('data', onKeys)
  process.stdout.on('resize', draw)
  process.on('SIGTERM', cancel)
  run(cardConfig(settings))
  run({ type: 'learned', picks: readLearned(cwd) })
  void model.start().then((name) => {
    modelName = name ? `readings by ${name}` : 'Codex unavailable'
    draw()
  })
  void collectVocabulary(processEngine, cwd).then((vocab) => run({ type: 'vocabulary', vocab })).catch(() => {})
  if (agent) {
    draft.replace(0, draft.text.length, '')
    agent.text = ''
  } else if (draft.text.trim()) run({ type: 'draft', now: now(), text: draft.text, origin: 'open', cursor: draft.cursor })
  draw()
}

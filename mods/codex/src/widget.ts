import { sameSelection, toggleSelection } from '../../claude-code/core/card'
import type { ParsedSketch } from '../../claude-code/core/card'
import { connectWidget } from './widget-bridge'
import { composeFollowUp } from './widget-message'
import type { CardOutput, FollowUp, Selections, WidgetRow } from './widget-message'

// The card reads as the plan itself: each choice Codex would make is a marked phrase in a sentence, and a
// click opens its options right under it. It opens as soon as Codex calls the tool and fills in as the
// reading streams, then the preview follows whatever is chosen.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const root = byId('card')
const reading = byId('reading')
const editor = byId('editor')
const plan = byId('plan')
const preview = byId('preview')
const previewTitle = byId('preview-title')
const drawing = byId('drawing')
const form = byId<HTMLFormElement>('actions')
const note = byId<HTMLInputElement>('note')
const readButton = byId<HTMLButtonElement>('read')
const goButton = byId<HTMLButtonElement>('go')
const asWritten = byId<HTMLButtonElement>('as-written')
const errorMessage = byId('send-error')
const summary = byId('summary')
const menu = byId('menu')

let card: CardOutput | undefined
const picks: Selections = {}
let sending = false
let sent = false
let startingRead = false
let following = false
let timer: number | undefined
let previewVersion = 0
/** The preview with Codex's own choices, kept so undoing every pick shows it again at once. */
let firstSketch: ParsedSketch | null = null
let shownKey: string | null = null
/** The preview on screen, sent as the target when it was drawn for the choices being sent. */
let shownSketch: ParsedSketch | null = null
let open: { row: WidgetRow; anchor: HTMLElement } | null = null

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const selected = (row: WidgetRow) => picks[row.id] ?? row.assumed
const missingFor = (row: WidgetRow) => card?.missing.find((missing) => missing.rowId === row.id)
const stillReading = () => card?.state === 'reading'
const picksKey = () => JSON.stringify(Object.keys(picks).sort().map((id) => [id, picks[id]]))

function listText(items: string[]): string {
  if (!items.length) return 'none'
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function valueOf(row: WidgetRow): string {
  if (row.type === 'many') return listText(selected(row).map((i) => row.options[i]!).filter(Boolean))
  return row.options[selected(row)[0] ?? -1] ?? ''
}

// ---- the plan ------------------------------------------------------------------------

function mark(row: WidgetRow, text: string, unknown = false): HTMLButtonElement {
  const yours = picks[row.id] !== undefined
  const button = element('button', `mark${yours ? ' yours' : ''}${unknown ? ' unknown' : ''}`, text)
  button.type = 'button'
  button.dataset.row = row.id
  button.title = unknown ? text : yours ? 'Your choice. Click to change it.' : row.openOnSend ? 'Left to agent unless you pick.' : 'Codex would choose this. Click to change it.'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', String(open?.row.id === row.id))
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (open?.row.id === row.id) closeMenu()
    else openMenu(row, button)
  })
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return
    event.preventDefault()
    openMenu(row, button)
  })
  return button
}

function sentence(parts: (string | Node)[], key: string): HTMLElement {
  const span = element('span', 'sentence')
  span.dataset.key = key
  span.append(...parts.map((part) => typeof part === 'string' ? document.createTextNode(part) : part))
  return span
}

function renderPlan(): void {
  if (!card) return
  const seen = new Set(Array.from(plan.querySelectorAll<HTMLElement>('.sentence')).map((node) => node.dataset.key))
  const sentences: HTMLElement[] = []
  for (const missing of card.missing) {
    if (missing.rowId) continue
    const near = missing.candidates.map((candidate) => candidate.name)
    sentences.push(sentence([element('span', 'name', `“${missing.phrase}”`),
      near.length ? ` isn’t in your code (closest: ${listText(near)}).` : ' isn’t in your code.'], `name:${missing.phrase}`))
  }
  for (const row of card.rows) {
    const missing = missingFor(row)
    if (missing) {
      const name = `“${missing.phrase}”`
      sentences.push(picks[row.id] === undefined
        ? sentence([`${name} isn’t in your code: `, mark(row, 'pick a match', true), '.'], row.id)
        : sentence([`For ${name}, use `, mark(row, valueOf(row)), '.'], row.id))
      continue
    }
    if (row.type === 'one' && !selected(row).length) {
      sentences.push(sentence([`? ${row.label} `, mark(row, 'pick a file', true)], row.id))
      continue
    }
    const at = row.statement.indexOf('{}')
    const before = at < 0 ? `${row.statement} ` : row.statement.slice(0, at)
    const after = (at < 0 ? '' : row.statement.slice(at + 2)).replace(/[\s.:;]+$/, '')
    const parts: (string | Node)[] = [before.charAt(0).toUpperCase() + before.slice(1), mark(row, valueOf(row)), `${after}.`]
    if (row.openOnSend && picks[row.id] === undefined) parts.push(element('small', 'row-note', ' · left to agent'))
    sentences.push(sentence(parts, row.id))
  }
  if (!sentences.length && !stillReading() && card.state !== 'waiting') {
    const words = card.reading ? 'Nothing is left open: Codex can start as you wrote it.' : 'MarginCue could not read this prompt in time. Codex can still go ahead with it as written.'
    sentences.push(sentence([words], 'empty'))
  }
  for (const node of sentences) if (seen.size && !seen.has(node.dataset.key)) node.classList.add('arriving')
  const parts: Node[] = sentences.flatMap((node, i) => i ? [document.createTextNode(' '), node] : [node])
  if (stillReading()) parts.push(element('span', 'pending'))
  plan.replaceChildren(...parts)
  if (open) {
    const anchor = plan.querySelector<HTMLElement>(`[data-row="${CSS.escape(open.row.id)}"]`)
    if (anchor) {
      open.anchor = anchor
      anchor.setAttribute('aria-expanded', 'true')
    }
  }
  updateActions()
}

function updateActions(): void {
  readButton.hidden = card?.state !== 'waiting'
  readButton.disabled = startingRead || sending || sent
  const send = card?.send ?? 'all'
  goButton.title = send === 'open' ? 'Send your decisions and let Codex answer the open choices.'
    : send === 'picked' ? 'Send your picks, saved choices, and written step order.'
    : 'Send the shown decisions, your note, and the preview. Codex settles open questions.'
  asWritten.title = 'Codex starts with your prompt alone: it makes these choices itself.'
}

// ---- the menu under a mark -----------------------------------------------------------

function openMenu(row: WidgetRow, anchor: HTMLElement): void {
  if (sending || sent) return
  open?.anchor.setAttribute('aria-expanded', 'false')
  open = { row, anchor }
  anchor.setAttribute('aria-expanded', 'true')
  renderMenu()
  menu.hidden = false
  place()
  activate(menu.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu.querySelector<HTMLElement>('[role="option"]'))
  menu.focus({ preventScroll: true })
}

function renderMenu(): void {
  if (!open) return
  const { row } = open
  const items: HTMLElement[] = []
  const many = row.type === 'many'
  menu.setAttribute('aria-multiselectable', String(many))
  menu.setAttribute('aria-label', row.label)
  const shown = picks[row.id] !== undefined || !missingFor(row)
  row.options.forEach((option, index) => {
    const on = shown && selected(row).includes(index)
    const item = element('div', 'option')
    item.id = `option-${row.id}-${index}`
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(on))
    item.append(element('span', 'tick', on ? '✓' : ''), element('span', 'text', option))
    const assumed = !missingFor(row) && row.assumed.includes(index)
    const file = row.files?.[index]
    if (file || assumed) item.append(element('span', 'hint', file ?? (many ? 'Codex would include this' : 'Codex would choose this')))
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      choose(index)
    })
    items.push(item)
  })
  if (picks[row.id] !== undefined) {
    const reset = element('div', 'option reset')
    reset.id = `option-${row.id}-reset`
    reset.setAttribute('role', 'option')
    reset.append(element('span', 'tick', ''), element('span', 'text', missingFor(row) ? 'Leave it to Codex' : 'Let Codex decide'))
    reset.addEventListener('click', (event) => {
      event.stopPropagation()
      choose(-1)
    })
    items.push(element('div', 'divider'), reset)
  }
  if (many) items.push(element('div', 'menu-note', 'Pick any, then click outside.'))
  menu.replaceChildren(...items)
}

function choose(index: number): void {
  if (!open) return
  const { row } = open
  const assumedBinds = (card?.send ?? 'all') === 'all' && !row.openOnSend
  if (index < 0) delete picks[row.id]
  else if (row.type === 'many') {
    const next = toggleSelection(row, selected(row), index)
    if (assumedBinds && sameSelection(next, row.assumed)) delete picks[row.id]
    else picks[row.id] = next
  } else if (assumedBinds && !missingFor(row) && sameSelection([index], row.assumed)) delete picks[row.id]
  else picks[row.id] = [index]
  renderPlan()
  const anchor = plan.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.id)}"]`)
  if (row.type === 'many' && index >= 0 && anchor) {
    // A pick-any choice keeps its menu open: one visit for all of it.
    const active = menu.querySelector('.active')?.id
    open = { row, anchor }
    renderMenu()
    place()
    activate(active ? menu.querySelector<HTMLElement>(`#${CSS.escape(active)}`) : null)
  } else {
    closeMenu()
    if (anchor) {
      anchor.classList.add('changed')
      anchor.focus({ preventScroll: true })
    }
  }
  schedulePreview(350)
}

function activate(item: HTMLElement | null): void {
  menu.querySelectorAll('.active').forEach((other) => other.classList.remove('active'))
  if (!item) return
  item.classList.add('active')
  menu.setAttribute('aria-activedescendant', item.id)
  item.scrollIntoView({ block: 'nearest' })
}

function closeMenu(): void {
  if (!open) return
  open.anchor.setAttribute('aria-expanded', 'false')
  open = null
  menu.hidden = true
  fit()
}

function place(): void {
  if (!open) return
  const frame = root.getBoundingClientRect()
  const at = open.anchor.getBoundingClientRect()
  const left = Math.max(12, Math.min(at.left - frame.left - 8, frame.width - menu.offsetWidth - 12))
  menu.style.left = `${left}px`
  menu.style.top = `${at.bottom - frame.top + 6}px`
  fit()
}

/** The host sizes the frame to the card, and to an open menu that reaches past it. */
function fit(): void {
  const frame = root.getBoundingClientRect()
  const bottom = menu.hidden ? frame.height : Math.max(frame.height, menu.offsetTop + menu.offsetHeight + 12)
  bridge.resize(Math.ceil(frame.width), Math.ceil(bottom))
}

menu.tabIndex = -1
menu.addEventListener('keydown', (event) => {
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'))
  const at = items.findIndex((item) => item.classList.contains('active'))
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    activate(items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length] ?? null)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    items[at]?.click()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    const anchor = open?.anchor
    closeMenu()
    anchor?.focus({ preventScroll: true })
  } else if (event.key === 'Tab') closeMenu()
})
document.addEventListener('click', () => closeMenu())
window.addEventListener('resize', place)

// ---- the preview ---------------------------------------------------------------------

/** The drawing as text, with its box lines quieter than its words and its [buttons] set apart. */
function drawLines(lines: string[]): Node[] {
  const nodes: Node[] = []
  for (const [i, line] of lines.entries()) {
    if (i) nodes.push(document.createTextNode('\n'))
    let last = 0
    for (const match of line.matchAll(/[─-╿]+|\[[^\]\n]{1,40}\]/g)) {
      if (match.index! > last) nodes.push(document.createTextNode(line.slice(last, match.index)))
      const text = match[0]
      nodes.push(element('span', text.startsWith('[') ? 'control' : 'rule', text))
      last = match.index! + text.length
    }
    if (last < line.length) nodes.push(document.createTextNode(line.slice(last)))
  }
  return nodes
}

function showSketch(sketch: ParsedSketch | null, key: string): void {
  shownKey = key
  shownSketch = sketch?.lines.length ? sketch : null
  preview.classList.remove('stale', 'drawing-first')
  if (!sketch?.lines.length) {
    preview.hidden = true
    fit()
    return
  }
  preview.hidden = false
  previewTitle.textContent = sketch.title ? `Preview: ${sketch.title}` : 'Preview'
  drawing.replaceChildren(...drawLines(sketch.lines))
  fit()
}

function showDrawing(): void {
  preview.hidden = false
  preview.classList.add('drawing-first')
  previewTitle.textContent = 'Drawing a preview…'
  drawing.replaceChildren(...[78, 92, 64, 85].map((width) => {
    const bar = element('span', 'skeleton')
    bar.style.width = `${width}%`
    return bar
  }))
}

function schedulePreview(delay: number): void {
  if (!card?.preview || sending || sent || stillReading()) return
  window.clearTimeout(timer)
  const version = ++previewVersion
  const key = picksKey()
  if (key === '[]' && firstSketch) return showSketch(firstSketch, key)
  if (key === shownKey) {
    preview.classList.remove('stale')
    return
  }
  if (card.sketchState === 'drawing' && key === '[]') return
  if (!preview.hidden && !preview.classList.contains('drawing-first')) preview.classList.add('stale')
  const cardId = card.id
  timer = window.setTimeout(async () => {
    try {
      const result = await bridge.sketch({ cardId, picks: { ...picks } }) as { isError?: boolean; structuredContent?: { sketch: ParsedSketch | null } }
      if (version !== previewVersion) return
      if (result?.isError || !result?.structuredContent) throw new Error()
      if (key === '[]') firstSketch = result.structuredContent.sketch
      showSketch(result.structuredContent.sketch, key)
    } catch {
      if (version === previewVersion) preview.classList.remove('stale')
    }
  }, delay)
}

// ---- the card arriving, following its reading, and sending -----------------------------

/** Takes in a newer state of the card; picks made already are kept where their choice still exists. */
function accept(next: CardOutput): void {
  if (sent) return
  const before = card
  if (before && (next.version ?? 0) < (before.version ?? 0)) return
  card = next
  for (const id of Object.keys(picks)) {
    const row = next.rows.find((row) => row.id === id)
    if (!row || picks[id]!.some((i) => i >= row.options.length)) delete picks[id]
  }
  root.classList.toggle('is-reading', stillReading())
  reading.hidden = next.state === 'waiting'
  reading.textContent = next.reading ?? ''
  reading.classList.toggle('skeleton-line', !next.reading && stillReading())
  editor.hidden = false
  renderPlan()
  if (!next.preview) {
    if (!stillReading()) preview.hidden = true
  } else if (next.sketchState === 'done') {
    firstSketch = next.sketch
    if (picksKey() === '[]' && shownKey !== '[]') showSketch(next.sketch, '[]')
  } else if (next.sketchState === 'drawing' && preview.hidden) showDrawing()
  else if (next.sketchState === 'failed' && picksKey() === '[]' && shownKey === null) preview.hidden = true
  if (before?.state === 'reading' && next.state !== 'reading' && picksKey() !== '[]') schedulePreview(0)
  fit()
}

async function follow(): Promise<void> {
  if (following) return
  following = true
  let misses = 0
  while (card && !sent && (card.state === 'reading' || card.sketchState === 'drawing')) {
    try {
      const result = await bridge.read({ card: card.id, after: card.version ?? 0 }) as { isError?: boolean; structuredContent?: CardOutput }
      if (result?.isError || !result?.structuredContent) throw new Error()
      misses = 0
      accept(result.structuredContent)
    } catch {
      if (++misses >= 3) {
        if (card.state === 'reading') accept({ ...card, state: 'failed', version: (card.version ?? 0) + 1 })
        if (card.sketchState === 'drawing') accept({ ...card, sketchState: 'failed', version: (card.version ?? 0) + 1 })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * misses))
    }
  }
  following = false
}

async function startReading(): Promise<void> {
  if (!card || card.state !== 'waiting' || startingRead || sending || sent) return
  startingRead = true
  errorMessage.hidden = true
  updateActions()
  try {
    const result = await bridge.read({ card: card.id, start: true }) as { isError?: boolean; structuredContent?: CardOutput }
    if (result?.isError || !result?.structuredContent) throw new Error()
    accept(result.structuredContent)
    void follow()
  } catch {
    if (!sent) {
      errorMessage.textContent = 'Could not read this prompt. Try again or continue as written.'
      errorMessage.hidden = false
    }
  } finally {
    startingRead = false
    updateActions()
  }
}

function showOutput(output: unknown): void {
  if (!output || typeof output !== 'object') return
  if ('isError' in output && output.isError && !card) {
    reading.classList.remove('skeleton-line')
    reading.textContent = 'MarginCue could not open this card. Codex will go ahead with your prompt as written.'
    return
  }
  const data = ('structuredContent' in output ? output.structuredContent : output) as CardOutput | undefined | null
  if (typeof data?.id !== 'string' || typeof data.prompt !== 'string' || !Array.isArray(data.rows)) return
  if (card && card.id !== data.id) return
  const saved = bridge.state() as { cardId?: string; followUp?: FollowUp } | undefined
  if (saved?.cardId === data.id && saved.followUp) {
    card = data
    reading.textContent = data.reading ?? ''
    reading.classList.remove('skeleton-line')
    return showSummary(saved.followUp)
  }
  accept(data)
  void follow()
}

function showSummary(message: FollowUp): void {
  sent = true
  closeMenu()
  root.classList.remove('is-reading')
  editor.hidden = true
  const head = message.decisions.length || message.openChoices?.length || message.extra || message.text.includes('Target output')
    ? 'Codex is going ahead with this plan.' : 'Codex is going ahead with your prompt as written.'
  summary.replaceChildren(element('p', 'summary-head', head))
  if (message.decisions.length) {
    const list = element('ul')
    for (const decision of message.decisions) list.append(element('li', undefined, decision))
    summary.append(list)
  }
  if (message.openChoices?.length) {
    const list = element('ul')
    for (const question of message.openChoices) list.append(element('li', undefined, question))
    summary.append(element('p', 'summary-note', 'Codex will decide'), list)
  }
  if (message.extra) summary.append(element('p', 'summary-note', `Your note: ${message.extra}`))
  summary.hidden = false
  fit()
}

async function send(asWrittenOnly: boolean): Promise<void> {
  if (sending || sent) return
  // Going ahead before the card has arrived is going ahead as written, with the note if there is one.
  // The preview goes as the target only when it shows these very choices, not while it is redrawn for them.
  const target = shownKey === picksKey() && !preview.hidden && !preview.classList.contains('stale') ? shownSketch : null
  const message = composeFollowUp(card?.rows ?? [], picks, note.value, asWrittenOnly, target, card?.send, card?.fileReferences)
  sending = true
  closeMenu()
  goButton.disabled = asWritten.disabled = note.disabled = true
  updateActions()
  errorMessage.hidden = true
  try {
    await bridge.send(message.text)
    window.clearTimeout(timer)
    previewVersion++
    showSummary(message)
    summary.focus({ preventScroll: true })
    if (card) bridge.saveState({ cardId: card.id, followUp: message })
  } catch (error) {
    errorMessage.textContent = error instanceof Error && error.message ? error.message : 'Could not send. Try again, or reply in the thread.'
    errorMessage.hidden = false
  } finally {
    sending = false
    goButton.disabled = asWritten.disabled = note.disabled = false
    updateActions()
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void send(false)
})
asWritten.addEventListener('click', () => void send(true))
readButton.addEventListener('click', () => void startReading())
const bridge = connectWidget(showOutput)
new ResizeObserver(() => fit()).observe(root)

// The card: how the agent will read a draft, and the choices it leaves open,
// each with a control shaped like its value. Pure helpers: the wire format of
// the card and sketch replies, row values and the blanks an agent writes.

import { normalize } from './parse'

export type RowType = 'one' | 'many' | 'range'
export const CARD_KINDS = ['build', 'change', 'fix', 'explore', 'ask', 'other'] as const
export type CardKind = typeof CARD_KINDS[number]

/** A row as a reply states it. `range` rows made from numbers carry their unit. */
export type ParsedRow = {
  key: string
  label: string
  type: RowType
  statement: string
  options: string[]
  defaults: number[]
  unit?: string
  anchor?: string
}

export type ParsedCard = { read: string | null; kind: CardKind | null; rows: ParsedRow[] }

export const CARD_MAX_ROWS = 6
export const CARD_MAX_TOKENS = 560
export const SKETCH_MAX_TOKENS = 420
export const MAX_LABEL = 16
/** Longest option kept: options travel with the prompt as written, so they are never cut, only left out. */
export const MAX_OPTION = 80
export const MAX_STATEMENT = 120
export const MAX_READ = 400
/** Lines kept of a sketch. The prompt asks for ten; models often draw a few more, and the band folds what it has no room for. */
export const SKETCH_MAX_LINES = 14
export const SKETCH_MAX_WIDTH = 78

/** Open and close marks of a blank in an agent's reply (U+27E6, U+27E7). */
export const BLANK_OPEN = '⟦'
export const BLANK_CLOSE = '⟧'

const TYPES: Record<string, RowType | 'num'> = {
  one: 'one', choice: 'one', pick: 'one', bool: 'one',
  many: 'many', multi: 'many', any: 'many',
  range: 'range', slider: 'range', scale: 'range',
  num: 'num', number: 'num',
}

const QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g
const clean = (text: string) => text.replace(/\s+/g, ' ').replace(QUOTES, '').trim()

/** One card reply, read line by line; a malformed line is skipped, never fatal. */
export function parseCard(reply: string): ParsedCard {
  let read: string | null = null
  let kind: CardKind | null = null
  const rows: ParsedRow[] = []
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s+/, '')
    if (!line || line.startsWith('```')) continue
    const fields = line.split('|').map((field) => field.trim())
    const head = fields[0]?.toLowerCase()
    if (head === 'read' && read === null) {
      const text = clean(fields.slice(1).join(' | '))
      if (text) read = cut(text, MAX_READ)
    } else if (head === 'kind' && kind === null) {
      const value = fields[1]?.toLowerCase() as CardKind | undefined
      if (value && (CARD_KINDS as readonly string[]).includes(value)) kind = value
    } else if (head === 'row' && rows.length < CARD_MAX_ROWS) {
      const row = parseRow(fields.slice(1))
      if (row && !rows.some((other) => other.key === row.key || normalize(other.statement) === normalize(row.statement))) {
        rows.push(row)
      }
    }
  }
  return { read, kind, rows }
}

function parseRow(fields: string[]): ParsedRow | null {
  let rest = [...fields]
  let anchor: string | undefined
  const last = rest.at(-1)
  if (last?.startsWith('@')) {
    anchor = clean(last.slice(1)) || undefined
    rest = rest.slice(0, -1)
  } else if (last && rest.length > 5) {
    // "option @phrase": the anchor written into the last option instead of a field of its own.
    const glued = /^(.*?\S)\s+@(\S.*)$/.exec(last)
    if (glued) {
      anchor = clean(glued[2]!) || undefined
      rest = [...rest.slice(0, -1), glued[1]!]
    }
  }
  const [rawKey, rawLabel, rawType, rawStatement, ...values] = rest
  const key = (rawKey ?? '').toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) return null
  const label = clean(rawLabel ?? '').toLowerCase()
  if (!label || label.length > MAX_LABEL * 2) return null
  const type = TYPES[(rawType ?? '').toLowerCase()]
  if (!type) return null
  let statement = clean(rawStatement ?? '')
  if (!statement || statement.length > MAX_STATEMENT) return null
  const holes = statement.split('{}').length - 1
  if (holes > 1) return null
  if (holes === 0) statement = `${statement.replace(/[:.]$/, '')}: {}`
  const base = { key, label, statement, ...(anchor && { anchor }) }

  if (type === 'num') {
    const [value, min, max] = values.slice(0, 3).map((v) => Number.parseFloat(v ?? ''))
    const unit = clean(values[3] ?? '').slice(0, 8)
    if (![value, min, max].every((n) => Number.isFinite(n))) return null
    const steps = numberSteps(value!, min!, max!)
    if (steps.length < 2) return null
    return {
      ...base, type: 'range', options: steps.map((step) => formatNumber(step, unit)),
      defaults: [Math.max(0, steps.indexOf(clamp(value!, min!, max!)))], ...(unit && { unit }),
    }
  }

  const starred: number[] = []
  const options: string[] = []
  for (const value of values) {
    // The default mark comes after the option as asked, or before it as models sometimes write it.
    const star = /^\s*\*|\*\s*$/.test(value)
    const option = clean(value.replace(/^\s*\*\s*|\s*\*\s*$/g, ''))
    // Cutting is the layout's job: text that travels with the prompt is whole or left out,
    // and an option the model cut short itself ("running live in Claude Code and…") is left out too.
    if (!option || option.length > MAX_OPTION || /(?:…|\.\.\.)$/.test(option)) continue
    if (options.some((other) => normalize(other) === normalize(option))) continue
    if (star) starred.push(options.length)
    options.push(option)
  }
  const most = type === 'one' ? 5 : 7
  if (options.length < 2 || options.length > most) return null
  const defaults = type === 'many'
    ? (starred.length ? starred : options.map((_, i) => i))
    : [starred[0] ?? 0]
  return { ...base, type, options, defaults }
}

/** About nine steps between min and max, rounded to readable values, the default among them. */
export function numberSteps(value: number, min: number, max: number): number[] {
  if (!(min < max)) return []
  const n = 9
  const geometric = min > 0 && max / min >= 20
  const raw = Array.from({ length: n }, (_, i) => geometric
    ? min * (max / min) ** (i / (n - 1))
    : min + ((max - min) * i) / (n - 1))
  // Whole numbers in, whole numbers out: a range of 0 to 10 has no step at 1.3.
  const whole = [value, min, max].every(Number.isInteger)
  const steps = [...raw.map(nice).map((step) => whole ? Math.round(step) : step), clamp(value, min, max)]
  return [...new Set(steps.map((step) => Number(step.toPrecision(6))))].sort((a, b) => a - b)
}

/** Two significant figures above a hundred, multiples of five below, whole numbers below twenty. */
function nice(x: number): number {
  const ax = Math.abs(x)
  if (ax < 0.2) return Math.round(x * 100) / 100
  if (ax < 2) return Math.round(x * 10) / 10
  if (ax < 20) return Math.round(x)
  if (ax < 100) return Math.round(x / 5) * 5
  const unit = 10 ** (Math.floor(Math.log10(ax)) - 1)
  return Math.round(x / unit) * unit
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function formatNumber(value: number, unit: string): string {
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
  if (!unit) return text
  return /^[%°×x]$/.test(unit) ? `${text}${unit}` : `${text} ${unit}`
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const room = text.slice(0, max - 1)
  const space = room.lastIndexOf(' ')
  return `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  // Items that are lists themselves ("name, email, message", "company and role") are kept apart with semicolons.
  if (items.some((item) => /,|\band\b/.test(item))) return items.join('; ')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** What a row reads with a selection: one option, or the selected options of a pick-any row. */
export function rowValue(row: Pick<ParsedRow, 'type' | 'options'>, selected: number[]): string {
  const labels = [...selected].filter((i) => row.options[i] !== undefined).sort((a, b) => a - b).map((i) => row.options[i]!)
  if (row.type === 'many') return labels.length ? joinList(labels) : 'none of these'
  return labels[0] ?? row.options[0] ?? ''
}

export function sameSelection(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort((p, q) => p - q)
  const y = [...b].sort((p, q) => p - q)
  return x.every((v, i) => v === y[i])
}

/** The next selection alt+down gives a row: the next option (cyclic); pick-any rows go defaults, all, first only. */
export function cycleSelection(row: Pick<ParsedRow, 'type' | 'options' | 'defaults'>, selected: number[], dir: 1 | -1 = 1): number[] {
  const n = row.options.length
  if (row.type !== 'many') {
    // Nothing selected yet (a row that asks rather than assumes): the first press lands on an end.
    if (selected[0] === undefined) return [dir === 1 ? 0 : n - 1]
    return [((selected[0] + dir) % n + n) % n]
  }
  const all = row.options.map((_, i) => i)
  const defaults = [...row.defaults].sort((a, b) => a - b)
  const states = sameSelection(defaults, all) ? [all, [0]] : [defaults, all, [defaults[0] ?? 0]]
  const at = states.findIndex((state) => sameSelection(selected, state))
  return states[((at === -1 ? 0 : at + dir) % states.length + states.length) % states.length]!
}

/** A pick-any row with option `i` switched; a one-of row with `i` selected. */
export function toggleSelection(row: Pick<ParsedRow, 'type'>, selected: number[], i: number): number[] {
  if (row.type !== 'many') return [i]
  return selected.includes(i) ? selected.filter((j) => j !== i) : [...selected, i].sort((a, b) => a - b)
}

// ---- sketch -----------------------------------------------------------------

export type ParsedSketch = { title: string; lines: string[] }

/** A sketch reply: `title | ...` then up to ten lines of plain text; NONE for nothing to show. */
export function parseSketch(reply: string): ParsedSketch | null {
  const lines = reply.replace(/\t/g, '  ').split(/\r?\n/).filter((line) => !/^\s*```/.test(line))
  while (lines.length && !lines[0]!.trim()) lines.shift()
  if (!lines.length || /^\s*NONE\s*$/i.test(lines[0]!)) return null
  let title = 'Sketch'
  // `title | ...`, as asked; or a title before a bar with the first line of the sketch after it.
  const asked = /^\s*title\s*[|:]\s*(.+)$/i.exec(lines[0]!)
  const barred = asked ? null : /^\s*([^|]{1,60}?)\s*\|\s*(.*)$/.exec(lines[0]!)
  if (asked) {
    title = cut(clean(asked[1]!), 80)
    lines.shift()
  } else if (barred) {
    title = cut(clean(barred[1]!), 80)
    lines.shift()
    if (barred[2]!.trim()) lines.unshift(barred[2]!)
  }
  const body = lines.map((line) => line.replace(/\s+$/, ''))
    .map((line) => line.length > SKETCH_MAX_WIDTH ? `${line.slice(0, SKETCH_MAX_WIDTH - 1)}…` : line)
  while (body.length && !body.at(-1)!.trim()) body.pop()
  while (body.length && !body[0]!.trim()) body.shift()
  // Past the limit, a drawing keeps its last line when that line closes its frame: a frame is never left open.
  const kept = body.length > SKETCH_MAX_LINES && /^\s*[└╰┗╚]/.test(body.at(-1)!)
    ? [...body.slice(0, SKETCH_MAX_LINES - 1), body.at(-1)!]
    : body.slice(0, SKETCH_MAX_LINES)
  if (!kept.some((line) => line.trim())) return null
  // A common left margin is the model's indentation, not the sketch's.
  const margin = Math.min(...kept.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length))
  return { title, lines: kept.map((line) => line.slice(margin)) }
}

// ---- blanks -------------------------------------------------------------------

/** A choice the agent marked in its reply: [[label: choice | alternative | alternative]] in white brackets. */
export type ParsedBlank = { label: string; choice: string; alternatives: string[]; start: number; end: number }

const BLANK = new RegExp(`${BLANK_OPEN}([^${BLANK_OPEN}${BLANK_CLOSE}\\n]{1,280})${BLANK_CLOSE}`, 'g')

/** Code the agent writes (fenced or inline) is never read for blanks. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  for (const m of text.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm)) ranges.push([m.index!, m.index! + m[0].length])
  for (const m of text.matchAll(/`[^`\n]+`/g)) ranges.push([m.index!, m.index! + m[0].length])
  return ranges
}

export function parseBlanks(text: string): ParsedBlank[] {
  if (!text.includes(BLANK_OPEN)) return []
  const code = codeRanges(text)
  const out: ParsedBlank[] = []
  for (const m of text.matchAll(BLANK)) {
    const start = m.index!
    if (code.some(([a, b]) => start >= a && start < b)) continue
    const inner = m[1]!
    const colon = inner.indexOf(':')
    if (colon < 1) continue
    const label = clean(inner.slice(0, colon))
    const parts = inner.slice(colon + 1).split('|').map(clean).filter(Boolean)
    const [choice, ...alternatives] = parts
    if (!label || label.length > 32 || !choice || choice.length > 60 || !alternatives.length) continue
    // The protocol's own example, quoted back, is not a choice.
    if (label.toLowerCase() === 'label' && choice.toLowerCase() === 'your choice') continue
    const alts = alternatives.filter((alt, i) => alt.length <= 60 && normalize(alt) !== normalize(choice) &&
      alternatives.findIndex((other) => normalize(other) === normalize(alt)) === i).slice(0, 4)
    if (!alts.length) continue
    out.push({ label: label.toLowerCase(), choice, alternatives: alts, start, end: start + m[0].length })
  }
  return out
}

/**
 * The reply as drawn: each blank becomes its choice in bold, or, once the
 * person switched it, the new value in bold followed by the old one.
 */
export function renderBlanks(text: string, current: (blank: ParsedBlank) => string | undefined = () => undefined): string {
  const blanks = parseBlanks(text)
  if (!blanks.length) return text
  let out = ''
  let at = 0
  for (const blank of blanks) {
    const now = current(blank)
    out += text.slice(at, blank.start)
    out += now && normalize(now) !== normalize(blank.choice) ? `**${now}** (was ${blank.choice})` : `**${blank.choice}**`
    at = blank.end
  }
  return out + text.slice(at)
}

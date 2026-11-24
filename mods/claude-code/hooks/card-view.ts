// The card above the prompt, laid out on terminal cells.
//
//   ▸ marker · labels right-aligned in a column · two spaces · content
//
//    MarginCue   You want a CSV export of the dashboard data, built as a       2 set · 1 open
//                separate tool.
//      in code   ✓ Dashboard   ? Old Market
//         rows    the filtered rows    all rows    the selected rows
//   ▸   runs in   in the browser   from the terminal     alt↓ change · alt↑ next row
//        batch   100 ━━━━━●──────── 5000    500 rows
//      preview   Export dialog   attach to prompt
//                ┌ Export ───────────┐
//
// The selected value of each row is a chip: neutral while it is only what the
// agent would do, green once the person set it, blue for a choice the agent
// made during the turn. Options are never cut while there is room: a row wraps
// onto a second line (the focused row onto four), and only past that do the
// options that do not fit become "+N". On a wide terminal the sketch stands in
// a column of its own beside the rows, so it is never cut in the middle of its
// frame; where rows run short, it keeps its first lines and its last one.

import { joinList, sameSelection } from '../core/card'
import { splitDecisions } from '../core/decisions'
import type { MargincueCard, MargincueReceipt, MargincueRow } from '../types'
import { CHORD_NEXT, CHORD_SWAP, DARK, cells, segmentsWidth, text, truncate, wrapLines } from './segments'
import type { Color, Palette, Segment, Style } from './segments'

export type CardOptions = { chords: boolean; extra: Segment[]; palette?: Palette }

type Line = Segment[]

export const TAG = ' MarginCue '
const GAP = '  '
/** The focus marker's cells, left of the labels. */
const MARK = 2
/** Below this many columns of content beside it, the sketch goes under the rows. */
const MIN_ROWS_BESIDE = 52
const MIN_COLUMNS_BESIDE = 140

/** Columns: the marker, the right-aligned label column, two spaces, then the content. A chip starts one cell early, so its text lines up with the reading. */
type Grid = { label: number; content: number; columns: number }

type Words = {
  inCode: string; preview: string; reading: string; noReading: string; drawing: string; attach: string; attached: string
  change: string; nextRow: string; set: string; open: string; was: string; more: (n: number) => string
  turn: (n: number) => [string, string]; after: (n: number) => [string, string]; lines: (n: number) => string
  folded: (n: number) => string
}

const EN: Words = {
  inCode: 'in code', preview: 'preview', reading: 'reading your draft…', noReading: 'no reading this time',
  drawing: 'drawing…', attach: 'attach to prompt', attached: '✓ goes with the prompt',
  change: 'change', nextRow: 'next row', set: 'set', open: 'open', was: 'was',
  more: (n) => `+${n} more row${n === 1 ? '' : 's'} · alt↑`,
  turn: (n) => [`The agent made ${n} choice${n === 1 ? '' : 's'} for you.`, 'Switch one: it adapts at its next step.'],
  after: (n) => [`The agent made ${n} choice${n === 1 ? '' : 's'}.`, 'Switching one writes the follow-up prompt.'],
  lines: (n) => `${n} more line${n === 1 ? '' : 's'}`,
  folded: (n) => `${n} line${n === 1 ? '' : 's'}, folded`,
}

const FR: Words = {
  inCode: 'dans le code', preview: 'aperçu', reading: 'lecture du brouillon…', noReading: 'pas de lecture cette fois',
  drawing: 'dessin…', attach: 'joindre au prompt', attached: '✓ joint au prompt',
  change: 'changer', nextRow: 'ligne suivante', set: 'choisis', open: 'en attente', was: 'avant',
  more: (n) => `+${n} ligne${n === 1 ? '' : 's'} · alt↑`,
  turn: (n) => [`L'agent a fait ${n} choix pour vous.`, 'Changez-en un : il en tient compte à son étape suivante.'],
  after: (n) => [`L'agent a fait ${n} choix.`, 'En changer un écrit la suite.'],
  lines: (n) => `${n} ligne${n === 1 ? '' : 's'} de plus`,
  folded: (n) => `${n} ligne${n === 1 ? '' : 's'}, repliées`,
}

/**
 * The card. Before Enter: the reading, the names found in the code, one row per
 * open choice with a control shaped like its value, and the sketch. alt+up
 * moves between rows and alt+down changes the value, both from the prompt;
 * after ctrl+x tab, digits pick, x drops a row, s and p work the sketch.
 * During the turn the rows are the agent's own choices; after it, switching
 * one writes the follow-up prompt.
 */
export function layoutCard(card: MargincueCard, columns: number, budget: number, options: CardOptions): Line[] {
  const P = options.palette ?? DARK
  const words = card.language === 'fr' ? FR : EN
  const hidden = hiddenButtons(card, options.chords)
  const open = card.rows.filter((row) => !row.chosen).length
  if (card.collapsed) return [collapsed(card, columns, P, words, open, hidden)]

  const g = grid(card, columns, words)
  const right = status(card, words, open, columns >= 110 && card.stage === 'draft' ? options.extra : [], P)
  // The reading is the card's point: on a narrow screen it takes a fourth line rather than lose its end.
  const head = header(card, g, right, P, words, budget >= 10 ? 4 : budget >= 6 ? 2 : 1)
  head[0]!.push(...hidden)
  const room = budget - head.length
  if (room <= 0) return head

  const sketch = card.stage === 'draft' ? card.sketch : undefined
  const drawing = sketch?.open ? tidySketch(sketch.lines) : []
  // The column is as wide as the drawing; a long title is cut to it, never the other way round.
  const pictureWidth = Math.min(80, Math.max(36, ...drawing.map(cells)))
  if (drawing.length && columns >= MIN_COLUMNS_BESIDE && columns - pictureWidth - 3 - g.content >= MIN_ROWS_BESIDE) {
    const left = columns - pictureWidth - 3
    const body = bodyLines(card, g, left, P, words, room)
    // Beside the drawing only while no row has to fold an option away for it.
    if (!body.some((line) => line.some((s) => s.kind === 'button' && s.key.startsWith('card-more-')))) {
      const picture = [captionLine(sketch!, P, words, pictureWidth, '', true), ...pictureLines(drawing, P, words, Math.max(1, room - 1))]
      const out: Line[] = [...head]
      for (let i = 0; i < Math.min(room, Math.max(body.length, picture.length)); i++) {
        const line = body[i] ?? []
        const fill = columns - pictureWidth - segmentsWidth(line)
        out.push(picture[i] ? [...line, text(' '.repeat(Math.max(0, fill))), ...picture[i]!] : line)
      }
      return out
    }
  }

  const body = bodyLines(card, g, columns, P, words, sketch ? Math.max(1, room - 1) : room)
  const out: Line[] = [...head, ...body]
  const left = room - body.length - 1
  if (sketch && left >= 0) {
    // Under the rows, in the content column; on a terminal too narrow for that, further left; narrower still, folded.
    const wide = Math.max(0, ...drawing.map(cells))
    const indent = g.content + wide <= columns ? g.content : wide + 2 <= columns ? columns - wide : -1
    const shown = drawing.length && indent >= 0 && left >= Math.min(3, drawing.length) ? pictureLines(drawing, P, words, left) : []
    const note = drawing.length && !shown.length ? words.folded(drawing.length) : ''
    out.push([...labelLead(words.preview, g, { dim: true }), ...captionLine(sketch, P, words, columns - g.content, note)])
    for (const line of shown) out.push([text(' '.repeat(indent)), ...line])
  }
  return out
}

function grid(card: MargincueCard, columns: number, words: Words): Grid {
  const widths = [
    ...card.rows.map((row) => cells(row.label) + (badge(row) ? 2 : 0)),
    card.mentions.length ? cells(words.inCode) : 0,
    card.sketch && card.stage === 'draft' ? cells(words.preview) : 0,
  ]
  // The column follows the longest label, up to about a quarter of the width; a longer label wraps, never cut.
  const cap = columns < 80 ? 14 : columns < 120 ? 20 : 26
  const label = Math.max(cells(TAG), Math.min(cap, Math.max(0, ...widths)))
  return { label, content: MARK + label + GAP.length, columns }
}

// ---- the head line: the tag, the reading, the counts --------------------------------

function header(card: MargincueCard, g: Grid, right: Line, P: Palette, words: Words, most: number): Line[] {
  const lead: Line = [text(' '.repeat(MARK + g.label - cells(TAG))), text(TAG, P.tag), text(GAP)]
  const room = g.columns - g.content
  const rightWidth = segmentsWidth(right)
  const first = Math.max(12, room - (rightWidth ? rightWidth + 3 : 0))
  const indent = text(' '.repeat(g.content))

  if (card.stage !== 'draft') {
    const [head, tail] = card.stage === 'turn' ? words.turn(card.rows.length) : words.after(card.rows.length)
    const whole = `${head} ${tail}`
    if (cells(whole) <= first) return [withRight([...lead, text(head, { bold: true }), text(` ${tail}`, { dim: true })], right, g.columns)]
    const top = withRight([...lead, text(truncate(head, first), { bold: true })], right, g.columns)
    return most > 1 ? [top, [indent, text(truncate(tail, room), { dim: true })]] : [top]
  }
  if (card.read) {
    const style: Style | undefined = card.reading ? { dim: true } : undefined
    const lines = wrapLines(card.read, first, room, most)
    const out = lines.map((line, i): Line => i === 0 ? [...lead, text(line, style)] : [indent, text(line, style)])
    out[0] = withRight(out[0]!, right, g.columns)
    return out
  }
  if (card.reading) return [withRight([...lead, { kind: 'progress', label: words.reading }], right, g.columns)]
  return [withRight([...lead, text(card.error ? words.noReading : '', { dim: true })], right, g.columns)]
}

/** The right end of the head line: a refresh mark, the counts, then the review and depth buttons. */
function status(card: MargincueCard, words: Words, open: number, extra: Segment[], P: Palette): Line {
  const parts: Line = []
  if (card.stage === 'draft' && card.reading && card.read) parts.push(text('⟳', { dim: true }))
  if (card.stage === 'draft' && card.rows.length) {
    const set = card.rows.length - open
    if (parts.length) parts.push(text(' '))
    if (set) parts.push(text(`${set} ${words.set}`, { color: P.yours.color!, bold: true }), text(' · ', { dim: true }))
    parts.push(text(`${open} ${words.open}`, { dim: true }))
  }
  for (const button of extra) parts.push(...(parts.length ? [text('  ')] : []), button)
  return parts
}

function withRight(left: Line, right: Line, columns: number): Line {
  if (!right.length) return left
  const gap = columns - segmentsWidth(left) - segmentsWidth(right)
  return gap >= 3 ? [...left, text(' '.repeat(gap)), ...right] : left
}

function collapsed(card: MargincueCard, columns: number, P: Palette, words: Words, open: number, hidden: Line): Line {
  const lead: Line = [text(' '), text(TAG, P.tag), text(GAP)]
  const tail = card.reading && !card.read ? words.reading : `${open} ${words.open}${card.rows.length ? ' · alt↑ alt↓' : ''}`
  const room = columns - segmentsWidth(lead) - cells(tail) - 3
  const read = card.read && room >= 12 ? truncate(card.read, room) : ''
  return [...lead, ...(read ? [text(read)] : []), text(`${read ? ' · ' : ''}${tail}`, { dim: true }), ...hidden]
}

// ---- the body: names in the code, then one row per choice ---------------------------

function bodyLines(card: MargincueCard, g: Grid, width: number, P: Palette, words: Words, room: number): Line[] {
  if (room <= 0) return []
  let names = mentionLines(card, g, width, P, words)
  const focus = card.rows.findIndex((row) => row.id === card.focus)
  const layout = (most: number) => card.rows.map((row, i) => rowLines(row, i === focus, g, width, P, words, i === focus ? 4 : most))
  let rows = layout(2)
  const total = () => names.length + rows.reduce((n, lines) => n + lines.length, 0)
  if (total() > room) rows = layout(1)
  if (total() > room) names = names.slice(0, 1)
  if (total() <= room) return [...names, ...rows.flat()]
  if (!rows.length) return names.slice(0, room)
  // Still too tall: the focused row first, then the others that fit, then how many are left.
  const at = Math.max(0, focus)
  const most = Math.max(1, room - 1)
  if (rows[at]!.length > most) rows[at] = rowLines(card.rows[at]!, at === focus, g, width, P, words, most)
  const keep = new Set<number>([at])
  let used = rows[at]!.length + 1
  for (let i = 0; i < rows.length; i++) {
    if (keep.has(i) || used + rows[i]!.length > room) continue
    keep.add(i)
    used += rows[i]!.length
  }
  const out: Line[] = rows.flatMap((lines, i) => keep.has(i) ? lines : [])
  const gone = rows.length - keep.size
  if (gone > 0 && out.length < room) out.push([text(' '.repeat(g.content)), text(truncate(words.more(gone), width - g.content), { dim: true })])
  return out
}

function labelLead(label: string, g: Grid, style?: Style): Line {
  const cut = truncate(label, g.label)
  return [text(' '.repeat(MARK + g.label - cells(cut))), text(cut, style), text(GAP)]
}

function mentionLines(card: MargincueCard, g: Grid, width: number, P: Palette, words: Words): Line[] {
  const found = card.mentions.filter((m) => m.status === 'found')
  const missing = card.mentions.filter((m) => m.status === 'missing')
  if (!found.length && !missing.length) return []
  const room = width - g.content
  const items: Line[] = [
    ...missing.map((m): Line => [text('? ', { color: P.attention, bold: true }), text(truncate(m.phrase, room - 2), { color: P.attention })]),
    ...found.map((m): Line => [text('✓ ', { color: 'success' }), text(truncate(m.phrase, room - 2), { color: P.accent })]),
  ]
  const { lines } = flow(items, room, 2, 3, (n) => [text(`+${n}`, { dim: true })])
  return lines.map((line, i) => i ? [text(' '.repeat(g.content)), ...line] : [...labelLead(words.inCode, g, { dim: true }), ...line])
}

type Badge = { glyph: string; color: Color }

function badge(row: MargincueRow): Badge | null {
  if (row.origin === 'lens') return { glyph: '◆', color: 'claude' }
  // A name the code lacks asks until the person says which one it is.
  if (row.origin === 'repo') return row.chosen ? { glyph: '✓', color: 'success' } : { glyph: '?', color: 'warning' }
  if (row.learned) return { glyph: '↺', color: 'subtle' }
  return null
}

/**
 * A row's label in lines no wider than its column, broken between words (a word longer than the column is
 * split): like an option, a label is wrapped, never cut with an ellipsis.
 */
export function labelParts(label: string, room: number): string[] {
  const width = Math.max(1, room)
  if (cells(label) <= width) return [label]
  const out: string[] = []
  let line = ''
  for (const word of label.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (cells(rest) > width) {
      if (line) out.push(line)
      line = ''
      let piece = ''
      for (const ch of rest) {
        if (cells(piece + ch) > width) break
        piece += ch
      }
      out.push(piece)
      rest = rest.slice(piece.length)
    }
    if (!rest) continue
    const next = line ? `${line} ${rest}` : rest
    if (cells(next) <= width) line = next
    else {
      out.push(line)
      line = rest
    }
  }
  if (line) out.push(line)
  return out
}

/** The marker, the badge and the label, right-aligned in the label column; `part` is one line of a wrapped label. */
function rowLead(row: MargincueRow, focus: boolean, g: Grid, P: Palette, gap: string, part = row.label, first = true): Line {
  const mark = badge(row)
  const room = g.label - (mark ? 2 : 0)
  return [
    text(first && focus ? '▸ ' : '  ', first && focus ? { color: P.accent, bold: true } : undefined),
    text(' '.repeat(Math.max(0, room - cells(part)))),
    ...(mark ? [first ? text(`${mark.glyph} `, { color: mark.color }) : text('  ')] : []),
    text(part, focus ? { color: P.accent, bold: true } : row.chosen ? undefined : { dim: true }),
    text(gap),
  ]
}

/** The selected value's chip: green once the person set it, blue for the agent's own choice, neutral otherwise. */
function tone(row: MargincueRow, P: Palette): Style {
  if (row.origin === 'agent') return row.chosen && !sameSelection(row.selected, row.defaults) ? P.yours : P.agent
  return row.chosen ? P.yours : P.suggested
}

function chip(row: MargincueRow, i: number, focus: boolean, P: Palette, room: number): Segment {
  const on = row.selected.includes(i)
  const option = row.options[i] ?? ''
  const many = row.type === 'many'
  const body = `${many ? (on ? '✓ ' : '+ ') : ''}${option}`
  // Every chip keeps one cell of padding on each side, so moving the selection moves no text.
  const face = ` ${cells(body) + 2 > room ? truncate(body, Math.max(1, room - 2)) : body} `
  const style = on ? tone(row, P) : undefined
  return {
    kind: 'button', key: `card-${row.id}-${i}`, label: `${many ? (on ? '✓' : '·') : (on ? '●' : '○')} ${option}`,
    face, ...(style ? { style } : focus ? {} : { dim: true }),
    action: { type: 'cardSet', row: row.id, option: i },
  }
}

function focusHint(P: Palette, words: Words): Line {
  return [
    text('alt↓', { color: P.accent }), text(` ${words.change}`, { dim: true }),
    text(' · ', { dim: true }), text('alt↑', { color: P.accent }), text(` ${words.nextRow}`, { dim: true }),
  ]
}

function rowLines(row: MargincueRow, focus: boolean, g: Grid, width: number, P: Palette, words: Words, most: number): Line[] {
  const room = Math.max(8, width - g.content + 1)
  const hint = focus ? focusHint(P, words) : []
  const withHint = (line: Line): Line =>
    hint.length && segmentsWidth(line) + 4 + segmentsWidth(hint) <= width ? [...line, text('    '), ...hint] : line
  // A label longer than its column takes the row's next lines; the row grows rather than the label being cut.
  const parts = labelParts(row.label, g.label - (badge(row) ? 2 : 0))
  const tail = (k: number, gap: string): Line => rowLead(row, focus, g, P, gap, parts[k]!, false)
  if (row.type === 'range') {
    const bar = slider(row, focus, room - 1, P)
    if (bar) return [withHint([...rowLead(row, focus, g, P, GAP, parts[0]), ...bar]), ...parts.slice(1).map((_, k) => tail(k + 1, GAP))]
  }
  const lead = rowLead(row, focus, g, P, ' ', parts[0])
  const chips = row.options.map((_, i): Line => [chip(row, i, focus, P, room)])
  if (row.origin === 'agent' && row.chosen && !sameSelection(row.selected, row.defaults)) {
    const was = row.options[row.defaults[0] ?? 0]
    if (was) chips.push([text(`${words.was} ${was}`, { dim: true, italic: true })])
  }
  const more = (n: number): Line => [{ kind: 'button', key: `card-more-${row.id}`, label: `+${n}`, dim: true, action: { type: 'cardFocus', row: row.id } }]
  const smaller = (option: number) => (_: number, cells: number): Line => [chip(row, option, focus, P, Math.max(3, cells))]
  let laid = flow(chips, room, most, 1, more, (j, cells) => j < row.options.length ? smaller(j)(j, cells) : chips[j]!)
  if (laid.hidden.length && row.selected.some((i) => laid.hidden.includes(i))) {
    // The value the row reads with comes first when not everything fits.
    const order = [...row.selected, ...row.options.map((_, i) => i).filter((i) => !row.selected.includes(i))]
    laid = flow(order.map((i) => chips[i]!), room, most, 1, more, (j, cells) => smaller(order[j]!)(j, cells))
  }
  const out = laid.lines.map((line, i): Line => i ? [...(parts[i] ? tail(i, ' ') : [text(' '.repeat(g.content - 1))]), ...line] : [...lead, ...line])
  out[out.length - 1] = withHint(out.at(-1)!)
  for (let k = out.length; k < parts.length; k++) out.push(tail(k, ' '))
  return out
}

/** A slider made of one button per step, so a click lands on its value; the value itself as a chip. */
function slider(row: MargincueRow, focus: boolean, room: number, P: Palette): Line | null {
  const n = row.options.length
  const at = row.selected[0] ?? 0
  const low = truncate(row.options[0] ?? '', 14)
  const high = truncate(row.options[n - 1] ?? '', 14)
  const value = row.options[at] ?? ''
  const fixed = cells(low) + cells(high) + cells(value) + 2 + 2 + 3
  if (room - fixed < n) return null
  const per = Math.max(1, Math.min(4, Math.floor((room - fixed) / n)))
  const chip = row.chosen ? P.yours : P.suggested
  const fill = row.chosen ? P.yours.color! : P.accent
  const steps = Array.from({ length: n }, (_, i): Segment => ({
    kind: 'button', key: `card-${row.id}-${i}`, label: i === at ? `● ${row.options[i]}` : `○ ${row.options[i]}`,
    face: i < at ? '━'.repeat(per) : i === at ? `${'━'.repeat(per - 1)}●` : '─'.repeat(per),
    style: i <= at ? { color: fill, bold: i === at } : { dim: !focus },
    action: { type: 'cardSet', row: row.id, option: i },
  }))
  return [
    text(`${low} `, { dim: true }), ...steps, text(` ${high}`, { dim: true }), text('   '),
    text(' ', chip), text(value, chip), text(' ', chip),
  ]
}

/**
 * Groups laid left to right in lines of at most `room` cells, `gap` cells
 * apart, on at most `most` lines; what does not fit is counted by `more`.
 * Returns the indices of the groups left out.
 */
function flow(groups: Line[], room: number, most: number, gap: number, more: (n: number) => Line,
  shrink?: (j: number, width: number) => Line): { lines: Line[]; hidden: number[] } {
  const widths = groups.map((group) => segmentsWidth(group))
  const rows: number[][] = [[]]
  const width = (row: number[]) => row.reduce((n, j, k) => n + (k ? gap : 0) + widths[j]!, 0)
  let i = 0
  for (; i < groups.length; i++) {
    const row = rows.at(-1)!
    if (row.length && width(row) + gap + widths[i]! > room) {
      if (rows.length === most) break
      rows.push([i])
      continue
    }
    row.push(i)
  }
  const hidden = groups.map((_, j) => j).slice(i)
  const drawn = [...groups]
  if (hidden.length) {
    const last = rows.at(-1)!
    while (last.length > 1 && width(last) + gap + segmentsWidth(more(hidden.length)) > room) hidden.unshift(last.pop()!)
    // One group left and still no room for the count: the group gives up cells for it.
    const over = width(last) + gap + segmentsWidth(more(hidden.length)) - room
    if (over > 0 && last.length === 1 && shrink) drawn[last[0]!] = shrink(last[0]!, widths[last[0]!]! - over)
  }
  const lines = rows.filter((row) => row.length).map((row): Line => row.flatMap((j, k) => k ? [text(' '.repeat(gap)), ...drawn[j]!] : drawn[j]!))
  if (hidden.length && lines.length) lines[lines.length - 1]!.push(text(' '.repeat(gap)), ...more(hidden.length))
  return { lines, hidden }
}

// ---- the sketch ---------------------------------------------------------------------

function captionLine(sketch: NonNullable<MargincueCard['sketch']>, P: Palette, words: Words, width: number, note = '', named = false): Line {
  let pin: Segment | null = sketch.lines.length ? {
    kind: 'button', key: 'sketch-pin', label: sketch.pinned ? words.attached : words.attach,
    face: sketch.pinned ? ` ${words.attached} ` : words.attach,
    ...(sketch.pinned ? { style: P.yours } : { dim: true }),
    action: { type: 'sketch', action: 'pin' },
  } : null
  let state = sketch.drawing ? (sketch.lines.length ? ' ⟳' : ` ${words.drawing}`) : note ? ` · ${note}` : ''
  let name = named ? `${words.preview}  ` : ''
  const title = sketch.title || words.preview
  const fixed = () => cells(name) + cells(state) + (pin ? 3 + segmentsWidth([pin]) : 0)
  // Where room runs short the title keeps eight cells: the label goes first, then the note, then the button.
  if (width - fixed() < 8) name = ''
  if (width - fixed() < 8 && note) state = ''
  if (width - fixed() < 8) pin = null
  return [
    ...(name ? [text(name, { dim: true })] : []),
    { kind: 'button', key: 'sketch-title', label: title, face: truncate(title, Math.max(1, width - fixed())), style: { bold: true }, action: { type: 'sketch', action: 'toggle' } },
    ...(state ? [text(truncate(state, Math.max(0, width - fixed() + cells(state) - 1)), { dim: true })] : []),
    ...(pin ? [text('   '), pin] : []),
  ]
}

const LEFT = '│┃║├┝┠╟╞┌┍┎┏╔╒╓╭└┕┖┗╚╘╙╰'
const RIGHT = '│┃║┤┥┨╢╡┐┑┒┓╗╕╖╮┘┙┚┛╝╛╜╯'
const SIDE = '│┃║'
const RULE = /[─━═]/
const BOX = /[─-╿]+/g

/**
 * A sketch drawn in a frame, its right edge put straight: a model cannot count
 * cells, so the lines of one box end at different columns. Every framed line
 * is padded to the widest (rules with their own line character, text with
 * spaces, one cell clear of the edge). Lines outside the frame are kept as is.
 */
export function tidySketch(lines: string[]): string[] {
  // A side line the model left open ("│ Team owners  [Download CSV]") still belongs to the frame.
  const closed = (t: string[]) => RIGHT.includes(t.at(-1)!)
  const framed = lines.map((line) => {
    const t = [...line.trim()]
    return t.length >= 2 && LEFT.includes(t[0]!) && (closed(t) || SIDE.includes(t[0]!))
  })
  if (framed.filter(Boolean).length < 2) return lines
  const indent = Math.min(...lines.filter((_, i) => framed[i]).map((line) => line.length - line.trimStart().length))
  const parts = lines.map((line, i) => {
    if (!framed[i]) return null
    const t = [...line.trim()]
    const side = SIDE.includes(t[0]!)
    const shut = closed(t)
    return { left: t[0]!, right: shut ? t.at(-1)! : t[0]!, body: (shut ? t.slice(1, -1) : t.slice(1)).join('').replace(/\s+$/, ''), side }
  })
  const inner = Math.max(...parts.map((part) => part ? cells(part.body) + (part.side ? 1 : 0) : 0))
  return lines.map((line, i) => {
    const part = parts[i]
    if (!part) return line
    const fill = part.side ? ' ' : (RULE.exec(part.body)?.[0] ?? '─')
    return `${' '.repeat(indent)}${part.left}${part.body}${fill.repeat(Math.max(0, inner - cells(part.body)))}${part.right}`
  })
}

/** Up to `most` lines of a sketch; one that does not fit keeps its first lines and its last (often a frame's bottom). */
function pictureLines(drawing: string[], P: Palette, words: Words, most: number): Line[] {
  const draw = (line: string): Line => {
    const out: Line = []
    let at = 0
    for (const m of line.matchAll(BOX)) {
      if (m.index! > at) out.push(text(line.slice(at, m.index)))
      out.push(text(m[0], { color: P.frame }))
      at = m.index! + m[0].length
    }
    if (at < line.length) out.push(text(line.slice(at)))
    return out
  }
  if (drawing.length <= most) return drawing.map(draw)
  if (most < 3) return drawing.slice(0, most).map(draw)
  const head = drawing.slice(0, most - 2)
  const last = drawing.at(-1)!
  const gone = drawing.length - head.length - 1
  const t = [...last.trim()]
  const boxed = t.length >= 2 && LEFT.includes(t[0]!) && RIGHT.includes(t.at(-1)!)
  const note = `⋯ ${words.lines(gone)} · ctrl+x tab, s`
  if (!boxed) return [...head.map(draw), [text(note, { dim: true, italic: true })], draw(last)]
  const indent = last.length - last.trimStart().length
  const inner = cells(last.trim()) - 2
  const body = ` ${truncate(note, Math.max(1, inner - 1))}`
  return [
    ...head.map(draw),
    [text(' '.repeat(indent)), text('│', { color: P.frame }), text(body + ' '.repeat(Math.max(0, inner - cells(body))), { dim: true, italic: true }), text('│', { color: P.frame })],
    draw(last),
  ]
}

// ---- keys -------------------------------------------------------------------------

/** Buttons the person never sees: the alt chords, and the band's keys after ctrl+x tab. */
function hiddenButtons(card: MargincueCard, chords: boolean): Line {
  const hidden: Line = []
  if (chords && card.rows.length) {
    hidden.push(
      { kind: 'button', key: 'card-next', chord: CHORD_NEXT, hidden: true, label: 'next', action: { type: 'cardFocus', dir: 1 } },
      { kind: 'button', key: 'card-cycle', chord: CHORD_SWAP, hidden: true, label: 'change', action: { type: 'cardCycle' } },
    )
  }
  const focused = card.rows.find((row) => row.id === card.focus)
  if (focused) {
    focused.options.slice(0, 9).forEach((_, i) => hidden.push({
      kind: 'button', key: `card-digit-${i}`, hotkey: String(i + 1), hidden: true, label: String(i + 1),
      action: { type: 'cardSet', row: focused.id, option: i },
    }))
    hidden.push({ kind: 'button', key: 'card-drop', hotkey: 'x', hidden: true, label: 'drop', action: { type: 'cardDismiss', row: focused.id } })
  }
  if (card.sketch && card.stage === 'draft') {
    hidden.push(
      { kind: 'button', key: 'card-sketch', hotkey: 's', hidden: true, label: 'sketch', action: { type: 'sketch', action: 'toggle' } },
      { kind: 'button', key: 'card-pin', hotkey: 'p', hidden: true, label: 'pin', action: { type: 'sketch', action: 'pin' } },
    )
  }
  return hidden
}

// ---- the receipt, under the answer ---------------------------------------------------

/** What travelled with the prompt and what the agent chose; one press on another option writes the follow-up. */
export function layoutReceipt(receipt: MargincueReceipt, columns: number, P: Palette = DARK): Line[] {
  const width = cells(TAG)
  const content = MARK + width + GAP.length
  const room = Math.max(20, columns - content)
  const lead = (name: string): Line => [text(' '.repeat(MARK + width - cells(name))), text(name, { dim: true }), text(GAP)]
  const out: Line[] = [[text(' '.repeat(MARK)), text(TAG, P.tag), text(GAP), text(`you set ${receipt.yours.length} · the agent chose ${receipt.agent.length}`, { dim: true })]]
  for (const line of receipt.yours) {
    wrapLines(line, room - 2, room - 2, 3).forEach((part, k) => out.push(k
      ? [text(' '.repeat(content + 2)), text(part)]
      : [...lead('you'), text('✓ ', { color: 'success' }), text(part)]))
  }
  receipt.agent.forEach((item, i) => {
    const value = item.was ? P.yours : P.agent
    const groups: Line[] = [
      [text(`${item.label} `, { dim: true }), text(' ', value), text(item.value, value), text(' ', value)],
      ...(item.was ? [[text(`was ${item.was}`, { dim: true, italic: true })]] : []),
      ...item.options.flatMap((option, j): Line[] => option === item.value ? [] : [[{
        kind: 'button', key: `agent-${i}-${j}`, label: `→ ${option}`, face: `→ ${option}`, dim: true,
        action: { type: 'receiptPick', receipt: receipt.id, item: i, option: j },
      }]]),
    ]
    flow(groups, room, 3, 2, (n) => [text(`+${n}`, { dim: true })]).lines
      .forEach((line, k) => out.push(k ? [text(' '.repeat(content)), ...line] : [...lead('agent'), ...line]))
  })
  return out
}

// ---- the prompt as it was sent ---------------------------------------------------------

export type Sent = { body: string; decisions: string[]; refs: string[]; sketch: { title: string; lines: number } | null }

const TARGET = /\n*Target output, as sketched \(([^\n]*)\):\n```text\n([\s\S]*?)\n```\s*$/
const WHERE = 'Where things are:'

/** A sent prompt split into what the person wrote and what MarginCue attached; null when nothing was attached. */
export function splitSent(sent: string): Sent | null {
  let rest = sent
  let sketch: Sent['sketch'] = null
  const target = TARGET.exec(rest)
  if (target) {
    sketch = { title: target[1]!, lines: target[2]!.split('\n').length }
    rest = rest.slice(0, target.index)
  }
  const { body, items } = splitDecisions(rest)
  if (!items.length && !sketch) return null
  return {
    body: body.replace(/\s+$/, ''),
    decisions: items.filter((item) => !item.startsWith(WHERE)),
    refs: items.filter((item) => item.startsWith(WHERE)).map((item) => item.slice(WHERE.length).trim().replace(/\.$/, '')),
    sketch,
  }
}

/** Under the person's prompt in the transcript: the decisions that went with it, as a list rather than raw text. */
export function layoutSent(sent: Sent, columns: number, P: Palette = DARK): Line[] {
  const room = Math.max(20, columns - 8)
  const n = sent.decisions.length
  const what = [
    ...(n ? [`${n} decision${n === 1 ? '' : 's'}`] : []),
    ...(sent.refs.length ? ['where things are in the code'] : []),
    ...(sent.sketch ? ['the sketch'] : []),
  ]
  const out: Line[] = [[text('  '), text(TAG, P.tag), text(GAP), text(`went with this prompt: ${joinList(what)}`, { dim: true })]]
  const item = (glyph: Segment, value: string, style?: Style) => wrapLines(value, room, room, 4)
    .forEach((part, k) => out.push(k ? [text('      '), text(part, style)] : [text('    '), glyph, text(' '), text(part, style)]))
  for (const line of sent.decisions) item(text('✓', { color: 'success' }), line)
  for (const line of sent.refs) item(text('⌁', { color: P.accent }), line, { dim: true })
  if (sent.sketch) item(text('▣', { color: P.accent }), `${sent.sketch.title} (${sent.sketch.lines} line${sent.sketch.lines === 1 ? '' : 's'})`, { dim: true })
  return out
}

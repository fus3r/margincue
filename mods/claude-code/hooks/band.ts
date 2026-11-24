// The band above the prompt: the card (card-view.ts) and the standing cues,
// laid out as plain segments so they can be tested without a surface.
// register.tsx turns segments into Text and Button elements.

import type { MargincueBand, MargincueCue, MargincueScope } from '../types'
import { layoutCard } from './card-view'
import { CHORD_NEXT, CHORD_SWAP, DARK, cells, segmentsWidth, spaced, text, truncate } from './segments'
import type { Palette, Segment } from './segments'

export { CHORD_NEXT, CHORD_SWAP, DARK, LIGHT, cells, paletteFor, segmentsWidth, truncate } from './segments'
export type { Action, Color, Palette, Segment, Style } from './segments'
export { layoutCard, tidySketch } from './card-view'

const GAP = 2

export function layoutBandRows(band: MargincueBand, columns: number, hint: string, maxRows = 14, palette: Palette = DARK): Segment[][] {
  const card = band.card
  if (!card && !band.reviewPending) {
    const row = layoutBand(band, columns, hint)
    return row.length ? [row] : []
  }
  const rows: Segment[][] = []
  if (band.first) rows.push(firstTouch(band, columns))
  else if (band.marks?.length) {
    const marks = summary(band, columns, false)
    if (marks.length) rows.push(marks)
  }
  if (band.reviewPending) rows.push([{ kind: 'progress', label: thinkingLabel(band.language) }])
  if (card) {
    // One empty row keeps the open card apart from the transcript above it.
    if (!card.collapsed && !rows.length && maxRows >= 12) rows.push([text(' ')])
    rows.push(...layoutCard(card, columns, Math.max(3, maxRows - rows.length), {
      // A standing guard cue holds the chords while it is shown.
      chords: !band.first,
      extra: [
        ...(band.canReview ? [reviewButton(band)] : []),
        ...(band.depth ? [depthButton(band)] : []),
      ],
      palette,
    }))
  }
  return rows
}

export function thinkingLabel(language: 'fr' | 'en' = 'en'): string {
  return language === 'fr' ? 'MarginCue · réflexion…' : 'MarginCue · thinking…'
}

/** The cue the band is about: the focused one, else the first. */
export function focusedCue(band: MargincueBand): MargincueCue | undefined {
  return band.cues.find((c) => c.id === band.focus) ?? band.cues[0]
}

/** The option the statement reads with now: the pick (or the pending pick), else the default. */
export function currentOption(cue: Pick<MargincueCue, 'options' | 'chosen' | 'pending'>): { text: string; index: number } {
  const pick = cue.pending ?? cue.chosen
  if (typeof pick === 'number') return { text: cue.options[pick] ?? '', index: pick }
  if (typeof pick === 'string') return { text: pick, index: -1 }
  return { text: cue.options[0] ?? '', index: 0 }
}

/**
 * Lays the band out into `columns` cells. Lower-priority parts are dropped
 * whole (never half a button) until the row fits; the statement is cut last.
 */
export function layoutBand(band: MargincueBand, columns: number, hint: string | null): Segment[] {
  if (band.mode === 'quiet') return summary(band, columns, false)
  if (band.first) return firstTouch(band, columns)
  if (band.amendment) return amendment(band, columns)
  const marks = band.marks?.length ? summary(band, Math.floor(columns / 3), false) : []
  const cue = focusedCue(band)
  if (!cue && band.mode) return summary(band, columns, true)
  if (!cue) return band.note ? [{ kind: 'text', text: `· ${band.note}`, style: { dim: true } }] : quiet(band)
  if (cue.provisional) {
    return [{ kind: 'text', text: `◇ checking “${cue.anchor}” …`, style: { dim: true } }]
  }

  const { text: option, index } = currentOption(cue)
  const glyph: Segment =
    cue.pending !== null
      ? { kind: 'text', text: '… ', style: { dim: true } }
      : cue.chosen !== null
      ? { kind: 'text', text: '✓ ', style: { color: 'success' } }
      : cue.stale
        ? { kind: 'text', text: '◇ ', style: { dim: true } }
        : { kind: 'text', text: '◆ ', style: { color: 'warning' } }
  const slot = cue.statement.indexOf('{}')
  const before = slot === -1 ? `${cue.statement} ` : cue.statement.slice(0, slot)
  const after = slot === -1 ? '' : cue.statement.slice(slot + 2)
  const head: Segment[] = [
    glyph,
    { kind: 'text', text: before, style: cue.stale ? { dim: true } : {} },
    { kind: 'text', text: option, style: cue.chosen !== null ? { bold: true, color: 'success' } : { bold: true } },
  ]
  if (after !== '') head.push({ kind: 'text', text: after, style: cue.stale ? { dim: true } : {} })

  type Part = { priority: number; segments: Segment[]; alternative?: true }
  const parts: Part[] = []
  // Alternatives, in option order; earlier ones matter more.
  cue.options.forEach((label, i) => {
    if (i === index || i > 8) return
    parts.push({
      priority: 10 - i,
      alternative: true,
      segments: [{ kind: 'button', key: `opt-${i}`, hotkey: String(i + 1), label, action: { type: 'pick', cue: cue.id, option: i } }],
    })
  })
  if (cue.pending !== null) parts.push({ priority: 11, segments: [{ kind: 'text', text: 'checking', style: { dim: true } }] })
  if (band.note) parts.push({ priority: 5, segments: [{ kind: 'text', text: band.note, style: { dim: true } }] })
  if (cue.chosen === null && cue.pending === null) {
    parts.push({ priority: 7, segments: [{ kind: 'button', key: 'keep', hotkey: 'y', label: 'keep', dim: true, action: { type: 'pick', cue: cue.id, option: 0 } }] })
  }
  if (cue.options.length > 1) {
    const swapTo = (index < 0 ? 0 : index + 1) % cue.options.length
    // The chord only works while its Button is mounted, so it is the last thing dropped.
    parts.push({
      priority: 13,
      segments: [{ kind: 'button', key: 'swap', chord: CHORD_SWAP, label: 'alt↓ swap', dim: true, action: { type: 'cycle', cue: cue.id, option: swapTo } }],
    })
  }
  parts.push({ priority: 4, segments: [{ kind: 'button', key: 'drop', hotkey: 'x', label: 'drop', dim: true, action: { type: 'dismiss', cue: cue.id } }] })
  const real = band.cues.filter((c) => !c.provisional)
  if (band.cues.length > 1) {
    const at = band.cues.indexOf(cue) + 1
    parts.push({
      priority: 12,
      segments: [
        { kind: 'button', key: 'next', hotkey: 'n', chord: CHORD_NEXT, label: `alt↑ next ${at}/${band.cues.length}`, dim: true, action: { type: 'focus', dir: 1 } },
      ],
    })
  }
  const open = real.filter((c) => c.chosen === null && c.pending === null).length
  if (open > 1) {
    parts.push({ priority: 3, segments: [{ kind: 'button', key: 'all', hotkey: 'a', label: 'keep all', dim: true, action: { type: 'acceptAll' } }] })
  }
  if (hint) parts.push({ priority: 1, segments: [{ kind: 'text', text: hint, style: { dim: true } }] })
  if (band.canReview) parts.push({ priority: 6, segments: [reviewButton(band, band.cues.length === 1)] })

  // Fit: drop the minor parts, then all alternatives but the first, then
  // shorten the statement around the option, then the last alternative. The
  // chord buttons stay: a chord presses its Button only while it is mounted.
  const order = parts.map((p, i) => ({ ...p, i }))
  const kept = new Set(order.map((p) => p.i))
  const prefix = head[1] as Extract<Segment, { kind: 'text' }>
  const suffix = head[3] as Extract<Segment, { kind: 'text' }> | undefined
  const fullPrefix = prefix.text
  const fullSuffix = suffix?.text ?? ''
  const width = () => segmentsWidth(marks) + (marks.length ? GAP : 0) + segmentsWidth(head) + order.filter((p) => kept.has(p.i)).reduce((n, p) => n + GAP + segmentsWidth(p.segments), 0)
  const byPriority = [...order].sort((a, b) => a.priority - b.priority || b.i - a.i)
  const dropUntilFits = (below: number, keepOne = false) => {
    const candidates = byPriority.filter((p) => p.priority < below && kept.has(p.i))
    const keepAlternative = keepOne ? candidates.filter((p) => p.alternative).at(-1) : undefined
    for (const part of candidates) {
      if (width() <= columns) return
      if (part === keepAlternative) continue
      kept.delete(part.i)
    }
  }
  const shorten = (): boolean => {
    prefix.text = fullPrefix
    if (suffix) suffix.text = fullSuffix
    let over = width() - columns
    if (over <= 0) return true
    if (suffix) {
      const cut = Math.min(over, Math.max(0, cells(fullSuffix) - 2))
      suffix.text = truncate(fullSuffix, cells(fullSuffix) - cut)
      over = width() - columns
    }
    const room = cells(fullPrefix) - over
    if (room < MIN_PREFIX) return false
    prefix.text = truncate(fullPrefix, room)
    return width() <= columns
  }
  dropUntilFits(MINOR)
  dropUntilFits(KEEP_ALWAYS, true)
  if (!shorten()) {
    dropUntilFits(KEEP_ALWAYS)
    if (!shorten()) prefix.text = truncate(fullPrefix, MIN_PREFIX)
  }
  const out: Segment[] = marks.length ? [...marks, { kind: 'text', text: ' '.repeat(GAP) }, ...head] : [...head]
  for (const part of order) {
    if (!kept.has(part.i)) continue
    out.push({ kind: 'text', text: ' '.repeat(GAP) })
    out.push(...part.segments)
  }
  return out
}

export function scopeLabel(scope: MargincueScope, lang: 'fr' | 'en' = 'en'): string {
  return lang === 'fr'
    ? { project: 'ce projet', user: 'partout', model: 'ce modèle', session: 'cette session' }[scope]
    : { project: 'this project', user: 'everywhere', model: 'this model', session: 'this session' }[scope]
}

function firstTouch(band: MargincueBand, columns: number): Segment[] {
  const cue = band.first!
  const lang = band.language ?? 'en'
  const choices = [...cue.options]
  if (!cue.guard) choices.push({ id: 'delegated', label: lang === 'fr' ? 'tu décides' : 'you decide' })
  const controls: Segment[] = [
    { kind: 'button', key: 'scope', hotkey: 's', chord: CHORD_NEXT, label: scopeLabel(cue.scope, lang), action: { type: 'scope', slot: cue.slot } },
    { kind: 'button', key: 'drop', hotkey: 'x', label: lang === 'fr' ? 'passer' : 'skip', dim: true, action: { type: 'dismiss', cue: cue.slot } },
    { kind: 'button', key: 'why', hotkey: 'w', label: lang === 'fr' ? 'raison' : 'why', dim: true, action: { type: 'why', slot: cue.slot } },
  ]
  if (band.canReview && columns >= 90) controls.push(reviewButton(band))
  if (band.depth && columns >= 90) controls.push(depthButton(band))
  const lead: Segment = { kind: 'text', text: `◆ ${truncate(cue.label, columns < 68 ? 9 : 20)}`, style: { color: 'warning', bold: true } }
  // Prefer retaining each choice and the selected scope. Give options equal
  // room when crowded, then give shorter choices' space to longer ones.
  const labels = choices.map((o) => o.label)
  const natural = labels.reduce((sum, label) => sum + cells(label), 0)
  let room = columns - segmentsWidth([lead, ...controls]) - (4 * choices.length + controls.length)
  while (room < Math.min(natural, 18 * choices.length) && controls.length > 2) {
    const removed = controls.pop()!
    room += segmentsWidth([removed]) + 1
  }
  const buttons = fitLabels(labels, room).map((label, i): Segment => ({
    kind: 'button', key: `state-opt-${i}`, hotkey: String(i + 1), ...(i === 1 && { chord: CHORD_SWAP }),
    label, action: { type: 'set', slot: cue.slot, option: choices[i]!.id },
  }))
  const out = spaced([lead, ...buttons, ...controls])
  if (band.marks?.length) {
    const left = columns - segmentsWidth(out) - 1
    if (left >= 4) out.push({ kind: 'text', text: ' ' }, ...summary(band, left, false, true))
  }
  return out
}

function reviewButton(band: MargincueBand, fromPrompt = false): Segment {
  return { kind: 'button', key: 'review', hotkey: 'r', ...(fromPrompt && { chord: CHORD_NEXT }), label: band.language === 'fr' ? 'revue' : 'review', dim: true, action: { type: 'review' } }
}

function depthButton(band: MargincueBand): Segment {
  return { kind: 'button', key: 'depth', hotkey: 'd', label: band.depth ?? 'standard', dim: true, action: { type: 'depth' } }
}

function summary(band: MargincueBand, columns: number, controls: boolean, compact = false): Segment[] {
  const marks = band.marks ?? []
  const open = band.open ?? 0
  const lang = band.language ?? 'en'
  const buttons = controls ? [
    ...(band.canReview ? [reviewButton(band, true)] : []),
    ...(band.depth ? [depthButton(band)] : []),
  ] : []
  const room = columns - segmentsWidth(spaced(buttons)) - (buttons.length ? 1 : 0)
  const count = !compact && open ? `${open} ${lang === 'fr' ? 'en attente' : 'open'}` : ''
  const status = band.note ?? (band.phase === 'reviewing' ? '…' : band.phase === 'error' ? 'no reply' : '')
  const markText = marks.map((mark) => `${mark.label} ${mark.value}`).join(' · ')
  const tail = compact || marks.length === 0 ? count : count ? ` · ${count}` : ''
  const content = markText ? `✓ ${truncate(markText, Math.max(1, room - 2 - cells(tail)))}${tail}`
    : count || (controls ? status : '')
  // Key names alone (before the card comes) say nothing: the row waits for something to show.
  if (!content) return []
  const segments: Segment[] = [{ kind: 'text', text: truncate(content, room), style: { dim: true } }]
  return spaced([...segments, ...buttons])
}

function amendment(band: MargincueBand, columns: number): Segment[] {
  const cue = band.amendment!
  const lang = band.language ?? 'en'
  const lead: Segment = { kind: 'text', text: lang === 'fr' ? 'Amendement' : 'Amendment', style: { color: 'suggestion' } }
  const items = cue.options.map((option, i): Segment => ({
    kind: 'button', key: `amend-${i}`, hotkey: String(i + 1), ...(i === 0 && { chord: CHORD_SWAP }),
    label: i === 0 ? `${truncate(cue.statement.replace('{}', option), Math.max(12, columns - 42))} (alt↓)`
      : truncate(option, Math.max(7, Math.floor((columns - 45) / cue.options.length))),
    action: { type: 'amend', cue: cue.id, option: i },
  }))
  const shown: Segment[] = [lead]
  for (const item of items) {
    if (segmentsWidth(spaced([...shown, item])) <= columns) shown.push(item)
  }
  return spaced(shown)
}


function fitLabels(labels: string[], room: number): string[] {
  const widths = labels.map(cells)
  let total = widths.reduce((sum, width) => sum + width, 0)
  while (total > Math.max(labels.length, room)) {
    const longest = Math.max(...widths)
    widths[widths.indexOf(longest)] = longest - 1
    total--
  }
  return labels.map((label, i) => truncate(label, widths[i]!))
}

/** Parts below this priority go before the statement is shortened. */
const MINOR = 8
/** Parts at or above it (the chord buttons) are never dropped: a chord needs its Button mounted. */
const KEEP_ALWAYS = 12
const MIN_PREFIX = 10


function quiet(band: MargincueBand): Segment[] {
  const status = band.phase === 'reviewing' ? ' …' : band.phase === 'error' ? ' · no reply' : ''
  return [{ kind: 'text', text: `· margincue${status}`, style: { dim: true } }]
}



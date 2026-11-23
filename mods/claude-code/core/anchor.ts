import { foldCase } from './parse'
import type { Splice } from './types'

export type Span = { start: number; end: number }

/**
 * Finds `anchor` in `text`: exact substring, then case-insensitive, then
 * whitespace-normalized (and case-insensitive). Among several occurrences at
 * the first level that finds any, the one whose start is nearest `near` wins
 * (ties: the earlier), else the first.
 */
export function resolveAnchor(text: string, anchor: string, near?: number): Span | null {
  const needle = anchor.trim()
  if (needle === '') return null
  const exact = occurrences(text, needle)
  if (exact.length > 0) return pick(exact, needle.length, near)
  const folded = occurrences(foldCase(text), foldCase(needle))
  if (folded.length > 0) return pick(folded, needle.length, near)
  return resolveNormalized(text, needle, near)
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at)
  return found
}

function pick(starts: number[], length: number, near?: number): Span {
  let best = starts[0] ?? 0
  if (near !== undefined) {
    for (const start of starts) if (Math.abs(start - near) < Math.abs(best - near)) best = start
  }
  return { start: best, end: best + length }
}

function resolveNormalized(text: string, needle: string, near?: number): Span | null {
  // Collapse every run of whitespace to one space, remembering where each kept
  // code unit came from, then search case-insensitively.
  let flat = ''
  const from: number[] = []
  let inSpace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (/\s/.test(ch)) {
      if (!inSpace) {
        flat += ' '
        from.push(i)
      }
      inSpace = true
    } else {
      flat += ch
      from.push(i)
      inSpace = false
    }
  }
  const target = foldCase(needle.replace(/\s+/g, ' '))
  const hits = occurrences(foldCase(flat), target)
  if (hits.length === 0) return null
  const spans = hits.map((hit) => {
    const start = from[hit] ?? 0
    const last = from[hit + target.length - 1] ?? start
    return { start, end: last + 1 }
  })
  let best = spans[0] as Span
  if (near !== undefined) {
    for (const span of spans) if (Math.abs(span.start - near) < Math.abs(best.start - near)) best = span
  }
  return best
}

/**
 * Moves a span across one splice. Returns null when the splice touched the
 * span's text (any overlap, or a replacement strictly inside it). An insertion
 * exactly at either edge does not touch it.
 */
export function shiftSpan(span: Span, edit: Splice): Span | null {
  const delta = edit.text.length - (edit.end - edit.start)
  if (edit.end <= span.start) return { start: span.start + delta, end: span.end + delta }
  if (edit.start >= span.end) return { start: span.start, end: span.end }
  return null
}

/** The splice that turns `before` into `after`: longest common prefix, then suffix. */
export function diffSplice(before: string, after: string): Splice {
  const limit = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++
  let suffix = 0
  while (
    suffix < limit - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++
  return { start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) }
}

/** Whether `edit` applied to `before` yields `after`. */
export function spliceFits(before: string, after: string, edit: Splice): boolean {
  if (edit.start < 0 || edit.end < edit.start || edit.end > before.length) return false
  return before.slice(0, edit.start) + edit.text + before.slice(edit.end) === after
}

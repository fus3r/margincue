import type { ParsedCue, ParsedReply } from './types'

// The wire format (model -> core), parsed tolerantly and incrementally:
//
//   export button ; old
//   export button | Export covers {} | the currently filtered rows | all rows
//   old | A report is old after {} | 90 days | 30 days | one year
//
// `final: false` parses only complete lines (a streamed prefix); `final: true`
// also takes the last, unterminated line. Re-parsing a longer prefix never
// changes what an earlier, complete line produced.

export function parseReply(text: string, final: boolean, maxCues = Infinity): ParsedReply {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (!final) lines.pop()
  const reply: ParsedReply = { plan: null, none: false, cues: [] }
  let seekingPlan = true
  for (const raw of lines) {
    let line = raw.trim()
    if (line === '' || line.startsWith('```')) continue
    line = stripMarker(line)
    line = line.replace(/^output\s*:\s*/i, '')
    if (line === '') continue
    if (!line.includes('|')) {
      // The plan is the first line before any cue line that reads as one:
      // NONE, or anchors of a few words each. Prose a model writes ahead of
      // its answer (it happens at low effort) is skipped, not taken as anchors.
      if (!seekingPlan) continue
      if (/^none\.?$/i.test(unquote(line))) {
        reply.none = true
        reply.plan = []
        seekingPlan = false
        continue
      }
      const anchors = planAnchors(line)
      if (anchors !== null) {
        reply.plan = anchors.slice(0, maxCues)
        seekingPlan = false
      }
      continue
    }
    seekingPlan = false
    if (reply.none) continue // cue lines after NONE contradict it: silence wins
    if (reply.cues.length >= maxCues) continue
    const cue = parseCueLine(line)
    if (cue) reply.cues.push(cue)
  }
  return reply
}

/** Words in one plan anchor at most; the format asks for one to four. */
const PLAN_ANCHOR_WORDS = 6

function planAnchors(line: string): string[] | null {
  const parts = line
    .split(';')
    .map((part) => unquote(part.trim()))
    .filter((part) => part !== '')
  if (parts.length === 0) return null
  for (const part of parts) if (part.split(/\s+/).length > PLAN_ANCHOR_WORDS) return null
  return parts
}

/**
 * The field layout of a cue line, in one place: `anchor | statement | default
 * | alternative…`. (The next revision inserts a cue id after the anchor.)
 */
const FIELD = { anchor: 0, statement: 1, firstOption: 2 } as const
const MIN_FIELDS = FIELD.firstOption + 2

export function parseCueLine(line: string): ParsedCue | null {
  if (!line.includes('|')) return null
  const fields = line.split('|').map((field) => unquote(field.trim()))
  if (fields.length < MIN_FIELDS) return null
  const anchorField = fields[FIELD.anchor] ?? ''
  const statementField = fields[FIELD.statement] ?? ''
  const rest = fields.slice(FIELD.firstOption)
  if (anchorField.toLowerCase() === 'anchor' && statementField.toLowerCase() === 'statement') return null
  let statement = statementField.trim()
  if (statement === '') return null
  if (!statement.includes('{}')) statement = `${statement} {}`
  const options: string[] = []
  const seen = new Set<string>()
  for (const option of rest) {
    const value = option.trim()
    if (value === '') continue
    const key = normalize(value)
    if (seen.has(key)) continue
    seen.add(key)
    options.push(value)
  }
  if (options.length < 2) return null
  const anchor = anchorField.trim()
  const isGlobal = anchor === '' || /^[-–—]$/.test(anchor)
  return { anchor: isGlobal ? null : anchor, statement, options }
}

function stripMarker(line: string): string {
  return line.replace(/^(?:[-*•]\s+|\d{1,2}[.)]\s+)/, '')
}

const QUOTES: Array<[string, string]> = [
  ['**', '**'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
  ['*', '*'],
]

/** Strips one or more layers of matching quotes, backticks or emphasis around a field. */
export function unquote(value: string): string {
  let out = value.trim()
  for (let changed = true; changed; ) {
    changed = false
    for (const [open, close] of QUOTES) {
      if (out.length >= open.length + close.length + 1 && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim()
        changed = true
      }
    }
  }
  return out
}

/** Case- and whitespace-insensitive comparison key. */
export function normalize(value: string): string {
  return foldCase(value.trim().replace(/\s+/g, ' '))
}

/**
 * Lowercases code unit by code unit, keeping only mappings that stay one code
 * unit long, so offsets never move (the Rust port does the same per char).
 */
export function foldCase(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] ?? ''
    const lower = ch.toLowerCase()
    out += lower.length === 1 ? lower : ch
  }
  return out
}

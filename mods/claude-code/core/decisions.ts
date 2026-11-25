import type { Decision } from './types'

export const FILE_REFERENCES_HEADING = 'Where things are:'

export function fileReferenceDecision(refs: { phrase: string; files: string[] }[]): Decision {
  return {
    statement: `${FILE_REFERENCES_HEADING} {}`,
    option: refs.map(({ phrase, files }) => `${phrase} (${files.join(' or ')})`).join(', '),
  }
}

// The Decisions block at the end of a prompt:
//
//   Add an export button to the dashboard.
//
//   Decisions:
//   - Export covers all rows.
//
// Lines the user typed are never rewritten: MarginCue only appends its own
// lines, or replaces a line it wrote itself (named in `own`), matched by
// statement.

/** The statement with the option in its slot (the first `{}`). */
export function fillStatement(statement: string, option: string): string {
  const at = statement.indexOf('{}')
  if (at === -1) return `${statement} ${option}`.trim()
  return statement.slice(0, at) + option + statement.slice(at + 2)
}

/** One decision as its line: the filled statement, capitalised, ending in a period. */
export function decisionLine(decision: Decision): string {
  // A sheet item may be a label rather than a question ("Platform"): it then needs a colon before the answer.
  const text = decision.question
    ? `${decision.statement}${/[?？:]$/.test(decision.statement.trim()) ? '' : ':'} ${decision.option}`
    : fillStatement(decision.statement, decision.option)
  let line = text.trim().replace(/\s+/g, ' ')
  if (line === '') return line
  line = line.charAt(0).toUpperCase() + line.slice(1)
  if (!/[.?!]$/.test(line)) line += '.'
  return line
}

type Block = {
  /** All lines of the draft. */
  lines: string[]
  /** Index of the `Decisions:` line, or -1 when the draft ends with no block. */
  heading: number
  /** Index of the block's last item line (heading when it has none). */
  last: number
}

const ITEM = /^\s*[-*•]\s+(\S.*)$/

function findBlock(draft: string): Block {
  const lines = draft.split('\n')
  let i = lines.length - 1
  while (i >= 0 && (lines[i] ?? '').trim() === '') i--
  const last = i
  while (i >= 0 && ITEM.test(lines[i] ?? '')) i--
  if (i >= 0 && /^\s*decisions\s*:\s*$/i.test(lines[i] ?? '')) return { lines, heading: i, last }
  return { lines, heading: -1, last: -1 }
}

function itemText(line: string): string {
  const m = ITEM.exec(line)
  return m ? (m[1] ?? '').trim() : ''
}

/** The draft without a trailing Decisions block, and the block's item texts. */
export function splitDecisions(draft: string): { body: string; items: string[] } {
  const block = findBlock(draft)
  if (block.heading === -1) return { body: draft, items: [] }
  return {
    body: block.lines.slice(0, block.heading).join('\n'),
    items: block.lines.slice(block.heading + 1, block.last + 1).map(itemText),
  }
}

/**
 * Attaches `decisions` to `draft`. With no trailing block, one is added after
 * the draft. With one, every line stays verbatim and in place except lines in
 * `own` (lines MarginCue wrote earlier), which are replaced when a decision
 * fills the same statement; a decision whose statement a user line already
 * fills is left out; the rest are appended to the block. No decisions: the
 * draft is returned unchanged.
 */
export function applyDecisions(draft: string, decisions: Decision[], own: string[] = []): string {
  return attachDecisions(draft, decisions, own).text
}

/** applyDecisions, also saying which lines it added or replaced (the ones that travel). */
export function attachDecisions(draft: string, decisions: Decision[], own: string[] = []): { text: string; added: string[] } {
  if (decisions.length === 0) return { text: draft, added: [] }
  const block = findBlock(draft)
  if (block.heading === -1) {
    const lines = decisions.map(decisionLine).filter((line) => line !== '')
    const unique = lines.filter((line, i) => lines.indexOf(line) === i)
    if (unique.length === 0) return { text: draft, added: [] }
    const head = draft.replace(/\s+$/, '')
    const body = `Decisions:\n${unique.map((line) => `- ${line}`).join('\n')}`
    return { text: head === '' ? body : `${head}\n\n${body}`, added: unique }
  }

  const lines = [...block.lines]
  const ours = new Set(own.map((line) => line.trim()))
  const added: string[] = []
  const replacedLines: string[] = []
  for (const decision of decisions) {
    const line = decisionLine(decision)
    if (line === '') continue
    const pattern = statementPattern(decision.statement, decision.question)
    let replaced = false
    let settledByUser = false
    for (let i = block.heading + 1; i <= block.last; i++) {
      const item = itemText(lines[i] ?? '')
      if (item === line) {
        replaced = true
        break
      }
      if (!pattern.test(item)) continue
      if (ours.has(item)) {
        lines[i] = `- ${line}`
        replacedLines.push(line)
        replaced = true
        break
      }
      settledByUser = true
    }
    if (!replaced && !settledByUser && !added.includes(line)) added.push(line)
  }
  lines.splice(block.last + 1, 0, ...added.map((line) => `- ${line}`))
  return { text: lines.join('\n'), added: [...replacedLines, ...added] }
}

function statementPattern(statement: string, question = false): RegExp {
  const filled = statement.trim().replace(/\s+/g, ' ')
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  // A sheet item is written "question answer" or, for a label, "label: answer" (see decisionLine).
  if (question) return new RegExp(`^${escape(filled)}:?\\s+.+?[.?!]?$`, 'i')
  const parts = (filled.includes('{}') ? filled : `${filled} {}`).split('{}')
  return new RegExp(`^${parts.map(escape).join('.+?')}[.?!]?$`, 'i')
}

/** Whether a user-written item already fills this statement. */
export function matchesDecision(statement: string, item: string): boolean {
  return statementPattern(statement).test(item)
}

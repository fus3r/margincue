import { rowValue } from '../../claude-code/core/card'
import type { ParsedSketch } from '../../claude-code/core/card'
import { decisionLine } from '../../claude-code/core/decisions'
import type { CardRowView } from '../../claude-code/core/types'

export type WidgetRow = Pick<CardRowView, 'id' | 'label' | 'type' | 'statement' | 'options'> & {
  assumed: number[]
  files?: string[]
}

export type WidgetCard = {
  id: string
  prompt: string
  reading: string | null
  rows: WidgetRow[]
  missing: { phrase: string; candidates: { name: string; file: string }[]; rowId?: string }[]
  preview: boolean
  sketch: ParsedSketch | null
}

export type CardState = 'reading' | 'done' | 'failed'
export type SketchState = 'none' | 'drawing' | 'done' | 'failed'

/** What the card tools hand the widget: the card as far as it is read, and where its reading and preview are. */
export type CardOutput = WidgetCard & { version?: number; state?: CardState; sketchState?: SketchState }

export type Selections = Record<string, number[]>
export type FollowUp = { text: string; decisions: string[]; extra: string }

const AS_WRITTEN = 'Go ahead with my prompt as written.'
const WITH_EDITS = 'Go ahead with my prompt above.'

export function isCardFollowUp(prompt: string): boolean {
  const first = prompt.trimStart().split(/\r?\n/, 1)[0]?.trimEnd()
  return first === AS_WRITTEN || first === WITH_EDITS
}

export function choiceLine(row: WidgetRow, selected: number[]): string {
  const file = row.files?.[selected[0] ?? -1]
  const value = rowValue(row, selected)
  return decisionLine({ statement: row.statement, option: file ? `${value} (${file})` : value })
}

/** The preview as it travels with a prompt: the same words the Claude Code and Codex composers use. */
export function targetLines(sketch: ParsedSketch): string {
  return `Target output, as sketched (${sketch.title}):\n\`\`\`text\n${sketch.lines.join('\n')}\n\`\`\``
}

/**
 * The follow-up Go ahead sends: the whole plan the card showed, so the agent builds what the person saw. That is
 * every choice, switched or kept as shown (a name the code lacks has no default: only a pick of it travels), the
 * note, and the preview when it was drawn for exactly these choices. As written sends the prompt alone.
 */
export function composeFollowUp(rows: WidgetRow[], picks: Selections, note: string, asWritten = false, sketch: ParsedSketch | null = null): FollowUp {
  if (asWritten) return { text: AS_WRITTEN, decisions: [], extra: '' }
  const decisions = rows.flatMap((row) => {
    const picked = picks[row.id]
    if (picked) return [choiceLine(row, picked)]
    return !row.files && row.assumed.length ? [choiceLine(row, row.assumed)] : []
  })
  const extra = note.trim().replace(/\s*[\r\n]+\s*/g, ' ')
  const target = sketch?.lines.length ? targetLines(sketch) : null
  const text = decisions.length || extra || target ? [
    WITH_EDITS,
    ...(decisions.length ? [`Decisions:\n${decisions.map((line) => `- ${line}`).join('\n')}`] : []),
    ...(extra ? [`Also: ${extra}`] : []),
    ...(target ? [target] : []),
  ].join('\n\n') : AS_WRITTEN
  return { text, decisions, extra }
}

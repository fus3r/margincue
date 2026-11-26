import { openChoiceLine, openChoicesBlock, rowValue, STEP_ORDER_KEY } from '../../claude-code/core/card'
import type { ParsedSketch } from '../../claude-code/core/card'
import { decisionLine, fileReferenceDecision } from '../../claude-code/core/decisions'
import type { CardRowView, SendSetting } from '../../claude-code/core/types'
import { DEFAULT_SEND } from '../../claude-code/core/types'

export type WidgetRow = Pick<CardRowView, 'id' | 'label' | 'type' | 'statement' | 'options'> &
  Partial<Pick<CardRowView, 'key' | 'origin' | 'learned' | 'openOnSend' | 'lens'>> & {
  assumed: number[]
  files?: string[]
}

export type WidgetCard = {
  id: string
  prompt: string
  reading: string | null
  rows: WidgetRow[]
  missing: { phrase: string; candidates: { name: string; file: string }[]; rowId?: string }[]
  fileReferences?: { phrase: string; files: string[]; rowId?: string }[]
  preview: boolean
  sketch: ParsedSketch | null
  send?: SendSetting
}

export type CardState = 'waiting' | 'reading' | 'done' | 'failed'
export type SketchState = 'none' | 'drawing' | 'done' | 'failed'

/** What the card tools hand the widget: the card as far as it is read, and where its reading and preview are. */
export type CardOutput = WidgetCard & { version?: number; state?: CardState; sketchState?: SketchState }

export type Selections = Record<string, number[]>
export type FollowUp = { text: string; decisions: string[]; extra: string; openChoices?: string[] }

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

export function cardPlan(rows: WidgetRow[], picks: Selections, send: SendSetting = DEFAULT_SEND) {
  const decisions: string[] = []
  const openChoices: string[] = []
  for (const row of rows) {
    const repo = row.origin === 'repo' || row.files !== undefined
    const order = row.key === STEP_ORDER_KEY
    const defaultIsOpen = row.openOnSend
    const assumed = !repo && row.assumed.length && (row.learned || order || send === 'all' && !defaultIsOpen) ? row.assumed : undefined
    const selected = picks[row.id] ?? assumed
    if (selected !== undefined) decisions.push(choiceLine(row, selected))
    else if (defaultIsOpen || send === 'open' && !order) openChoices.push(openChoiceLine(row))
  }
  return { decisions, openChoices }
}

/** The preview as it travels with a prompt: the same words the Claude Code and Codex composers use. */
export function targetLines(sketch: ParsedSketch): string {
  return `Target output, as sketched (${sketch.title}):\n\`\`\`text\n${sketch.lines.join('\n')}\n\`\`\``
}

/**
 * Go ahead carries the choices for this send setting, the note, and the preview for those choices.
 * Use as written sends the prompt alone.
 */
export function composeFollowUp(rows: WidgetRow[], picks: Selections, note: string, asWritten = false,
  sketch: ParsedSketch | null = null, send: SendSetting = DEFAULT_SEND,
  fileReferences: WidgetCard['fileReferences'] = []): FollowUp {
  if (asWritten) return { text: AS_WRITTEN, decisions: [], extra: '' }
  const { decisions, openChoices } = cardPlan(rows, picks, send)
  const unresolved = fileReferences.filter((ref) => ref.rowId === undefined || picks[ref.rowId] === undefined)
  if (unresolved.length) decisions.push(decisionLine(fileReferenceDecision(unresolved)))
  const open = openChoicesBlock(openChoices)
  const extra = note.trim().replace(/\s*[\r\n]+\s*/g, ' ')
  const target = sketch?.lines.length ? targetLines(sketch) : null
  const text = decisions.length || open || extra || target ? [
    WITH_EDITS,
    ...(decisions.length ? [`Decisions:\n${decisions.map((line) => `- ${line}`).join('\n')}`] : []),
    ...(open ? [open] : []),
    ...(extra ? [`Also: ${extra}`] : []),
    ...(target ? [target] : []),
  ].join('\n\n') : AS_WRITTEN
  return { text, decisions, extra, ...(openChoices.length && { openChoices }) }
}

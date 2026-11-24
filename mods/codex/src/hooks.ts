// Codex hooks. On each prompt: note the turn (for the composer) and ask the agent to mark
// the choices it makes for the person, as in Claude Code. When the turn stops: the receipt.

import { parseBlanks } from '../../claude-code/core/card'
import { startsSomethingNew } from '../../claude-code/core/kickoff'
import { ASSETS } from '../../claude-code/hooks/assets'
import { PATHS, readJson, readSettings, sessionSource, turnMessages, writeJson } from './store'
import type { TurnRecord } from './store'

export type PromptInput = { session_id?: string; turn_id?: string; transcript_path?: string; cwd?: string; prompt?: string }
export type StopInput = { session_id?: string; turn_id?: string; transcript_path?: string; last_assistant_message?: string | null }

/** The Decisions block MarginCue appends to a prompt, as its lines. */
export function decisionsOf(prompt: string): string[] {
  const at = prompt.lastIndexOf('\nDecisions:\n')
  if (at < 0) return []
  return prompt.slice(at + '\nDecisions:\n'.length).split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim())
}

/**
 * Where the card could not be seen before sending (the Codex desktop app, the IDE, or a prompt sent
 * without ctrl+g), the agent opens its reply with it, then works on.
 */
export const READING_FIRST = [
  "# MarginCue's card (the user did not see it before sending)",
  '',
  "Open your reply with MarginCue's card, in at most four short lines, then carry on with the work without waiting for an answer:",
  '- "Reading:" what you will deliver and how you take the request (its scope; whether the cases it lists are the whole job or examples).',
  '- "Not in the code:" only when the prompt names something the repository does not have: that name, and the closest names that exist.',
  '- The choices the prompt leaves open that you settle now, each marked as described in "Choices you make for the user".',
].join('\n')

const COMPOSED_FRESH_MS = 10 * 60 * 1000

/** Whether the prompt went through the composer, whose card the person saw. */
function composed(prompt: string): boolean {
  const last = readJson<{ text: string; at: number } | null>(PATHS.composed, null)
  return Boolean(last && last.text.trim() === prompt.trim() && Date.now() - last.at < COMPOSED_FRESH_MS)
}

export function promptHook(input: PromptInput): object | null {
  // MarginCue's own readings run through Codex too; they are not the person's turns.
  if (process.env['MARGINCUE_READER']) return null
  const settings = readSettings()
  if (settings.mode === 'off') return null
  const prompt = input.prompt ?? ''
  const source = input.transcript_path ? sessionSource(input.transcript_path) : 'unknown'
  // A scripted run (codex exec) has nobody to switch a choice: its output stays exactly as it would be without MarginCue.
  if (source === 'exec') return null
  const previous = readJson<TurnRecord | null>(PATHS.turn, null)
  if (input.turn_id && input.transcript_path && input.cwd) {
    const record: TurnRecord = {
      session: input.session_id ?? '', turn: input.turn_id, transcript: input.transcript_path, cwd: input.cwd,
      startedAt: Date.now(), endedAt: null, decisions: decisionsOf(prompt), source,
    }
    try {
      writeJson(PATHS.turn, record)
    } catch {}
  }
  const context: string[] = []
  if (settings.blanks !== false && ASSETS.blanksProtocol) context.push(ASSETS.blanksProtocol)
  // A long prompt is judged by how it opens.
  const opening = prompt.trim().split(/\s+/).slice(0, 60).join(' ')
  const firstOfSession = !previous || previous.session !== (input.session_id ?? '')
  if (settings.mode !== 'quiet' && !prompt.startsWith('Amendment to my last prompt:') && !composed(prompt) &&
    startsSomethingNew(opening, { firstOfSession })) context.push(READING_FIRST)
  if (!context.length) return null
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n\n') } }
}

export function stopHook(input: StopInput): object | null {
  if (process.env['MARGINCUE_READER']) return null
  const settings = readSettings()
  if (settings.mode === 'off' || !input.turn_id) return null
  if (input.transcript_path && sessionSource(input.transcript_path) === 'exec') return null
  const record = readJson<TurnRecord | null>(PATHS.turn, null)
  const mine = record?.turn === input.turn_id ? record : null
  if (mine) {
    mine.endedAt = Date.now()
    try {
      writeJson(PATHS.turn, mine)
    } catch {}
  }
  const messages = input.transcript_path ? turnMessages(input.transcript_path, input.turn_id) : []
  if (input.last_assistant_message) messages.push(input.last_assistant_message)
  const chosen = new Map<string, string>()
  for (const message of messages) for (const blank of parseBlanks(message)) chosen.set(blank.label, blank.choice)
  const yours = mine?.decisions.length ?? 0
  if (!chosen.size && !yours) return null
  return { systemMessage: receiptLine(yours, [...chosen].map(([label, choice]) => `${label}: ${choice}`)) }
}

export function receiptLine(yours: number, agent: string[]): string {
  const parts = [`MarginCue · you set ${yours} · the agent chose ${agent.length}`]
  if (agent.length) parts.push(agent.join(' · '), 'ctrl+g to switch one')
  return parts.join(' — ')
}

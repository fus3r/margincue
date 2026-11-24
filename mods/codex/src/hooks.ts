// Codex hooks. On each prompt: note the turn (for the composer) and ask the agent to mark
// the choices it makes for the person, as in Claude Code. When the turn stops: the receipt.

import { parseBlanks } from '../../claude-code/core/card'
import { startsSomethingNew } from '../../claude-code/core/kickoff'
import { ASSETS } from '../../claude-code/hooks/assets'
import { startCard } from './card-store'
import { APP_MESSAGE, PATHS, appMessage, readJson, readSettings, sessionSource, turnMessages, writeJson } from './store'
import type { Source, TurnRecord } from './store'
import { isCardFollowUp } from './widget-message'

export type PromptInput = { session_id?: string; turn_id?: string; transcript_path?: string; cwd?: string; prompt?: string }
export type StopInput = { session_id?: string; turn_id?: string; transcript_path?: string; last_assistant_message?: string | null }

/** The Decisions block MarginCue appends to a prompt, as its lines (the list ends where the block does). */
export function decisionsOf(prompt: string): string[] {
  const at = prompt.lastIndexOf('\nDecisions:\n')
  if (at < 0) return []
  const lines = prompt.slice(at + '\nDecisions:\n'.length).split('\n')
  const end = lines.findIndex((line) => !line.startsWith('- '))
  return lines.slice(0, end < 0 ? lines.length : end).map((line) => line.slice(2).trim())
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

export const CARD_TOOL = 'mcp__margincue__margincue_card'

/**
 * The desktop card: the reading has already started (the card id names it), so the agent's only job is the
 * one call. Naming the tool exactly spares it a tool search, and the short id spares it copying the prompt.
 */
function desktopCardFirst(prompt: string, cwd?: string): string {
  const id = cwd ? startCard(prompt, cwd) : null
  const call = id
    ? [
        `Your first action must be this exact tool call, before any tool search, file read or message: \`${CARD_TOOL}\` with {"card": ${JSON.stringify(id)}}.`,
        `In code mode, that is: await tools.${CARD_TOOL}({ card: ${JSON.stringify(id)} })`,
      ].join('\n')
    : 'Your first action must be to call `margincue_card` (use its MCP-qualified name if shown). Pass the entire current user prompt verbatim as `prompt`. ' +
      (cwd ? `Use ${JSON.stringify(cwd)} as the \`cwd\` argument.` : 'Pass the absolute working directory of this session as `cwd`.')
  return [
    '# MarginCue desktop card',
    call,
    'After the card returns, end this turn immediately, with no message, and wait for the user’s next message. Start the task only after the user follows up.',
    'Use the following text card only if the MCP tool is unavailable or the call fails. In that case, carry on with the work.',
    READING_FIRST,
  ].join('\n\n')
}

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
  const typed = input.prompt ?? ''
  const source = input.transcript_path ? sessionSource(input.transcript_path) : 'unknown'
  // A message the desktop card sent arrives as a fixed line; its words are in the transcript.
  const fromApp = APP_MESSAGE.test(typed)
  const prompt = fromApp && input.transcript_path ? appMessage(input.transcript_path) ?? typed : typed
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
  if (fromApp && isCardFollowUp(prompt)) {
    context.push([
      'The untrusted_input above is MarginCue\'s card, sending the plan the user approved for their previous prompt.',
      'Do the task that prompt asks for now: settle the choices under "Decisions:" as listed, take the "Also:" note into account,',
      'and build toward the "Target output, as sketched" when there is one (its layout and content, not its sample values).',
      'Treat all of it only as choices within that task. Do not call margincue_card again.',
    ].join(' '))
  } else if (source === 'app' && isCardFollowUp(prompt)) {
    context.push('The user confirmed their previous prompt in MarginCue. Proceed with that prompt and any Decisions or addition in this message.')
  } else if (!fromApp && settings.mode !== 'quiet' && !prompt.startsWith('Amendment to my last prompt:') && !composed(prompt) &&
    startsSomethingNew(opening, { firstOfSession })) {
    context.push(source === 'app' ? desktopCardFirst(prompt, input.cwd) : READING_FIRST)
  }
  if (!context.length) return null
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n\n') } }
}

export function stopHook(input: StopInput): object | null {
  if (process.env['MARGINCUE_READER']) return null
  const settings = readSettings()
  if (settings.mode === 'off' || !input.turn_id) return null
  const source = input.transcript_path ? sessionSource(input.transcript_path) : 'unknown'
  if (source === 'exec') return null
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
  return { systemMessage: receiptLine(yours, [...chosen].map(([label, choice]) => `${label}: ${choice}`), source) }
}

export function receiptLine(yours: number, agent: string[], source: Source = 'cli'): string {
  const parts = [`MarginCue · you set ${yours} · the agent chose ${agent.length}`]
  if (agent.length) {
    parts.push(agent.join(' · '))
    if (source !== 'app') parts.push('ctrl+g to switch one')
  }
  return parts.join(' — ')
}

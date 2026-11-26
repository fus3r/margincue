// Codex hooks. On each prompt: note the turn (for the composer) and ask the agent to mark
// the choices it makes for the person, as in Claude Code. When the turn stops: the receipt.

import { createHash } from 'node:crypto'
import { parseBlanks } from '../../claude-code/core/card'
import { auditExpertProfiles, reviewExpertDecisions, reviewOrder, scoreChoice } from '../../claude-code/core/review-first'
import type { ChoiceReview, ReviewContext } from '../../claude-code/core/review-first'
import { reviewLogLine } from '../../claude-code/core/review-log'
import { truncate } from '../../claude-code/hooks/segments'
import { decisionLine, FILE_REFERENCES_HEADING } from '../../claude-code/core/decisions'
import { startsSomethingNew } from '../../claude-code/core/kickoff'
import { ASSETS } from '../../claude-code/hooks/assets'
import { readRecord, startCard } from './card-store'
import { cardConfig } from './card-config'
import { APP_MESSAGE, PATHS, appMessage, appendReviewLog, auditEnabled, readJson, readLearned, readSettings, sessionSource, turnMessages, writeJson } from './store'
import { turnAmendments } from './turn-card'
import type { ComposedPrompt, Settings, Source, TurnRecord } from './store'
import { isCardFollowUp } from './widget-message'

export type PromptInput = { session_id?: string; turn_id?: string; transcript_path?: string; cwd?: string; prompt?: string }
export type StopInput = { session_id?: string; turn_id?: string; transcript_path?: string; cwd?: string; last_assistant_message?: string | null }

/** The Decisions block MarginCue appends to a prompt, as its lines (the list ends where the block does). */
export function decisionsOf(prompt: string): string[] {
  const at = prompt.lastIndexOf('\nDecisions:\n')
  if (at < 0) return []
  const lines = prompt.slice(at + '\nDecisions:\n'.length).split('\n')
  const end = lines.findIndex((line) => !line.startsWith('- '))
  return lines.slice(0, end < 0 ? lines.length : end).map((line) => line.slice(2).trim()).filter((line) => !line.startsWith(FILE_REFERENCES_HEADING))
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
  '- "Which file:" when a name written as code still matches two to four files after checking the draft and repository. List the candidate paths, and mark the file choice as described in "Choices you make for the user" if you can settle it.',
  '- The choices the prompt leaves open that you settle now, each marked as described in "Choices you make for the user".',
].join('\n')

export const CARD_TOOL = 'mcp__margincue__margincue_card'

/**
 * Naming the desktop card tool exactly spares a tool search, and the id spares copying the prompt.
 */
function desktopCardFirst(settings: Settings, id: string | null, cwd?: string): string {
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
    ...(settings.read === 'key'
      ? ['If the MCP tool is unavailable or the call fails, carry on with the prompt as written.']
      : ['Use the following text card only if the MCP tool is unavailable or the call fails. In that case, carry on with the work.', READING_FIRST]),
  ].join('\n\n')
}

const COMPOSED_FRESH_MS = 10 * 60 * 1000

/** Whether the prompt went through the composer, whose card the person saw. */
function composed(prompt: string): ComposedPrompt | null {
  const last = readJson<ComposedPrompt | null>(PATHS.composed, null)
  return last && last.text.trim() === prompt.trim()
    && Date.now() - last.at < COMPOSED_FRESH_MS ? last : null
}

function reviewContext(prompt: string, seen: ComposedPrompt | null, previous: TurnRecord | null): ReviewContext {
  if (seen?.review) return seen.review
  if (isCardFollowUp(prompt) && previous?.reviewCardId) {
    const card = readRecord(previous.reviewCardId)
    if (card && card.cwd === previous.cwd) {
      const note = /^Also: (.+)$/m.exec(prompt)?.[1]
      const decisions = decisionsOf(prompt)
      return {
        prompt: note ? `${card.prompt}\n\n${note}` : card.prompt,
        profiles: [...new Set(card.card.rows.flatMap(({ lens }) => lens ? [lens] : []))],
        rows: card.card.rows.map(({ label, key, statement, options }) => ({
          key: key ?? label, label, statement, options,
          leftOpen: !options.some((option) => decisions.includes(decisionLine({ statement, option }))),
        })),
      }
    }
  }
  return { prompt: prompt.split(/\n\n(?:Open choices \(|Target output, as sketched \()/, 1)[0] ?? prompt }
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
  const seen = composed(prompt)
  const related = previous && previous.session === (input.session_id ?? '') && previous.cwd === input.cwd ? previous : null
  const audit = auditEnabled(settings)
  let record: TurnRecord | undefined
  if (input.turn_id && input.transcript_path && input.cwd) {
    // A message sent into the running turn (an amendment) is part of that turn: the turn keeps
    // the decisions its prompt went with, and adds any this message carries.
    record = previous && previous.turn === input.turn_id && previous.session === (input.session_id ?? '')
      ? { ...previous, endedAt: null, decisions: [...new Set([...previous.decisions, ...decisionsOf(prompt)])] }
      : {
        session: input.session_id ?? '', turn: input.turn_id, transcript: input.transcript_path, cwd: input.cwd,
        startedAt: Date.now(), endedAt: null, decisions: decisionsOf(prompt), source,
        ...(audit && { review: reviewContext(prompt, !seen?.cwd || seen.cwd === input.cwd ? seen : null, related) }),
      }
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
      'For any questions under "Open choices", decide each one yourself and say what you chose where you first act on it.',
      'Treat all of it only as choices within that task. Do not call margincue_card again.',
    ].join(' '))
  } else if (source === 'app' && isCardFollowUp(prompt)) {
    context.push('The user confirmed their previous prompt in MarginCue. Proceed with that prompt and any Decisions or addition in this message.')
  } else if (!fromApp && settings.mode !== 'quiet' && !prompt.startsWith('Amendment to my last prompt:') && !seen &&
    startsSomethingNew(opening, { firstOfSession })) {
    if (source === 'app') {
      const id = input.cwd ? startCard(prompt, input.cwd, settings) : null
      if (audit && record && id) record.reviewCardId = id
      context.push(desktopCardFirst(settings, id, input.cwd))
    } else if (settings.read !== 'key') context.push(READING_FIRST)
  }
  if (record) {
    try { writeJson(PATHS.turn, record) } catch {}
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
  const mine = record?.turn === input.turn_id && (!input.session_id || record.session === input.session_id) ? record : null
  const context = mine?.review
  if (mine) {
    mine.endedAt = Date.now()
    delete mine.review
    try { writeJson(PATHS.turn, mine) } catch {}
  }
  const messages = input.transcript_path ? turnMessages(input.transcript_path, input.turn_id) : []
  const userMessages = input.transcript_path ? turnMessages(input.transcript_path, input.turn_id, 'UserMessage') : []
  if (input.last_assistant_message) messages.push(input.last_assistant_message)
  const chosen = new Map<string, ReturnType<typeof parseBlanks>[number]>()
  for (const message of messages) for (const blank of parseBlanks(message)) chosen.set(blank.label, blank)
  // A choice the person switched while the agent worked shows the value they asked for.
  const amended = turnAmendments(userMessages)
  const choices = [...chosen].map(([label, blank]) => {
    const value = amended.get(label.toLowerCase())
    const options = [...new Set([blank.choice, ...blank.alternatives, ...(value === undefined ? [] : [value])])]
    return { label, value: value ?? blank.choice, switched: value !== undefined, options }
  })
  const yours = mine?.decisions.length ?? 0
  if (!chosen.size && !yours) return null
  if (!auditEnabled(settings)) return { systemMessage: receiptLine(yours, choices, source) }
  const root = mine?.cwd ?? input.cwd ?? ''
  const submitted = context ?? reviewContext(userMessages[0] ?? '', null, null)
  const depths = cardConfig(settings).depths ?? {}
  const reviewInput: ReviewContext = {
    ...submitted, learned: root ? readLearned(root) : {},
    expert: reviewExpertDecisions(ASSETS.bundles ?? [], [...new Set([...submitted.profiles ?? [], ...auditExpertProfiles(submitted.prompt)])], 'en',
      (profile) => depths[profile] ?? 'standard'),
  }
  const scored = choices.map((choice) => ({ ...choice, review: scoreChoice(choice, reviewInput) }))
  if (root) {
    try {
      const hash = createHash('sha256').update(root).digest('hex')
      appendReviewLog(reviewLogLine(input.turn_id, 'codex', hash, submitted.prompt, scored))
    } catch {}
  }
  return { systemMessage: receiptLine(yours, scored, source) }
}

export function receiptLine(yours: number, agent: { label: string; value: string; switched?: boolean;
  options?: string[]; review?: ChoiceReview }[], source: Source = 'cli'): string {
  const switched = agent.filter((choice) => choice.switched).length
  const flagged = agent.filter((choice) => choice.review?.flagged).length
  const parts = [`MarginCue · you set ${yours} · the agent chose ${agent.length}${switched ? ` · you switched ${switched}` : ''}${flagged ? ` · ${flagged} to review first` : ''}`]
  if (agent.length) {
    const format = ({ label, value, switched }: typeof agent[number]) => `${label}: ${value}${switched ? ' (switched)' : ''}`
    const ordered = flagged ? reviewOrder(agent) : agent
    if (flagged) parts.push(`Review first: ${ordered.slice(0, flagged).map((choice) => {
      const review = choice.review!
      const alternatives = choice.options?.filter((option) => option !== choice.value).map((option) => `→ ${option}`) ?? []
      return `${format(choice)} (${[truncate(review.reason, 59), review.evidence, ...alternatives].join(' · ')})`
    }).join(' · ')}`)
    if (ordered.length > flagged) parts.push(ordered.slice(flagged).map(format).join(' · '))
    // Under margincue-relay the agent's choices are already listed under Codex's prompt.
    if (source === 'cli' || source === 'unknown') {
      parts.push(process.env['MARGINCUE_CARD'] === 'prompt' ? 'alt+↓ under the prompt to switch one' : 'ctrl+g to switch one')
    }
  }
  return parts.join(' — ')
}

import { resolveAnchor } from './anchor'
import type { Span } from './anchor'
import { isId } from './bundle'
import type { Slot } from './bundle'
import { normalizeTopic } from './chapters'
import type { ExpertItem } from './types'

export const MAX_EXPERT_CUES = 2
const MAX_CHOICE_LABEL = 40

type ExistingRow = { key: string; statement: string; options: string[] }

export function expertCardContext(rows: readonly ExistingRow[]): string {
  if (!rows.length) return ''
  return [
    'Decisions already on the card (key, statement, options). Skip the same choice even if you would word it differently:',
    ...rows.map(({ key, statement, options }) => JSON.stringify({ key, statement, options })),
  ].join('\n')
}

export function expertPrompt(catalog: ExpertItem[], slots: Slot[]): string {
  if (!catalog.length) return ''
  const definitions = new Map(slots.map((slot) => [slot.id, slot]))
  return [
    'Candidate catalog: for an applicable, unsettled entry below, start the line with `catalog |`, then give the anchor field and the exact supplied key, separated by a pipe.',
    ...catalog.map((item) => {
      const slot = definitions.get(item.key)!
      return [item.key, `when: ${slot.when}`, `settled: ${slot.settled}`,
        `${item.statement} | ${item.options.map((o) => o.label).join(' | ')}`].join('\n')
    }),
  ].join('\n\n')
}

export function parseExpert(
  reply: string, draft: string, catalog: ExpertItem[], reserved: (key: string) => boolean,
): ExpertItem[] {
  const known = new Map(catalog.map((item) => [item.key, item]))
  const seen = new Set<string>()
  const out: ExpertItem[] = []
  for (const line of reply.split(/\r?\n/)) {
    if (line.trim() === 'NONE') break
    const text = line.trim().replace(/^[-*+]\s+(?=[^|])/, '')
    const [first = '', ...fields] = text.split('|').map((s) => s.trim())
    let item = first === 'choice' ? undefined : parseLegacyChoice(first, fields, draft, known, reserved)
    if (!item && first !== 'catalog' && !/^(?:[#<>`~]|\|.*\|$)/.test(text)) {
      const choice = first === 'choice' ? fields : [first, ...fields]
      item = parseChoice(choice.filter(Boolean), draft, reserved)
    }
    if (!item || seen.has(item.key)) continue
    const { statement, options } = item
    // A catalog key may be followed by its statement and options on a second line.
    if (!item.persistent && out.some((row) => row.persistent && row.statement === statement &&
      row.options.length === options.length && row.options.every((option, i) => option.label === options[i]!.label))) continue
    out.push(item)
    seen.add(item.key)
  }
  return out
}

function parseChoice(fields: string[], draft: string, reserved: (key: string) => boolean): ExpertItem | undefined {
  const statementIndex = fields.findIndex((field) => field.includes('{}'))
  if (statementIndex < 0) return
  const statement = fields[statementIndex]!
  let span: Span | null = null
  let label = ''
  for (const field of fields.slice(0, statementIndex)) {
    const match = resolveAnchor(draft, field.replace(/^@/, ''))
    if (match) span ??= match
    else if (!field.startsWith('@') && field.length <= MAX_CHOICE_LABEL) label = field
  }

  const options: { label: string; marked: boolean }[] = []
  for (const field of fields.slice(statementIndex + 1)) {
    const match = field.startsWith('@') ? resolveAnchor(draft, field.slice(1)) : null
    if (match || field === '@' || field.startsWith('@ ')) {
      span ??= match
      continue
    }
    const value = field.replace(/\*$/, '').trimEnd()
    if (value) options.push({ label: value, marked: field.endsWith('*') })
  }
  // A bare phrase among the options is ambiguous. Use it as an anchor only
  // when it is the sole match and two options remain.
  if (!span && options.length > 2) {
    const matches = options.flatMap(({ label, marked }, i) => {
      const match = marked ? null : resolveAnchor(draft, label)
      return match ? [{ i, span: match }] : []
    })
    if (matches.length === 1) {
      span = matches[0]!.span
      options.splice(matches[0]!.i, 1)
    }
  }
  if (options.length < 2) return

  const subject = statement.replaceAll('{}', ' ').replace(/\s+/g, ' ').trim().replace(/\s*[:;,.!?]+$/, '') || statement
  label ||= subject
  let key = choiceKey(label)
  // Draft choices can overlap catalog wording without taking a catalog key.
  if (reserved(key)) key = choiceKey(subject)
  if (reserved(key)) key = `choice_${key}`
  const defaultIndex = options.findIndex((option) => option.marked)
  return {
    ...reviewChoice(key, label, statement, options.map((option) => option.label), span),
    ...(defaultIndex >= 0 && { defaultIndex }),
  }
}

function parseLegacyChoice(
  first: string, fields: string[], draft: string, known: Map<string, ExpertItem>, reserved: (key: string) => boolean,
): ExpertItem | undefined {
  const tagged = first === 'catalog'
  const [anchor = '', rawKey, statement, ...options] = tagged ? fields : [first, ...fields]
  const span = anchor && (tagged || anchor !== '-') ? resolveAnchor(draft, anchor) : null
  const anchored = !anchor || !tagged && anchor === '-' || span !== null
  // Catalog keys can stand alone or lead a line with a repeated choice, note or anchor.
  const item = tagged && anchored && fields.length === 2 ? known.get(rawKey!)
    : tagged ? undefined : (anchored && rawKey ? known.get(rawKey) : undefined) ?? known.get(anchor)
  if (item) {
    const location = anchored && item.key === rawKey ? span : rawKey && statement === undefined ? resolveAnchor(draft, rawKey) : null
    return { ...item, ...(location && { span: location }) }
  }
  if (tagged || !anchored || !rawKey || !statement || statement.split('{}').length !== 2 ||
    options.length < 2 || options.length > 3 || options.some((o) => !o) ||
    new Set(options.map((o) => o.toLowerCase())).size !== options.length) return
  const label = rawKey === 'new_key' ? statement.replace('{}', '').trim() : rawKey.replace(/[_-]/g, ' ')
  const key = rawKey === 'new_key' ? choiceKey(label) : rawKey
  if (isId(key) && !reserved(key)) return reviewChoice(key, label, statement, options, span)
}

function reviewChoice(key: string, label: string, statement: string, options: string[], span: Span | null): ExpertItem {
  return {
    key, slot: key, persistent: false, label, statement,
    options: options.map((label, i) => ({ id: String(i), label })),
    scope: 'session', guard: false, why: '', source: '', ...(span && { span }),
  }
}

function choiceKey(label: string): string {
  const words = normalizeTopic(label)
  const key = words.replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '_').slice(0, 40)
  if (isId(key)) return key
  let hash = 0
  for (const char of words) hash = Math.imul(hash, 31) + char.codePointAt(0)! | 0
  return `choice_${(hash >>> 0).toString(36)}`
}

// A few operational concepts have different nouns in the question and the
// answer. Require both the decision topic and its relevant trade-off.
const DECISION_TOPICS = [
  [/\b(?:confidence )?interval\b/, /\b(?:holdout|hold out|resampling|bootstrap)\b/],
  [/\bretr(?:y|ied|ies)\b/, /\b(?:idempoten\w*|dedup\w*|retry safe)\b/],
  [/\b(?:limit\w*|capacity|quota)\b/, /\bper (?:plan|tier)\b/],
  [/\b(?:sli|success ratio|count an error|availability indicator)\b/],
  [/\b(?:invite|email)\b.*\b(?:send\w*|deliver\w*|reconcil\w*)\b|\b(?:send\w*|deliver\w*)\b.*\b(?:invite|email)\b/,
    /\b(?:exactly once|idempotent|reconciliation)\b/],
]
const FILLER = new Set('a all also an and both by define each for from is of on only pick same select set the to use using which with'.split(' '))

function nouns(text: string): Set<string> {
  return new Set(normalizeTopic(text).split(' ')
    .map((word) => word.length > 4 ? word.replace(/(?:ies|s)$/, (end) => end === 'ies' ? 'y' : '') : word)
    .filter((word) => word.length > 2 && !FILLER.has(word)))
}

export function nearExpertDecision(card: ExistingRow, choice: ExistingRow): boolean {
  const cardTopic = normalizeTopic(`${card.key} ${card.statement} ${card.options.join(' ')}`)
  const choiceTopic = normalizeTopic(`${choice.key} ${choice.statement} ${choice.options.join(' ')}`)
  if (DECISION_TOPICS.some((topic) => topic.every((pattern) => pattern.test(cardTopic) && pattern.test(choiceTopic)))) return true
  const subject = nouns(`${choice.key} ${choice.statement}`)
  const sharedSubject = [...nouns(`${card.key} ${card.statement}`)].filter((noun) => subject.has(noun))
  const options = nouns(choice.options.join(' '))
  return sharedSubject.length >= 2 && [...nouns(card.options.join(' '))].some((noun) => options.has(noun))
}

import { resolveAnchor } from './anchor'
import { isId } from './bundle'
import type { Slot } from './bundle'
import { normalizeTopic } from './chapters'
import type { ExpertItem } from './types'

export const MAX_EXPERT_CUES = 2

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
    const [first = '', ...fields] = line.trim().replace(/^[-*+]\s+(?=[^|])/, '').split('|').map((s) => s.trim())
    const tagged = first === 'choice' || first === 'catalog'
    const [anchor = '', rawKey, statement, ...options] = tagged ? fields : [first, ...fields]
    const span = anchor && (tagged || anchor !== '-') ? resolveAnchor(draft, anchor) : null
    const anchored = !anchor || !tagged && anchor === '-' || span !== null
    // Catalog keys can stand alone or lead a line with a repeated choice, note or anchor.
    const item = first === 'catalog' && anchored && fields.length === 2 ? known.get(rawKey!)
      : tagged ? undefined : (anchored && rawKey ? known.get(rawKey) : undefined) ?? known.get(anchor)
    if (item) {
      if (seen.has(item.key)) continue
      const location = anchored && item.key === rawKey ? span : rawKey && statement === undefined ? resolveAnchor(draft, rawKey) : null
      out.push({ ...item, ...(location && { span: location }) })
      seen.add(item.key)
      continue
    }
    if (first === 'catalog' || !anchored || !rawKey || !statement || statement.split('{}').length !== 2 ||
      options.length < 2 || options.length > 3 || options.some((o) => !o) ||
      new Set(options.map((o) => o.toLowerCase())).size !== options.length) continue
    const label = first === 'choice' ? rawKey : rawKey === 'new_key' ? statement.replace('{}', '').trim() : rawKey.replace(/[_-]/g, ' ')
    const key = first === 'choice' || rawKey === 'new_key' ? choiceKey(label) : rawKey
    if (!isId(key) || seen.has(key) || reserved(key)) continue
    out.push({
      key, slot: key, persistent: false, label, statement,
      options: options.map((label, i) => ({ id: String(i), label })),
      scope: 'session', guard: false, why: '', source: '', ...(span && { span }),
    })
    seen.add(key)
  }
  return out
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

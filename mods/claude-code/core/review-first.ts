import { nearExpertDecision } from './expert'
import { nameKey } from './grounding'
import { isHardToUndo } from './hard-to-undo'
import { normalize } from './parse'
import type { Depth, Language, ProfileBundle } from './bundle'
import { stateCue } from './state'

/** Pilot priors. Tune on real receipts, then freeze the table. */
export const REVIEW_WEIGHTS = {
  chance: { contradiction: 1, learnedConflict: 0.8, silent: 0.5, leftOpen: 0.3, learnedMatch: 0.1, switched: 0 },
  cost: {
    pinned: 9,
    rework: 3,
    // Silence alone does not flag a choice with no link or a nearby local edit.
    unlinked: 2,
    local: 1,
  },
  threshold: 1.5,
} as const

export const LEARNED_AFTER = 2

/** Words that bring an expert profile's decisions into the card, two or more needed. */
const LENS_WORDS: [string, RegExp][] = [
  ['ml-research', /\b(?:train(?:ing)?|dataset|accuracy|auc|cross-?valid\w*|overfit\w*|leak\w*|regression|classif\w*|features?|labels?|benchmark\w*|baselines?|hyperparam\w*|predict\w*|evaluat\w*|metrics?|test set|validation|fine-?tun\w*|embedding\w*)\b/gi],
  ['system-design', /\b(?:services?|queues?|cach\w+|databases?|scal(?:e|ing|ability)|latency|throughput|replica\w*|shard\w*|load balanc\w*|microservices?|kafka|redis|postgres\w*|consistency|availability|rate limit\w*|backpressure|idempoten\w*|retries|webhooks?)\b/gi],
]

export function draftExpertProfiles(text: string): string[] {
  return LENS_WORDS.filter(([, words]) =>
    new Set((text.match(words) ?? []).map((word) => word.toLowerCase())).size >= 2).map(([profile]) => profile)
}

export function auditExpertProfiles(prompt: string): string[] {
  const profiles = draftExpertProfiles(prompt)
  if (/\bbacktests?\b/i.test(prompt) && !profiles.includes('ml-research')) profiles.push('ml-research')
  return profiles
}

export type ReviewDecision = {
  key: string; label: string; statement: string; options: string[]; leftOpen?: boolean; profile?: string
}
export type ReviewContext = {
  prompt: string; profiles?: string[]; rows?: readonly ReviewDecision[]; expert?: readonly ReviewDecision[]
  learned?: Readonly<Record<string, { label: string; count: number }>>
}
export type ReviewChoice = { label: string; value: string; options: string[]; switched?: boolean }
export type ChoiceEdit = {
  path: string; deleted?: boolean; publicInterface?: boolean; dependencies?: boolean
  referencedName?: string; sendsOutside?: boolean
}
type EditLink = { kind: 'named' | 'timing'; edits: readonly ChoiceEdit[] }
export type ReviewEvidence = 'matched edit' | 'nearby edit' | "agent's word"
export type ChoiceReview = {
  signals: {
    contradiction: string | null; learnedConflict: string | null; learnedMatch: boolean
    silent: boolean; leftOpen: boolean; switched: boolean
  }
  d: number; c: number; score: number; pinned: boolean; flagged: boolean
  reason: string; costReason: string; evidence: ReviewEvidence; linkKind: EditLink['kind'] | 'none'; paths: string[]
}

const MIGRATION = /(?:^|\/)(?:migrations?|alembic\/versions)\//i
const SCHEMA = /(?:^|\/)schemas\/|(?:^|[/._-])schemas?(?:\.\w+)?\.(?:json|ya?ml|sql|prisma|graphql|gql|[cm]?[jt]s|py|rb)$|\.(?:prisma|proto)$/
const POLICY = /(?:^|\/)(?:auth|authentication|authorization|permissions?|rbac|security[-_]polic(?:y|ies))\/|(?:^|\/)(?:(?:auth|authentication|authorization|permissions?|rbac|iam|security[-_]policy)(?:[.-](?:config|policy|rules?))?\.[\w.]+|codeowners|firestore\.rules|storage\.rules|\.htaccess)$/
const INTERFACE = /^(?:openapi|swagger)(?:[-.]v?\d+)?\.(?:json|ya?ml)$|\.d\.[cm]?ts$/
const SHARED_CONFIG = /(?:^|\/)(?:\.github\/workflows|\.circleci|\.config|configs?)\/|(?:^|\/)(?:\.gitignore|\.gitattributes|\.editorconfig|\.env(?:\.example)?|dockerfile|(?:docker-)?compose\.ya?ml|(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json|(?:eslint|prettier|vite|webpack|next|babel|jest|vitest)\.config\.[\w.]+|pnpm-workspace\.yaml)$/
const DATA_FORMAT = /^(?:serializ\w*|deserializ\w*|wire[-_]format)\.[\w.]+$|\.(?:csv|tsv|jsonl|ndjson|parquet|avro)$/
const ACCESS_WORDS = /\b(?:access|sign[ -]in|log in|login|logout|sessions?|permissions?|roles?|admin|privileges?|passwords?|tokens?|2fa|mfa|auth|acces|connexion|se connecter|administrateur|mots? de passe|jetons?|authentification)\b/
const ACCESS_CUES = /\b(?:allow|deny|block|grant|revoke|restrict|can|cannot|can['’]t|out of|until|keep|lose|autoriser|refuser|bloquer|accorder|revoquer|restreindre|peut|ne peut pas|garder|perdre)\b/

const WORDS = /don['’]t(?![\p{L}\p{N}_])|[\p{L}\p{N}_]+/gu
const NEGATION = /(?:^| )(?:no|without|don['’]t use|not|avoid|instead of|rather than|except|never|sans|pas(?: de)?|au lieu de|plutot que|jamais)(?: \S+){0,2}$/

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function isMigrationPath(path: string): boolean {
  return MIGRATION.test(path.replace(/\\/g, '/'))
}

function contradiction(prompt: string, value: string, alternatives: string[]): string | null {
  if (!alternatives.length) return null
  const options = [value, ...alternatives].map((option): string[] => fold(option).match(WORDS) ?? [])
  const alts = options.slice(1)
  const shared = new Set(options[0]!.filter((word) => alts.every((option) => option.includes(word))))
  const distinctive = (word: string) => word.length >= 3 && !shared.has(word)
  const submitted = fold(prompt).split(/[.!?,;\r\n]+/).flatMap((clause) => {
    const words = clause.match(WORDS) ?? []
    // Allow up to two intervening words after the negation phrase, including short or shared words.
    return words.flatMap((word, i) => distinctive(word)
      ? [{ word, negated: NEGATION.test(words.slice(Math.max(0, i - 5), i).join(' ')) }] : [])
  })
  const names = (tokens: string[]) => {
    const terms = tokens.filter(distinctive)
    return terms.length > 0 && submitted.some(({ negated }, i) =>
      !negated && terms.every((term, offset) => submitted[i + offset]?.word === term))
  }
  if (names(options[0]!)) return null
  const mentioned = alternatives.filter((_, i) => names(alts[i]!))
  return mentioned.length === 1 ? mentioned[0]! : null
}

function sameDecision(row: ReviewDecision, label: string): boolean {
  const key = nameKey(label)
  return !!key && [row.key, row.label, row.statement].some((part) => nameKey(part) === key)
}

export function reviewExpertDecisions(bundles: readonly ProfileBundle[], profiles: readonly string[],
  language: Language, depthOf: (profile: string) => Depth): ReviewDecision[] {
  return bundles.filter(({ profile }) => profiles.includes(profile)).flatMap(({ profile, slots }) => slots.map((slot) => {
    const cue = stateCue({ slot, options: slot.options }, language, depthOf(profile))
    return { key: slot.id, label: cue.label, statement: cue.statement, options: cue.options.map((option) => option.label), profile }
  }))
}

export function scoreChoice(choice: ReviewChoice, context: ReviewContext, link?: EditLink): ChoiceReview {
  const { label, value, options, switched = false } = choice
  const alternatives = options.filter((option) => normalize(option) !== normalize(value))
  const contradicted = contradiction(context.prompt, value, alternatives)
  const row = context.rows?.find((entry) => sameDecision(entry, label))
  const exactExpert = context.expert?.find((entry) => sameDecision(entry, label))
  const expert = exactExpert ?? context.expert?.find((entry) =>
    (entry.key === 'feature_fallback' && /\b(?:availability|available|timing|point.in.time)\b/i.test(label) &&
      options.some((option) => /\b(?:filing date|publication date|(?:fiscal )?period end|point.in.time)\b/i.test(option))) ||
    nearExpertDecision(entry, { key: label, statement: row?.statement ?? label, options }))
  const learned = context.learned ?? {}
  const habit = [row?.key, exactExpert?.key, ...Object.keys(learned).filter((key) => nameKey(key) === nameKey(label))]
    .filter((key): key is string => key !== undefined)
    .map((key) => Object.hasOwn(learned, key) ? learned[key] : undefined)
    .find((pick) => pick && pick.count >= LEARNED_AFTER)
  const learnedMatch = habit !== undefined && normalize(habit.label) === normalize(value)
  const learnedConflict = habit && !learnedMatch ? habit.label : null
  const silent = row === undefined
  const leftOpen = row?.leftOpen === true
  const signals = { contradiction: contradicted, learnedConflict, learnedMatch, silent, leftOpen, switched }
  const odds = REVIEW_WEIGHTS.chance
  const d = switched ? odds.switched : contradicted ? odds.contradiction : learnedConflict ? odds.learnedConflict
    : learnedMatch ? odds.learnedMatch : silent ? odds.silent : odds.leftOpen
  const edits = link?.edits ?? []
  const linkKind = link?.edits.length ? link.kind : 'none'
  const evidence = linkKind === 'named' ? 'matched edit' : linkKind === 'timing' ? 'nearby edit' : "agent's word"
  const paths = [...new Set(edits.map((edit) => edit.path))]
  const changes = edits.map((edit) => ({ ...edit, file: edit.path.replace(/\\/g, '/').toLowerCase() }))
  const fileName = (file: string) => file.slice(file.lastIndexOf('/') + 1)
  const changesAccess = [value, ...alternatives].some((option) => {
    const wording = fold(option)
    return ACCESS_WORDS.test(wording) && ACCESS_CUES.test(wording)
  })
  const filePin = changes.some((edit) => edit.deleted) ? 'deletes a file'
    : changes.some(({ file }) => isMigrationPath(file) || SCHEMA.test(file)) ? 'changes a migration'
    : changes.some(({ file }) => POLICY.test(file)) ? 'changes access rules'
    : changes.some(({ file, publicInterface }) => publicInterface || INTERFACE.test(fileName(file))) ? 'changes a public interface'
    : changes.some((edit) => edit.sendsOutside) ? 'sends outside' : ''
  const referenced = changes.find((edit) => edit.referencedName)?.referencedName
  const fileRework = changes.some(({ file }) => DATA_FORMAT.test(fileName(file))) ? 'changes a data format'
    : referenced ? `other files use ${referenced}`
    : changes.some((edit) => edit.dependencies) ? 'changes dependencies'
    : changes.some(({ file }) => SHARED_CONFIG.test(file)) ? 'changes shared config' : ''
  const pinnedReason = changesAccess ? 'changes access' : (linkKind === 'named' && filePin) ||
    (isHardToUndo('{}', value) || isHardToUndo(row?.statement ?? `${label}: {}`, value) ? 'hard to undo' : '')
  const detail = (linkKind === 'named' && fileRework) || (expert?.profile ? `◆ ${expert.profile} decision` : '')
  const nearbyRework = linkKind === 'timing' && (filePin !== '' || fileRework !== '')
  const pinned = pinnedReason !== ''
  const cost = REVIEW_WEIGHTS.cost
  const c = pinned ? cost.pinned : detail || nearbyRework ? cost.rework : linkKind === 'named' ? cost.local : cost.unlinked
  const costReason = pinnedReason || detail || (nearbyRework ? 'nearby edit may need rework'
    : linkKind === 'named' ? 'local edit' : linkKind === 'timing' ? 'nearby edit' : 'no related edit')
  const score = Number((d * c).toPrecision(12))
  const flagged = !switched && (pinned || contradicted !== null || score >= REVIEW_WEIGHTS.threshold)
  const reason = contradicted ? `your prompt said "${contradicted}"`
    : pinnedReason || (learnedConflict ? `you usually pick ${learnedConflict}` : (linkKind !== 'timing' && detail) ||
      (silent ? 'not on the card' : leftOpen ? 'you left it open' : learnedMatch ? 'matches your usual pick' : 'on the card'))
  return { signals, d, c, score, pinned, flagged, reason, costReason, evidence, linkKind, paths }
}

export function reviewOrder<T extends { review?: { flagged: boolean; score: number } }>(choices: readonly T[]): T[] {
  return [...choices.filter((choice) => choice.review?.flagged)
    .sort((a, b) => b.review!.score - a.review!.score), ...choices.filter((choice) => !choice.review?.flagged)]
}

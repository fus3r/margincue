import type { Depth } from './bundle'
import type { CardKind } from './card'

export type ProfileChapter = {
  profile: string
  title: string
  /** Topic phrases normalized at build time. */
  signals: string[]
  notes: Record<Depth, string>
}

export type ChapterView = {
  title: string
  choice: string
  notes: string
  expanded: boolean
  page: number
}

const MAX_CHAPTERS = 2
export const MAX_CHAPTER_NOTE = 700

/** Whole words, with the same treatment of hyphens and accents in authoring and drafts. */
export function normalizeTopic(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''
}

export function normalizeChapterSignal(text: string): string {
  return normalizeTopic(text)
    .replace(/\bidempotent\b/g, 'idempotency')
    .replace(/\b(?:l2 (?:regularization|penalty)|ridge (?:regularization|penalty))\b/g, 'ridge regression')
    .replace(/\bmultiple comparisons?\b/g, 'multiple testing')
    .replace(/\bcross validat(?:e|ed|ing)\b/g, 'cross validation')
    .replace(/\b(?:hold|held) out\b/g, 'holdout')
    .replace(/\btrain and test\b/g, 'train test')
    .replace(/\bleak(?:s|ed|ing)? (?:the |a |target )?labels?\b/g, 'label leakage')
    .replace(/\bfine tun(?:e|ed|ing)\b/g, 'fine tuning')
    .replace(/\bprobabilities\b/g, 'probability')
    .replace(/\binvalidat(?:e|es|ed|ing)\b/g, 'invalidation')
    .replace(/\bmigr(?:e|er|ez|ons) (?:le |un )?schema\b/g, 'migration de schema')
    .replace(/\b(?:shed load|shedding load)\b/g, 'load shedding')
    .replace(/\brate limit(?:ed|ing)\b/g, 'rate limit')
    .replace(/\b(backward)s compatibility\b/g, '$1 compatibility')
    .replace(/\b(retry polic)ies\b/g, '$1y')
    .replace(/\b(retr|deliver)ies\b/g, '$1y')
    .replace(/\b(baselines|budgets|classifiers|datasets|edits|forests|intervals|limits|machines|metrics|replicas|splines|tests)\b/g,
      (word) => word.slice(0, -1))
}

export function chapterContext(
  chapters: readonly ProfileChapter[], draft: string,
  depthOf: (profile: string) => Depth, preferred: readonly string[] = [],
): string {
  return chapterNotes(matchChapters(chapters, draft, preferred), depthOf)
}

const ROUTINE_EDIT = /^(?:fix|rename|format|sort|translate|bump|upgrade|delete|remove|refactor|convert|silence|clean up|replace|corrige|renomme|formate|trie|traduis|supprime)\b/
const ROUTINE_DETAIL = /\b(?:typo|docstring|comment|type hints?|type annotations?|command line (?:arguments?|flags?|options?)|unit tests?|regression tests?|readme|link to|log level|default timeout|error message|(?:response|rate limit) headers?|loading spinner|connection pool from)\b/
const EDIT_DETAIL = /^(?:add|write|update|change|adjust|move|expose|increase|decrease)\b/
const ROUTINE_REQUEST = /^(?:(?:add|ajoute) (?:(?:a|the|un|une) )?(?:feature flag|flag|argument|parameter|parametre)\b|ecris un test de regression\b|update (?:the )?copy\b|make\b.*\b(?:banner text|chart line|helper accept)\b|move\b.*\b(?:config values|files? into)\b)/
const FLAG_ADDITION = /\badd\s+(?:(?:a|the)\s+)?[`'"]?--[\w-]+/i
const SUBSTANTIVE = /^(?:add|analy[sz]e|apply|build|cache|calibrate|check (?:if|whether)|choose|cluster|compare|compute|control|create|decide|define|design|dig into|estimate|evaluate|fine tune|fit|forecast|implement|investigate|let|measure|migrate|move|pick|plan|put|report|retry|roll out|route|run|set|shard|shed|show|split|throttle|train|tune|use|validate|write|work out|ajoute|calcule|choisis|concois|definis|estime|evalue|fais|implemente|mesure|migre|verifie)\b/
const DESIGN_QUESTION = /^(?:(?:how (?:should|can|could) (?:we|i)|comment)\s+(?:build|design|implement|test|compare|measure|choose|handle|evaluate|construire|concevoir|mesurer|evaluer)\b|which\b.*\b(?:hold up|are significant|performs? better)\b)/

/** A reference is earned by the request, even when a reading has yet to start. */
export function matchChapter(
  chapters: readonly ProfileChapter[], draft: string, kind: CardKind | null,
  fields: readonly string[], preferred: readonly string[] = [],
): ProfileChapter | undefined {
  if (!fields.length || !chapters.length || /^\s*[/!#]/.test(draft)) return
  if (kind === 'fix') return
  for (const clause of draft.split(/[\n;,]|(?<=[.!?])\s+/)) {
    const request = normalizeTopic(clause).replace(/^(?:\d+ )?(?:(?:can|could|would|will) you )?(?:please |i (?:want|need) you to |we need to )?/, '')
    if (ROUTINE_EDIT.test(request) || ROUTINE_REQUEST.test(request) || FLAG_ADDITION.test(clause) ||
      EDIT_DETAIL.test(request) && ROUTINE_DETAIL.test(request)) return
    if (kind === 'build' || SUBSTANTIVE.test(request) || DESIGN_QUESTION.test(request)) {
      return matchChapters(chapters.filter((chapter) => fields.includes(chapter.profile)), draft, preferred, true)[0]
    }
  }
}

export function matchChapters(
  chapters: readonly ProfileChapter[], draft: string, preferred: readonly string[] = [],
  requireEvidence = false,
): ProfileChapter[] {
  if (!chapters.length) return []
  const text = ` ${normalizeChapterSignal(draft)} `
  const ranked = chapters.flatMap((chapter) => {
    const signals = [...new Set(chapter.signals.map(normalizeChapterSignal))]
    const hits = signals.filter((signal) => text.includes(` ${signal} `))
    if (!hits.length) return []
    const specificity = Math.max(...hits.map((signal) => signal.split(' ').length))
    if (requireEvidence && specificity < 2 && hits.length < 2) return []
    return [{
      chapter, hits: hits.length, specificity,
      preferred: Number(preferred.includes(chapter.profile)),
    }]
  }).sort((a, b) => b.specificity - a.specificity || b.hits - a.hits || b.preferred - a.preferred)
  return ranked.slice(0, MAX_CHAPTERS).map(({ chapter }) => chapter)
}

export function chapterNotes(chapters: readonly ProfileChapter[], depthOf: (profile: string) => Depth): string {
  if (!chapters.length) return ''
  const notes = chapters.map((chapter) =>
    `[${chapter.profile}] ${chapter.title}\n${chapter.notes[depthOf(chapter.profile)]}`)
  return [
    'Profile chapters matched to the draft. Use the Choice in these level-specific notes to identify what the developer should settle. ' +
      'Use the Theory and Workflow to make the options concrete for the draft.',
    ...notes,
  ].join('\n\n')
}

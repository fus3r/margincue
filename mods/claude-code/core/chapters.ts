import type { Depth } from './bundle'

export type ProfileChapter = {
  profile: string
  title: string
  /** Topic phrases normalized at build time. */
  signals: string[]
  notes: Record<Depth, string>
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
    .replace(/\b(?:shed load|shedding load)\b/g, 'load shedding')
    .replace(/\brate limit(?:ed|ing)\b/g, 'rate limit')
    .replace(/\b(backward)s compatibility\b/g, '$1 compatibility')
    .replace(/\b(retry polic)ies\b/g, '$1y')
    .replace(/\b(retr|deliver)ies\b/g, '$1y')
    .replace(/\b(budgets|classifiers|forests|intervals|limits|machines|metrics|replicas|splines|tests)\b/g,
      (word) => word.slice(0, -1))
}

export function chapterContext(
  chapters: readonly ProfileChapter[], draft: string,
  depthOf: (profile: string) => Depth, preferred: readonly string[] = [],
): string {
  return chapterNotes(matchChapters(chapters, draft, preferred), depthOf)
}

export function matchChapters(
  chapters: readonly ProfileChapter[], draft: string, preferred: readonly string[] = [],
  requireEvidence = false,
): ProfileChapter[] {
  if (!chapters.length) return []
  const text = ` ${normalizeChapterSignal(draft)} `
  const clauses = requireEvidence ? draft.split('\n').map((clause) =>
    normalizeChapterSignal(clause).split(' ').map(signalWord)) : []
  const ranked = chapters.flatMap((chapter) => {
    const signals = [...new Set(chapter.signals.map(normalizeChapterSignal))]
    const exact = signals.filter((signal) => text.includes(` ${signal} `))
    const hits = exact.length >= 2 || exact.some((signal) => signal.includes(' ')) ? exact
      : [...exact, ...signals.filter((signal) => !exact.includes(signal) && phraseNearby(signal, clauses))]
    if (!hits.length) return []
    const specificity = Math.max(...hits.map((signal) => signal.split(' ').length))
    if (requireEvidence && specificity < 2 && hits.length < 2) return []
    return [{
      chapter, hits: hits.length, specificity, exact: exact.length,
      preferred: Number(preferred.includes(chapter.profile)),
    }]
  }).sort((a, b) => b.specificity - a.specificity || b.exact - a.exact || b.hits - a.hits || b.preferred - a.preferred)
  return ranked.slice(0, MAX_CHAPTERS).map(({ chapter }) => chapter)
}

function signalWord(word: string): string {
  return word.replace(/^([a-z]{4,}?)(?:age|ed|ing|s|e)$/, '$1')
}

/** Both words of an authored topic phrase can occur nearby within one request. */
function phraseNearby(signal: string, clauses: string[][]): boolean {
  const words = signal.split(' ')
  if (words.length !== 2 || words.some((word) => word.length < 3)) return false
  const [first, second] = words.map(signalWord)
  return first !== second && clauses.some((clause) => clause.some((word, i) =>
    word === first && clause.slice(Math.max(0, i - 6), i + 7).includes(second!)))
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

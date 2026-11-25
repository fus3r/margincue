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

export function chapterContext(
  chapters: readonly ProfileChapter[], draft: string,
  depthOf: (profile: string) => Depth, preferred: readonly string[] = [],
): string {
  if (!chapters.length) return ''
  const text = ` ${normalizeTopic(draft)} `
  const ranked = chapters.flatMap((chapter) => {
    const hits = chapter.signals.filter((signal) => text.includes(` ${signal} `))
    if (!hits.length) return []
    return [{
      chapter, hits: hits.length, specificity: Math.max(...hits.map((signal) => signal.split(' ').length)),
      preferred: Number(preferred.includes(chapter.profile)),
    }]
  }).sort((a, b) => b.specificity - a.specificity || b.hits - a.hits || b.preferred - a.preferred)
  if (!ranked.length) return ''
  const notes = ranked.slice(0, MAX_CHAPTERS).map(({ chapter }) =>
    `[${chapter.profile}] ${chapter.title}\n${chapter.notes[depthOf(chapter.profile)]}`)
  return [
    'Profile chapters matched to the draft. These notes explain trade-offs. Use them only for a choice the final request still leaves open. ' +
      'Check each option against the available data, permissions and assumptions. Use routine workflow steps as context.',
    ...notes,
    'Check the end of the draft again. A later instruction may have picked one of the options listed earlier. ' +
      'Report that decision in the reading and leave it out of the rows. A chapter can match a topic with no open choice.',
  ].join('\n\n')
}

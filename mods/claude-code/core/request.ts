import type { Example, Profile } from './types'

// The review request. System text in this order, so the fixed part caches:
// prompts/system.md ({{max_cues}} filled in), the profile's rubric, then the
// profile's examples (the base examples are part of system.md). The user
// message is the Status line, the fenced draft (with the Decisions block the
// user has confirmed so far) and, when any, the Dismissed line.

export function buildSystem(systemMarkdown: string, profile: Profile): string[] {
  const base = systemMarkdown.replace(/\r\n?/g, '\n').replace(/\{\{\s*max_cues\s*\}\}/g, String(profile.maxCues)).trim()
  const blocks = [base]
  if (profile.rubric.trim() !== '') blocks.push(profile.rubric.trim())
  if (profile.examples.length > 0) blocks.push(profile.examples.map(formatExample).join('\n\n'))
  return blocks
}

export function formatExample(example: Example): string {
  return [
    'Example',
    `Status: ${example.status ?? 'complete'}`,
    'Draft:',
    '<<<',
    example.draft,
    '>>>',
    'Output:',
    example.output,
  ].join('\n')
}

/** The user message. The core always sends `complete` (contract v1.1): held cues replace the status. */
export function buildPrompt(args: { complete?: boolean; draft: string; dismissed: string[] }): string {
  const lines = [`Status: ${args.complete === false ? 'incomplete' : 'complete'}`, 'Draft:', '<<<', args.draft, '>>>']
  if (args.dismissed.length > 0) lines.push(`Dismissed: ${args.dismissed.join('; ')}`)
  return lines.join('\n')
}

/**
 * Whether the draft's last sentence is terminated: its last visible character
 * is `.`, `?` or `!` (optionally followed by closing quotes or brackets), or
 * it ends with a newline.
 */
export function isTerminated(draft: string): boolean {
  if (/\n[ \t]*$/.test(draft) && draft.trim() !== '') return true
  return /[.?!][)\]"'”’»`*]*\s*$/.test(draft)
}

/** Where the draft's last sentence starts: after the last `.`/`?`/`!` + whitespace, or newline. */
export function lastSentenceStart(draft: string): number {
  let start = 0
  const boundary = /[.?!][)\]"'”’»`*]*\s+|\n/g
  for (let m = boundary.exec(draft); m !== null; m = boundary.exec(draft)) {
    const end = m.index + m[0].length
    if (end < draft.length) start = end
  }
  return start
}

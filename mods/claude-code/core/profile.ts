import type { Example, Profile } from './types'

// A profile is one Markdown file:
//   ---            front matter: name, description, max_cues
//   ## Rubric      what counts as a consequential decision
//   ## Examples    pairs of "### Draft" / "### Output" (optional "### Status")
// A file with no "## " headings is a rubric only.

const DEFAULT_MAX_CUES = 3

export function parseProfile(markdown: string, fallbackName = 'custom'): Profile {
  const source = markdown.replace(/\r\n?/g, '\n')
  const meta: Record<string, string> = {}
  let body = source
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source)
  if (fm) {
    body = source.slice(fm[0].length)
    for (const line of (fm[1] ?? '').split('\n')) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line)
      if (m && m[1] !== undefined) meta[m[1].toLowerCase()] = unquote(m[2] ?? '')
    }
  }

  const maxCues = parseInt(meta['max_cues'] ?? '', 10)
  const profile: Profile = {
    name: meta['name'] || fallbackName,
    description: meta['description'] ?? '',
    maxCues: Number.isFinite(maxCues) && maxCues > 0 ? maxCues : DEFAULT_MAX_CUES,
    rubric: '',
    examples: [],
  }

  const sections = splitHeadings(body, 2)
  if (sections.length === 0) {
    profile.rubric = body.trim()
    return profile
  }
  for (const section of sections) {
    const title = section.title.toLowerCase()
    if (title === 'rubric') profile.rubric = section.body.trim()
    else if (title === 'examples') profile.examples = parseExamples(section.body)
  }
  return profile
}

function parseExamples(text: string): Example[] {
  const examples: Example[] = []
  let current: { draft?: string; output?: string; status?: string } = {}
  const flush = () => {
    if (current.draft !== undefined && current.output !== undefined) {
      const example: Example = { draft: current.draft, output: current.output }
      if (current.status === 'complete' || current.status === 'incomplete') example.status = current.status
      examples.push(example)
    }
    current = {}
  }
  for (const section of splitHeadings(text, 3)) {
    const title = section.title.toLowerCase()
    const value = section.body.trim()
    if (title === 'draft') {
      flush()
      current.draft = value
    } else if (title === 'output') {
      current.output = value
    } else if (title === 'status') {
      current.status = value.toLowerCase()
    }
  }
  flush()
  return examples
}

type Section = { title: string; body: string }

/** Sections under headings of exactly `level` hashes; text before the first is dropped. */
function splitHeadings(text: string, level: number): Section[] {
  const marker = '#'.repeat(level) + ' '
  const sections: Section[] = []
  let current: Section | null = null
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && line.startsWith(marker)) {
      if (current) sections.push(current)
      current = { title: line.slice(marker.length).trim(), body: '' }
      continue
    }
    if (current) current.body += line + '\n'
  }
  if (current) sections.push(current)
  return sections
}

function unquote(value: string): string {
  const m = /^(["'])(.*)\1$/.exec(value)
  return m ? (m[2] ?? '') : value
}

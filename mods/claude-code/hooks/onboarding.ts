// The first-run interview: what the person uses coding agents for, how deep they
// are in each field MarginCue has a catalog for, and which choices they want to
// make themselves. Three or four questions in Claude Code's own dialog, one key
// each. The answers stay in the mod's store; nothing is sent anywhere but the
// line that tells each card reading who it is for.

import type { Depth } from '../core/bundle'

export type Level = 'learning' | 'practitioner' | 'expert'
export type UserProfile = {
  /** What they work on: keys of WORK, plus their own words from "Other". */
  work: string[]
  /** Their level per expert profile they work in. */
  levels: Record<string, Level>
  /** The kinds of choices they make themselves (keys of DECIDE); the agent takes the rest. */
  decide: string[]
  note?: string
}
export type Ask = (question: string, options: { options: string[]; header: string; multiSelect?: true }) => Promise<string>

const WORK = [
  { label: 'Apps and products', key: 'apps', words: 'apps and products' },
  { label: 'Data science and ML', key: 'ml', words: 'data science and machine learning', profile: 'ml-research' },
  { label: 'Systems and infrastructure', key: 'systems', words: 'systems and infrastructure', profile: 'system-design' },
  { label: 'Scripts and tooling', key: 'tooling', words: 'scripts and tooling' },
] as const

const LEVELS: Record<string, { field: string; question: string; header: string; options: [string, Level][] }> = {
  'ml-research': {
    field: 'statistics and ML', question: 'How deep are you in statistics and machine learning?', header: 'ML level',
    options: [['Learning (courses or first projects)', 'learning'], ['Practitioner (I train and ship models)', 'practitioner'],
      ['Researcher (I publish or review)', 'expert']],
  },
  'system-design': {
    field: 'system design', question: 'How deep are you in system design?', header: 'Systems',
    options: [['Learning (first services)', 'learning'], ['Practitioner (I run services in production)', 'practitioner'],
      ['Architect (I design for scale)', 'expert']],
  },
}

const DECIDE = [
  { label: 'What gets built', key: 'scope', words: 'what gets built' },
  { label: 'Data and results', key: 'data', words: 'how data and results are handled' },
  { label: 'Architecture', key: 'architecture', words: 'architecture' },
  { label: 'Code details', key: 'code', words: 'code-level details' },
] as const

/** The level as the person picked it: "researcher" in ML, "architect" in system design. */
const levelWord = (profile: string, level: Level) =>
  (LEVELS[profile]?.options.find(([, value]) => value === level)?.[0] ?? level).split(' ')[0]!.toLowerCase()

/** A multi-select answer comes comma-joined; anything that is not one of the labels is the person's own words. */
function picks<T extends { label: string; key: string }>(answer: string, choices: readonly T[]): { keys: string[]; other: string } {
  const keys: string[] = []
  const other: string[] = []
  for (const part of answer.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    const choice = choices.find((c) => c.label.toLowerCase() === part.toLowerCase())
    if (choice) keys.push(choice.key)
    else other.push(part)
  }
  return { keys, other: other.join(', ') }
}

function levelOf(answer: string, options: [string, Level][]): Level {
  const exact = options.find(([label]) => label.toLowerCase() === answer.trim().toLowerCase())
  if (exact) return exact[1]
  if (/\b(phd|research|professor|publish|review|architect|staff|principal|lead)\b/i.test(answer)) return 'expert'
  if (/\b(student|learning|beginner|course|new|first)\b/i.test(answer)) return 'learning'
  return 'practitioner'
}

/** The interview itself. A rejection (the dialog closed) ends it and propagates. */
export async function interview(ask: Ask): Promise<UserProfile> {
  const work = picks(await ask('What do you mostly use coding agents for? Pick any.', {
    options: WORK.map((w) => w.label), header: 'Your work', multiSelect: true,
  }), WORK)
  const levels: Record<string, Level> = {}
  for (const choice of WORK) {
    if (!('profile' in choice) || !work.keys.includes(choice.key)) continue
    const level = LEVELS[choice.profile]!
    levels[choice.profile] = levelOf(await ask(level.question, { options: level.options.map(([label]) => label), header: level.header }), level.options)
  }
  const decide = picks(await ask('Which choices do you want to make yourself? The agent takes the rest.', {
    options: DECIDE.map((d) => d.label), header: 'You decide', multiSelect: true,
  }), DECIDE)
  const note = [work.other, decide.other].filter(Boolean).join('; ')
  return { work: work.keys, levels, decide: decide.keys, ...(note && { note }) }
}

/** How deep a profile's catalog goes and how it is worded, from the person's level in that field. */
export function depthFor(level: Level): Depth {
  return level === 'learning' ? 'essentials' : level === 'expert' ? 'research' : 'standard'
}

/** Profiles the person works in: a project needs less evidence to call for one of these. */
export function preferredProfiles(user: UserProfile): string[] {
  return WORK.flatMap((w) => 'profile' in w && user.work.includes(w.key) ? [w.profile] : [])
}

/** A stored profile, checked before use: anything malformed reads as not set up. */
export function readUser(value: unknown): UserProfile | null {
  const v = value as Partial<UserProfile> | null
  if (!v || typeof v !== 'object' || !Array.isArray(v.work) || !Array.isArray(v.decide) || !v.levels || typeof v.levels !== 'object') return null
  const levels: Record<string, Level> = {}
  for (const [profile, level] of Object.entries(v.levels)) {
    if (level === 'learning' || level === 'practitioner' || level === 'expert') levels[profile] = level
  }
  return {
    work: v.work.filter((w): w is string => typeof w === 'string'), levels,
    decide: v.decide.filter((d): d is string => typeof d === 'string'),
    ...(typeof v.note === 'string' && v.note && { note: v.note }),
  }
}

const list = (items: string[]) => items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** One line about the person, for each card reading (in the cached system text) and for /margincue status. */
export function describeUser(user: UserProfile): string {
  const work = WORK.filter((w) => user.work.includes(w.key)).map((w) => {
    const profile = 'profile' in w ? w.profile : undefined
    const level = profile ? user.levels[profile] : undefined
    return profile && level ? `${w.words} (${LEVELS[profile]!.field}: ${levelWord(profile, level)})` : w.words
  })
  const decides = DECIDE.filter((d) => user.decide.includes(d.key)).map((d) => d.words)
  const leaves = DECIDE.filter((d) => !user.decide.includes(d.key)).map((d) => d.words)
  const parts = [
    work.length ? `Works on ${list(work)}.` : '',
    user.note ? `In their words: ${user.note}.` : '',
    decides.length ? `Makes these choices themselves: ${list(decides)}${leaves.length ? `; leaves ${list(leaves)} to the agent` : ''}.` : '',
  ]
  return parts.filter(Boolean).join(' ')
}

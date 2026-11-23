// The compiled, portable profile format. See spec/profile-bundle.md.
export const BUNDLE_FORMAT = 1
export const SLOT_STATES = ['inapplicable', 'unknown', 'open', 'delegated', 'filled'] as const
export const SCOPES = ['user', 'model', 'project', 'session'] as const
export const MODES = ['off', 'quiet', 'on', 'auto'] as const
export const DEPTHS = ['essentials', 'standard', 'research'] as const
export const RIGORS = ['explore', 'build', 'compete', 'study'] as const
const TIERS = ['essential', 'standard', 'research'] as const

export type SlotState = typeof SLOT_STATES[number]
export type Scope = typeof SCOPES[number]
export type DefaultScope = Exclude<Scope, 'model'>
export type Mode = typeof MODES[number]
export type Depth = typeof DEPTHS[number]
export type Rigor = typeof RIGORS[number]
export type Tier = typeof TIERS[number]
export type Language = 'en' | 'fr'
export type Locale<T> = Record<Language, T>
export type Wording = { plain: string; expert: string }

/** One literal phrase and optional AND groups, each satisfied by any of its phrases. */
export type Pattern = string | { phrase: string; with: string[][] }
export type Rules = {
  match: Pattern[]
  exclude?: string[]
  settled?: string[]
  facts?: Record<string, string[]>
}
export type SlotOption = { id: string; wording: Locale<Wording>; requires?: string }
export type Slot = {
  id: string
  scope: DefaultScope
  frame?: string
  requires?: string[]
  touch: Locale<Rules>
  label: Locale<string>
  statement: Locale<Wording>
  options: SlotOption[]
  tier: Tier
  rigor: Rigor
  guard: boolean
  cost: number
  when: string
  settled: string
  why: string
  source: string
  opens: string[]
}
export type ProfileBundle = {
  formatVersion: typeof BUNDLE_FORMAT
  version: string
  profile: string
  slots: Slot[]
}

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(value)

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''
const phrase = (value: unknown): value is string =>
  nonempty(value) && /[\p{L}\p{N}_]/u.test(value)
const list = <T>(value: unknown, check: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(check)
const includes = (values: readonly string[], value: unknown): value is string =>
  typeof value === 'string' && values.includes(value)
const localized = <T>(value: unknown, check: (entry: unknown) => entry is T): value is Locale<T> =>
  object(value) && check(value.en) && check(value.fr)
const wording = (value: unknown): value is Wording =>
  object(value) && nonempty(value.plain) && nonempty(value.expert)
const statement = (value: unknown): value is Wording =>
  wording(value) && [value.plain, value.expert].every((text) => text.split('{}').length === 2)
const pattern = (value: unknown): value is Pattern =>
  phrase(value) || (object(value) && phrase(value.phrase) &&
    list(value.with, phraseList) && value.with.length > 0)
const phraseList = (value: unknown): value is string[] => list(value, phrase) && value.length > 0
const rules = (value: unknown): value is Rules =>
  object(value) && list(value.match, pattern) &&
  (value.exclude === undefined || list(value.exclude, phrase)) &&
  (value.settled === undefined || list(value.settled, phrase)) &&
  (value.facts === undefined || (object(value.facts) &&
    Object.entries(value.facts).every(([key, phrases]) => isId(key) && phraseList(phrases))))
const option = (value: unknown): value is SlotOption =>
  object(value) && isId(value.id) && value.id !== 'delegated' && value.id !== 'other' &&
  localized(value.wording, wording) && (value.requires === undefined || isId(value.requires))

function slot(value: unknown): value is Slot {
  return object(value) && isId(value.id) && includes(['project', 'user', 'session'], value.scope) &&
    (value.frame === undefined || isId(value.frame)) &&
    (value.requires === undefined || list(value.requires, isId)) &&
    localized(value.touch, rules) && localized(value.label, nonempty) && localized(value.statement, statement) &&
    list(value.options, option) && value.options.length >= 2 && value.options.length <= 8 &&
    new Set(value.options.map((o) => o.id)).size === value.options.length &&
    includes(TIERS, value.tier) && includes(RIGORS, value.rigor) && typeof value.guard === 'boolean' &&
    typeof value.cost === 'number' && Number.isInteger(value.cost) && value.cost >= 1 && value.cost <= 5 &&
    nonempty(value.when) && nonempty(value.settled) && nonempty(value.why) && nonempty(value.source) &&
    list(value.opens, isId)
}

/** Validate before accepting a bundle supplied by a host or user. */
export function readBundle(value: unknown): ProfileBundle | null {
  if (!object(value) || value.formatVersion !== BUNDLE_FORMAT || !nonempty(value.version) ||
    !isId(value.profile) || !list(value.slots, slot) || value.slots.length === 0 ||
    new Set(value.slots.map((s) => s.id)).size !== value.slots.length) return null
  return { formatVersion: BUNDLE_FORMAT, version: value.version, profile: value.profile, slots: value.slots }
}

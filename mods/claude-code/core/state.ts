import type { Span } from './anchor'
import { isId, SCOPES, RIGORS } from './bundle'
import type { Depth, Language, Locale, Mode, ProfileBundle, Rigor, Rules, Scope, Slot, SlotOption, SlotState } from './bundle'
import { matchesDecision, splitDecisions } from './decisions'
import type { Decision } from './types'

export type StoredDecision = {
  slot: string
  option: string
  scope: Scope
  model?: string
  text?: string
  setAt: number
}

export type StateChange =
  | { action: 'set' | 'delegate'; value: StoredDecision }
  | { action: 'forget'; slot: string; scope: Scope; model?: string }

export type StateLoad = {
  values: StoredDecision[]
  model: string | null
  facts?: Record<string, boolean>
  instructionSlots?: string[]
  /** True on resume if a task-opening prompt has already been submitted. */
  submitted?: boolean
}

export type StateMark = { slot: string; label: string; value: string; span?: Span }
export type StateCue = {
  slot: string
  label: string
  statement: string
  options: { id: string; label: string }[]
  scope: Scope
  guard: boolean
  why: string
  source: string
  span?: Span
}
export type DecisionView = {
  mode: Mode
  depth: Depth
  language: Language
  model: string | null
  marks: StateMark[]
  first: StateCue | null
  open: number
}
export type SlotResult = {
  slot: Slot
  status: SlotState
  reason: string
  span?: Span
  options: SlotOption[]
  value?: StoredDecision
  evidence?: string
}

type CompiledRules = {
  match: { phrase: string; groups: string[][] }[]
  exclude: string[]
  settled: string[]
  facts: [string, string[]][]
}

/** Whole words with accent/case folding, plus coordinates in the original UTF-16 text. */
class Words {
  readonly tokens: string[]
  private readonly padded: string
  private readonly positions: Map<number, number> = new Map()
  private readonly spans: Span[]
  private readonly cache = new Map<string, Span | undefined>()

  constructor(text: string) {
    const parts = [...text.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*/gu)]
    this.tokens = parts.map((m) => foldWord(m[0]))
    this.padded = ' ' + this.tokens.join(' ') + ' '
    this.spans = parts.map((m) => ({ start: m.index, end: m.index + m[0].length }))
    let offset = 0
    this.tokens.forEach((token, i) => {
      this.positions.set(offset, i)
      offset += token.length + 1
    })
    this.positions.set(offset, this.tokens.length)
  }

  find(phrase: string): Span | undefined {
    if (this.cache.has(phrase)) return this.cache.get(phrase)
    const start = this.padded.indexOf(phrase)
    const left = this.positions.get(start)
    const right = this.positions.get(start + phrase.length - 1)
    const first = left === undefined ? undefined : this.spans[left]
    const last = right === undefined ? undefined : this.spans[right - 1]
    const span = first && last ? { start: first.start, end: last.end } : undefined
    this.cache.set(phrase, span)
    return span
  }

  last(phrase: string): number { return this.padded.lastIndexOf(phrase) }

  any(phrases: string[]): boolean {
    return phrases.some((phrase) => this.find(phrase) !== undefined)
  }
}

const foldWord = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const pattern = (text: string) => ' ' + (foldWord(text).match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ') + ' '

function compile(rules: Rules): CompiledRules {
  return {
    match: rules.match.map((rule) => typeof rule === 'string'
      ? { phrase: pattern(rule), groups: [] }
      : { phrase: pattern(rule.phrase), groups: rule.with.map((group) => group.map(pattern)) }),
    exclude: (rules.exclude ?? []).map(pattern),
    settled: (rules.settled ?? []).map(pattern),
    facts: Object.entries(rules.facts ?? {}).map(([key, phrases]) => [key, phrases.map(pattern)]),
  }
}

const FR = new Set('je tu vous le la les des du un une et pour dans avec sur puis pas cette ces aux peux faut voici stp'.split(' '))
const EN = new Set('i you the this these that a an and for in with on of then not please can must only'.split(' '))
const DELEGATE = [
  "don't ask", 'do not ask', 'you decide', 'use your judgment', 'fais au mieux', 'décide toi-même',
  'ne me demande pas', 'carte blanche',
].map(pattern)
const CHECK_IN = [
  'ask me first', 'ask first', 'ask me before', 'check with me first', 'do not decide yourself',
  'demande-moi d’abord', 'demande-moi avant', 'consulte-moi avant', 'ne décide pas seul',
].map(pattern)
const FOLLOW_UP = /^(?:(?:yes|yeah|yep|no|ok|okay|thanks|sure|oui|non|merci|d['’]accord|parfait|exactement|actually|instead|also|en fait|au fait|plutôt)\b|(?:go ahead|carry on|keep going|as discussed|as above|continue(?: with| on| from|\b)|same as|vas[- ]y|comme prévu|pareil pour|reprends là)\b)/i

export class DecisionDraft {
  readonly language: Language
  readonly rigor: Rigor
  readonly directive: 'delegate' | 'ask' | null
  readonly words: number
  readonly followUp: boolean
  readonly results: SlotResult[]
  readonly byId: Map<string, SlotResult>
  readonly items: string[]
  readonly facts: Map<string, boolean>
  readonly text: string

  constructor(text: string, slots: Map<Slot, Locale<CompiledRules>>, state: DecisionState) {
    this.text = text
    const { body, items } = splitDecisions(text)
    const words = new Words(body)
    this.items = items
    this.words = (body.match(/[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*/gu) ?? []).length
    const fr = words.tokens.filter((t) => FR.has(t)).length
    const en = words.tokens.filter((t) => EN.has(t)).length
    this.language = fr > en || (fr === en && /[àâçéèêëîïôùûüœ]/i.test(body)) ? 'fr' : 'en'
    this.rigor = inferRigor(words)
    // The later explicit instruction wins within the draft.
    this.directive = directive(words)
    this.followUp = FOLLOW_UP.test(body.trimStart())

    this.facts = new Map(Object.entries(state.facts))
    const matches = [...slots].map(([slot, rules]) => {
      const locales = this.language === 'fr' ? [rules.fr, rules.en] : [rules.en, rules.fr]
      let span: Span | undefined
      let excluded = false
      let settled: Span | undefined
      for (const locale of locales) {
        for (const [key, phrases] of locale.facts) {
          if (!this.facts.has(key) && words.any(phrases)) this.facts.set(key, true)
        }
        excluded ||= words.any(locale.exclude)
        if (!settled) settled = locale.settled.map((phrase) => words.find(phrase)).find(Boolean)
        if (!span) {
          for (const rule of locale.match) {
            const found = words.find(rule.phrase)
            if (!found || !rule.groups.every((group) => words.any(group))) continue
            span = found
            break
          }
        }
      }
      return { slot, span, excluded, settled }
    })
    const frames = new Set(matches.filter((m) => m.span && !m.excluded).map((m) => m.slot.frame).filter(Boolean))
    this.results = matches.map(({ slot, span, excluded, settled }) => {
      const base = { slot, ...(span && { span }), options: this.available(slot) }
      const result = (status: SlotState, reason: string, value?: StoredDecision): SlotResult =>
        ({ ...base, status, reason, ...(value && { value }) })
      if (!span) return slot.frame && frames.has(slot.frame)
        ? result('unknown', 'slot-not-touched')
        : result('inapplicable', 'not-touched')
      if (excluded) return result('inapplicable', 'excluded')
      if (slot.requires?.some((fact) => this.facts.get(fact) === false)) return result('inapplicable', 'prerequisite-false')
      const evidence = this.matchingLine(slot) ?? (settled && body.slice(settled.start, settled.end))
      if (evidence) return { ...result('filled', 'settled-in-draft'), evidence }
      if (state.instructionSlots.has(slot.id)) return result('filled', 'project-instruction')
      if (slot.requires?.some((fact) => !this.facts.has(fact))) return result('unknown', 'prerequisite-unknown')
      const value = state.resolve(slot.id)
      if (value?.option === 'delegated') return result('delegated', 'standing-delegation', value)
      if (value) {
        if (value.option === 'other' || base.options.some((option) => option.id === value.option)) {
          return result('filled', 'standing-value', value)
        }
        const requires = slot.options.find((option) => option.id === value.option)?.requires
        if (requires && !this.facts.has(requires)) return result('unknown', 'stored-option-prerequisite-unknown')
      }
      if (base.options.length < 2) {
        const possible = slot.options.filter((o) => !o.requires || this.facts.get(o.requires) !== false)
        return possible.length < 2 ? result('inapplicable', 'fewer-than-two-options') : result('unknown', 'option-prerequisite-unknown')
      }
      return result('open', 'touched')
    })
    this.byId = new Map(this.results.map((result) => [result.slot.id, result]))
    this.settled = new Set(matches.filter((m) => m.settled).map((m) => m.slot.id))
  }

  private readonly settled: Set<string>

  available(slot: Slot): SlotOption[] {
    return slot.options.filter((option) => !option.requires || this.facts.get(option.requires) === true)
  }

  private matchingLine(slot: Slot): string | undefined {
    return this.items.find((item) => [slot.statement.en, slot.statement.fr].some(
      (wording) => matchesDecision(wording.plain, item) || matchesDecision(wording.expert, item)))
  }

  suppresses(slot: Slot): boolean {
    const result = this.byId.get(slot.id)
    return this.settled.has(slot.id) || this.matchingLine(slot) !== undefined ||
      (result?.span !== undefined && (result.status === 'inapplicable' || result.status === 'unknown'))
  }
}

const STUDY = ['production', 'paper', 'study', 'manuscript', 'study protocol', 'article scientifique', 'protocole', 'étude'].map(pattern)
const COMPETE = ['hackathon', 'leaderboard', 'competition', 'kaggle', 'concours', 'classement'].map(pattern)
const EXPLORE = ['brainstorm', 'explore', 'sketch', 'ideas only', 'explore les', 'idées', 'esquisse'].map(pattern)
function inferRigor(words: Words): Rigor {
  if (words.any(STUDY)) return 'study'
  if (words.any(COMPETE)) return 'compete'
  if (words.any(EXPLORE)) return 'explore'
  return 'build'
}

function directive(words: Words): DecisionDraft['directive'] {
  const latest = (phrases: string[]) => Math.max(-1, ...phrases.map((p) => words.last(p)))
  const delegate = latest(DELEGATE)
  const ask = latest(CHECK_IN)
  return ask < 0 && delegate < 0 ? null : ask > delegate ? 'ask' : 'delegate'
}

/** JSON validation for persisted answers. Preserve valid values for inactive or unloaded bundles. */
export function readStored(value: unknown): StoredDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { slot, option, scope, setAt, text, model } = value as Partial<StoredDecision>
  if (!isId(slot) || !isId(option) || !scope || !SCOPES.includes(scope) ||
    typeof setAt !== 'number' || !Number.isFinite(setAt) ||
    (scope === 'model' && (typeof model !== 'string' || !model.trim())) ||
    (scope !== 'model' && model !== undefined) ||
    (option === 'other' && (typeof text !== 'string' || !text.trim())) ||
    (option !== 'other' && text !== undefined)) return null
  return { slot, option, scope, ...(model && { model }), ...(text && { text }), setAt }
}

export const storageKey = (value: { slot: string; scope: Scope; model?: string }): string =>
  JSON.stringify([value.scope, value.model ?? '', value.slot])

export class DecisionState {
  private readonly index = new Map<string, Slot>()
  private readonly rules = new Map<Slot, Locale<CompiledRules>>()
  private readonly values = new Map<string, StoredDecision>()
  private active = new Map<Slot, Locale<CompiledRules>>()
  private readonly bundles: ProfileBundle[]
  private readonly personal: string[]
  model: string | null = null
  facts: Record<string, boolean> = {}
  instructionSlots = new Set<string>()

  constructor(bundles: ProfileBundle[], personal: string[]) {
    this.bundles = bundles
    this.personal = personal
    for (const bundle of bundles) {
      for (const slot of bundle.slots) {
        if (this.index.has(slot.id)) continue
        this.index.set(slot.id, slot)
        this.rules.set(slot, { en: compile(slot.touch.en), fr: compile(slot.touch.fr) })
      }
    }
  }

  use(profile: string): void {
    this.active = this.select(['general', profile, ...this.personal])
  }

  slot(id: string): Slot | undefined { return this.index.get(id) }

  forProfile(profile: string): Slot[] { return [...this.select([profile]).keys()] }

  evaluate(text: string, extra: Iterable<string> = []): DecisionDraft {
    const slots = new Map(this.active)
    for (const key of extra) {
      const slot = this.index.get(key)
      if (slot) slots.set(slot, this.rules.get(slot)!)
    }
    return new DecisionDraft(text, slots, this)
  }

  private select(profiles: string[]): Map<Slot, Locale<CompiledRules>> {
    const result = new Map<Slot, Locale<CompiledRules>>()
    for (const bundle of this.bundles) {
      if (!profiles.includes(bundle.profile)) continue
      for (const slot of bundle.slots) {
        const rules = this.rules.get(slot)
        if (rules) result.set(slot, rules)
      }
    }
    return result
  }

  load(state: StateLoad): void {
    this.model = state.model
    this.facts = { ...(state.facts ?? {}) }
    this.instructionSlots = new Set(state.instructionSlots ?? [])
    for (const [key, value] of this.values) if (value.scope !== 'session') this.values.delete(key)
    for (const raw of state.values) {
      const value = readStored(raw)
      if (value && value.scope !== 'session') this.values.set(storageKey(value), value)
    }
  }

  reset(): void {
    for (const [key, value] of this.values) if (value.scope === 'session') this.values.delete(key)
  }

  list(): StoredDecision[] { return [...this.values.values()].map((value) => ({ ...value })) }

  resolve(slot: string, scope?: Scope): StoredDecision | undefined {
    const definition = this.index.get(slot)
    for (const layer of scope ? [scope] : [...SCOPES].reverse()) {
      const value = this.values.get(storageKey({ slot, scope: layer, model: layer === 'model' ? this.model ?? undefined : undefined }))
      if (!value || (value.option === 'delegated' && definition?.guard)) continue
      if (definition && value.option !== 'delegated' && value.option !== 'other' &&
        !definition.options.some((option) => option.id === value.option)) continue
      return value
    }
  }

  set(slot: Slot, scope: Scope, option: string, setAt: number, text?: string): StateChange | undefined {
    if (option === 'delegated' && slot.guard) return undefined
    const value = readStored({ slot: slot.id, scope, option, setAt, text, model: scope === 'model' ? this.model : undefined })
    if (!value) return undefined
    this.values.set(storageKey(value), value)
    return { action: option === 'delegated' ? 'delegate' : 'set', value }
  }

  forget(slot: string, scope?: Scope): StateChange | undefined {
    const value = this.resolve(slot, scope)
    if (!value) {
      if (!scope) return undefined
      // Explicit forget also removes an answer whose option has since left the catalog.
      const model = scope === 'model' ? this.model ?? undefined : undefined
      if (!this.values.delete(storageKey({ slot, scope, model }))) return undefined
      return { action: 'forget', slot, scope, ...(model && { model }) }
    }
    this.values.delete(storageKey(value))
    return { action: 'forget', slot, scope: value.scope, ...(value.model && { model: value.model }) }
  }
}

export function eligibleSlot(slot: Slot, depth: Depth, rigor: Rigor): boolean {
  if (slot.guard) return true
  const deepEnough = slot.tier === 'essential' || depth === 'research' || (slot.tier === 'standard' && depth === 'standard')
  return deepEnough && RIGORS.indexOf(rigor) >= RIGORS.indexOf(slot.rigor)
}

const preference = (depth: Depth) => depth === 'essentials' ? 'plain' : 'expert'

export function stateCue(result: Pick<SlotResult, 'slot' | 'options' | 'span'>, lang: Language, depth: Depth): StateCue {
  const { slot, options, span } = result
  const style = preference(depth)
  return {
    slot: slot.id, label: slot.label[lang], statement: slot.statement[lang][style],
    options: options.map((o) => ({ id: o.id, label: o.wording[lang][style] })),
    scope: slot.scope, guard: slot.guard, why: slot.why, source: slot.source, ...(span && { span }),
  }
}

export function decisionFor(slot: Slot, value: StoredDecision, lang: Language, depth: Depth): Decision | undefined {
  const style = preference(depth)
  const option = value.option === 'other' ? value.text : slot.options.find((choice) => choice.id === value.option)?.wording[lang][style]
  return option ? { statement: slot.statement[lang][style], option } : undefined
}

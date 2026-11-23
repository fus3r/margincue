import { resolveAnchor } from './anchor'
import { isId } from './bundle'
import type { Slot } from './bundle'
import type { ExpertItem } from './types'

export const MAX_EXPERT_CUES = 8

export function expertPrompt(catalog: ExpertItem[], slots: Slot[]): string {
  if (!catalog.length) return 'Candidate catalog: (none)'
  const definitions = new Map(slots.map((slot) => [slot.id, slot]))
  return [
    'Candidate catalog:',
    ...catalog.map((item) => {
      const slot = definitions.get(item.key)!
      return [item.key, `when: ${slot.when}`, `settled: ${slot.settled}`,
        `${item.statement} | ${item.options.map((o) => o.label).join(' | ')}`].join('\n')
    }),
  ].join('\n\n')
}

/** Catalog references and new-key lines have distinct, unambiguous arities. */
export function parseExpert(
  reply: string, draft: string, catalog: ExpertItem[], reserved: (key: string) => boolean,
): ExpertItem[] {
  const known = new Map(catalog.map((item) => [item.key, item]))
  const seen = new Set<string>()
  const out: ExpertItem[] = []
  for (const line of reply.split(/\r?\n/)) {
    if (out.length >= MAX_EXPERT_CUES || line.trim() === 'NONE') break
    const [anchor, key, statement, ...options] = line.split('|').map((s) => s.trim())
    if (!anchor || !isId(key) || seen.has(key)) continue
    const span = anchor === '-' ? undefined : resolveAnchor(draft, anchor) ?? undefined
    if (!span && anchor !== '-') continue
    const item = known.get(key)
    if (item) {
      if (statement !== undefined) continue
      out.push({ ...item, ...(span && { span }) })
    } else {
      if (reserved(key) || !statement || statement.split('{}').length !== 2 ||
        options.length < 2 || options.length > 3 || options.some((o) => !o) ||
        new Set(options.map((o) => o.toLowerCase())).size !== options.length) continue
      out.push({
        key, slot: key, persistent: false, label: key.replace(/[_-]/g, ' '), statement,
        options: options.map((label, i) => ({ id: String(i), label })),
        scope: 'session', guard: false, why: '', source: '', ...(span && { span }),
      })
    }
    seen.add(key)
  }
  return out
}

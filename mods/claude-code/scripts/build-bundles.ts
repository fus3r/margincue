// node mods/claude-code/scripts/build-bundles.ts [--check]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { BUNDLE_FORMAT, readBundle } from '../core/bundle.ts'
import type { ProfileBundle, Slot } from '../core/bundle.ts'
import { CARD_RULES } from './bundle-rules.ts'

const root = resolve(import.meta.dirname, '../../..')
const profiles = ['general', 'ml-research', 'system-design']

type Pilot = { frames: { id: string; slots: { id: string; cost: number; options: { value: string }[] }[] }[] }

export function parseCards(source: string): { id: string; fields: Record<string, string> }[] {
  return source.replace(/\r\n?/g, '\n').split(/^### /m).slice(1).map((block) => {
    const [id = '', ...lines] = block.trim().split('\n')
    const fields: Record<string, string> = {}
    let key: string | undefined
    for (const line of lines) {
      const match = /^([a-z_]+):\s*(.*)$/.exec(line)
      if (match?.[1] === 'pair') break
      if (match?.[1]) {
        key = match[1]
        fields[key] = match[2] ?? ''
      } else if (key && /^\s+\S/.test(line)) {
        fields[key] += ' ' + line.trim()
      }
    }
    return { id, fields }
  })
}

export function buildBundle(profile: string, source: string, pilot?: Pilot): ProfileBundle {
  const schema = new Map(pilot?.frames.flatMap((f) => f.slots.map((s) => [s.id, { ...s, frame: f.id }] as const)))
  const slots = parseCards(source).map(({ id, fields }) => {
    const metadata = CARD_RULES[id]
    if (!metadata) throw new Error(`Missing bundle metadata for ${profile}/${id}`)
    if (fields.guard !== 'yes' && fields.guard !== 'no') throw new Error(`Invalid guard flag for ${profile}/${id}`)
    const typed = schema.get(id)
    const optionIds = typed?.options.map((o) => o.value) ?? metadata.optionIds
    if (!optionIds) throw new Error(`Missing option IDs for ${profile}/${id}`)
    const [plain, expert, plainFr, expertFr] = [
      fields.plain, fields.expert, fields.plain_fr ?? metadata.fr?.plain, fields.expert_fr ?? metadata.fr?.expert,
    ].map((line) => line?.split(' | ').map((part) => part.trim()) ?? [])
    if (![plain, expert, plainFr, expertFr].every((parts) => parts?.length === optionIds.length + 1)) {
      throw new Error(`Option count or translation mismatch for ${profile}/${id}`)
    }
    const wording = (i: number) => ({
      en: { plain: plain![i]!, expert: expert![i]! },
      fr: { plain: plainFr![i]!, expert: expertFr![i]! },
    })
    return {
      id,
      scope: 'project',
      ...(typed && { frame: typed.frame }),
      ...(metadata.requires && { requires: metadata.requires }),
      touch: metadata.touch,
      label: metadata.label,
      statement: wording(0),
      options: optionIds.map((option, i) => ({
        id: option, wording: wording(i + 1),
        ...(metadata.optionFacts?.[option] && { requires: metadata.optionFacts[option] }),
      })),
      tier: fields.tier,
      rigor: fields.rigor,
      guard: fields.guard === 'yes',
      cost: typed?.cost ?? metadata.cost,
      when: fields.when,
      settled: fields.settled,
      why: fields.why,
      source: fields.source,
      opens: fields.opens?.split(/[\s,]+/).filter(Boolean) ?? [],
    } as Slot
  })
  if (pilot && schema.size !== slots.length) throw new Error(`Pilot/card slot count mismatch for ${profile}`)
  const version = createHash('sha256').update(JSON.stringify({ profile, slots })).digest('hex').slice(0, 12)
  const bundle = readBundle({ formatVersion: BUNDLE_FORMAT, version, profile, slots })
  if (!bundle) throw new Error(`Invalid compiled bundle for ${profile}`)
  return bundle
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const check = process.argv.includes('--check')
  for (const profile of profiles) {
    const path = resolve(root, 'profiles', profile, 'bundle.json')
    const source = readFileSync(resolve(root, 'profiles', profile, 'decisions.md'), 'utf8')
    const schemaFile = resolve(root, 'bench', 'quality', 'schema', `${profile}.json`)
    const pilot = existsSync(schemaFile) ? JSON.parse(readFileSync(schemaFile, 'utf8')) as Pilot : undefined
    const bundle = buildBundle(profile, source, pilot)
    const json = JSON.stringify(bundle, null, 2) + '\n'
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== json) {
        console.error(`${profile}/bundle.json is out of date`)
        process.exitCode = 1
      }
    } else {
      writeFileSync(path, json)
      console.log(`Built ${profile} (${bundle.slots.length} slots, ${bundle.version})`)
    }
  }
}

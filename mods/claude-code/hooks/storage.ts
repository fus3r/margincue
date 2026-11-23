import type { EngineInterface as Engine } from 'claude-code'
import { isId, readBundle, readStored, storageKey } from '../core/index'
import type { Assets, ProfileBundle, StateChange, StoredDecision } from '../core/index'

const ANSWER = 'decision:'
const FILE = '.margincue/decisions.json'
const join = (dir: string, path: string) => dir.replace(/[\\/]+$/, '') + '/' + path

export type ProjectState = {
  version: 1
  decisions: StoredDecision[]
  facts?: Record<string, boolean>
}
const empty = (): ProjectState => ({ version: 1, decisions: [] })

export async function optionalText($: Engine, path: string): Promise<string | null> {
  return await $.fs.exists(path) ? $.fs.read(path) : null
}

export async function readProject($: Engine, root: string): Promise<ProjectState> {
  const text = await optionalText($, join(root, FILE))
  if (text === null) return empty()
  const doc = JSON.parse(text) as ProjectState
  if (doc?.version !== 1 || !Array.isArray(doc.decisions) ||
    doc.decisions.some((value) => readStored(value)?.scope !== 'project') ||
    new Set(doc.decisions.map(storageKey)).size !== doc.decisions.length ||
    (doc.facts !== undefined && (!doc.facts || typeof doc.facts !== 'object' || Array.isArray(doc.facts) ||
      Object.entries(doc.facts).some(([key, value]) => !isId(key) || typeof value !== 'boolean')))) {
    throw new Error('Invalid project decisions file')
  }
  return doc
}

export async function readAccount($: Engine): Promise<StoredDecision[]> {
  const keys = (await $.store.keys()).filter((key) => key.startsWith(ANSWER))
  const values = await Promise.all(keys.map(async (key) => readStored(await $.store.get(key))))
  return values.filter((value): value is StoredDecision => value?.scope === 'user' || value?.scope === 'model')
}

export async function saveDecision($: Engine, root: string, change: StateChange): Promise<void> {
  const target = change.action === 'forget' ? change : change.value
  if (target.scope === 'session') return
  if (target.scope !== 'project') {
    const key = ANSWER + storageKey(target)
    if (change.action === 'forget') await $.store.delete(key)
    else await $.store.set(key, change.value)
    return
  }
  const path = join(root, FILE)
  const parent = join(root, '.margincue')
  const [dir, file] = await Promise.all([$.fs.stat(parent).catch(() => null), $.fs.stat(path).catch(() => null)])
  if (dir?.isLink || file?.isLink) throw new Error('Project decisions path is a symbolic link')
  // Merge with the latest file. The mod API exposes whole-file writes but no
  // cross-process transaction. The host serializes changes from this session.
  const doc = await readProject($, root)
  const decisions = doc.decisions.filter((value) => value.slot !== target.slot)
  if (change.action === 'forget') {
    if (decisions.length === doc.decisions.length) return
  } else decisions.push(change.value)
  decisions.sort((a, b) => a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)
  await $.fs.write(path, JSON.stringify({ ...doc, decisions }, null, 2) + '\n')
}

export async function readInstructionSlots($: Engine, root: string): Promise<string[]> {
  // An explicit marker is an assertion from the author of a project
  // instruction, with no parsing or inference about its prose.
  const files = await Promise.all(['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].map(
    (name) => optionalText($, join(root, name)).catch(() => null)))
  const slots = new Set<string>()
  for (const text of files) {
    if (!text) continue
    for (const match of text.matchAll(/<!--\s*margincue:\s*([^<>]*?)\s*-->/g)) {
      for (const id of (match[1] ?? '').split(/[\s,]+/)) if (isId(id)) slots.add(id)
    }
  }
  return [...slots].sort()
}

export async function personalAssets($: Engine, builtin: Assets): Promise<{ assets: Assets; skipped: number }> {
  const home = await $.env.get('HOME').catch(() => undefined) ?? await $.env.get('USERPROFILE').catch(() => undefined)
  if (!home) return { assets: builtin, skipped: 0 }
  const dir = join(home, '.margincue/bundles')
  const files = await $.fs.list(dir).catch(() => [])
  const bundles: ProfileBundle[] = [...(builtin.bundles ?? [])]
  const ids = new Set(bundles.flatMap((bundle) => bundle.slots.map((slot) => slot.id)))
  const profiles = { ...builtin.profiles }
  const personalProfiles: string[] = []
  let skipped = 0
  for (const file of files.filter((file) => file.kind === 'file' && file.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    let bundle: ProfileBundle | null = null
    try {
      bundle = readBundle(JSON.parse(await $.fs.read(join(dir, file.name))))
    } catch {}
    if (!bundle || Object.hasOwn(profiles, bundle.profile) || bundle.slots.some((slot) => ids.has(slot.id))) {
      skipped++
      continue
    }
    bundles.push(bundle)
    personalProfiles.push(bundle.profile)
    profiles[bundle.profile] = ''
    for (const slot of bundle.slots) ids.add(slot.id)
  }
  return { assets: { ...builtin, profiles, bundles, personalProfiles }, skipped }
}

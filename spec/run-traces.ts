// Replays spec/traces/*.json against the TypeScript core.
//
//   node spec/run-traces.ts                 every trace
//   node spec/run-traces.ts traces/07-*.json  some
//   node spec/run-traces.ts --print FILE    print each step's actual effects
//
// The trace format is described in spec/README.md.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import './ts-resolve.ts'
import type { Assets, Effect, Event, ProfileBundle } from '../mods/claude-code/core/index'

const { createCore } = await import('../mods/claude-code/core/index')

type Step = { event: Event; expect?: unknown[]; note?: string }
type Trace = { name: string; description?: string; assets: string | Assets; metrics?: boolean; steps: Step[] }

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const print = args.includes('--print')
const files = args.filter((a) => !a.startsWith('--'))
const paths =
  files.length > 0
    ? files.map((f) => resolve(f))
    : readdirSync(join(here, 'traces'))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(here, 'traces', f))

function loadAssets(spec: string | Assets): Assets {
  if (typeof spec !== 'string') return spec
  if (spec === 'repo' || spec === 'catalogs') {
    const repo = resolve(here, '..')
    const profiles: Record<string, string> = {}
    for (const name of readdirSync(join(repo, 'profiles')).filter((f) => f.endsWith('.md'))) {
      profiles[name.slice(0, -3)] = readFileSync(join(repo, 'profiles', name), 'utf8')
    }
    const system = readFileSync(join(repo, 'prompts', 'system.md'), 'utf8')
    if (spec === 'repo') return { system, profiles }
    profiles['system-design'] = readFileSync(join(repo, 'profiles', 'system-design', 'profile.md'), 'utf8')
    const bundles = ['general', 'ml-research', 'system-design'].map((profile) =>
      JSON.parse(readFileSync(join(repo, 'profiles', profile, 'bundle.json'), 'utf8')) as ProfileBundle)
    return {
      system, profiles, bundles, expertSystem: readFileSync(join(repo, 'prompts', 'system.v2.md'), 'utf8'),
      sheetSystem: readFileSync(join(repo, 'bench', 'sheet', 'product', 'sheet-prompt.md'), 'utf8').trim(),
    }
  }
  return JSON.parse(readFileSync(join(here, spec), 'utf8')) as Assets
}

/**
 * Expected matches actual when: primitives are equal; arrays have the same
 * length and match element by element; every key of an expected object is
 * present in the actual one and matches (keys the expectation leaves out are
 * not checked). `{"$absent": true}` as a value requires the key to be missing.
 */
export function matches(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: expected an array, got ${JSON.stringify(actual)}`)
      return
    }
    if (expected.length !== actual.length) {
      out.push(`${path}: expected ${expected.length} items, got ${actual.length}: ${JSON.stringify(actual)}`)
      return
    }
    expected.forEach((item, i) => matches(item, actual[i], `${path}[${i}]`, out))
    return
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`)
      return
    }
    for (const [key, value] of Object.entries(expected)) {
      const has = Object.prototype.hasOwnProperty.call(actual, key)
      if (value !== null && typeof value === 'object' && (value as { $absent?: boolean }).$absent === true) {
        if (has) out.push(`${path}.${key}: expected absent, got ${JSON.stringify((actual as Record<string, unknown>)[key])}`)
        continue
      }
      if (!has) {
        out.push(`${path}.${key}: missing`)
        continue
      }
      matches(value, (actual as Record<string, unknown>)[key], `${path}.${key}`, out)
    }
    return
  }
  if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

let failed = 0
let steps = 0
for (const path of paths) {
  const trace = JSON.parse(readFileSync(path, 'utf8')) as Trace
  const core = createCore(loadAssets(trace.assets))
  const problems: string[] = []
  trace.steps.forEach((step, i) => {
    const effects = core.handle(step.event).filter((fx: Effect) => trace.metrics === true || fx.type !== 'metric')
    steps++
    if (print) console.log(`${basename(path)} #${i} ${step.event.type}${step.note ? ` (${step.note})` : ''}\n  ${JSON.stringify(effects)}`)
    if (step.expect === undefined) return
    const out: string[] = []
    matches(step.expect, effects, 'effects', out)
    for (const line of out) problems.push(`  step ${i} (${step.event.type}${step.note ? `: ${step.note}` : ''}): ${line}`)
  })
  if (problems.length > 0) {
    failed++
    console.log(`FAIL ${basename(path)}: ${trace.name}`)
    for (const line of problems) console.log(line)
  } else {
    console.log(`ok   ${basename(path)}: ${trace.name} (${trace.steps.length} steps)`)
  }
}
console.log(`${paths.length - failed}/${paths.length} traces passed, ${steps} steps`)
process.exit(failed === 0 ? 0 : 1)

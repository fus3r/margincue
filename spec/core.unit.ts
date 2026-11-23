// Unit tests for the TypeScript core's pure parts: node --test spec/core.unit.ts
import './ts-resolve.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const core = await import('../mods/claude-code/core/index')
const {
  applyDecisions,
  attachDecisions,
  buildPrompt,
  buildSystem,
  createCore,
  decisionLine,
  diffSplice,
  isTerminated,
  lastSentenceStart,
  Lru,
  parseCueLine,
  parseProfile,
  parseReply,
  resolveAnchor,
  sameCue,
  shiftSpan,
  spliceFits,
} = core

test('parseReply: plan, cue lines, NONE', () => {
  const r = parseReply('export button ; old\nexport button | Export covers {} | a | b\nold | Old after {} | 90 days | 30 days', true)
  assert.deepEqual(r.plan, ['export button', 'old'])
  assert.equal(r.cues.length, 2)
  assert.deepEqual(r.cues[1], { anchor: 'old', statement: 'Old after {}', options: ['90 days', '30 days'] })
  assert.deepEqual(parseReply('NONE', true), { plan: [], none: true, cues: [] })
  assert.deepEqual(parseReply('None.', true).none, true)
})

test('parseReply: a streamed prefix never changes what complete lines gave', () => {
  const whole = 'caching\ncaching | Cache entries are {} | shared | per user\ncaching | Stale for {} | 5 minutes | never'
  let last = parseReply('', false)
  for (let i = 1; i <= whole.length; i++) {
    const now = parseReply(whole.slice(0, i), false)
    assert.ok(now.cues.length >= last.cues.length)
    assert.deepEqual(now.cues.slice(0, last.cues.length), last.cues)
    last = now
  }
  assert.equal(parseReply(whole, true).cues.length, 2)
  assert.equal(parseReply(whole, false).cues.length, 1, 'the last line is unterminated until final')
})

test('parseReply: tolerance', () => {
  const fenced = parseReply('```text\n1. "a b" | S | x | y\n```', true)
  assert.equal(fenced.plan, null)
  assert.deepEqual(fenced.cues, [{ anchor: 'a b', statement: 'S {}', options: ['x', 'y'] }])
  const prose = parseReply('Here is my reading of the draft, which has one open decision.\nold\nold | Old after {} | 1 | 2', true)
  assert.deepEqual(prose.plan, ['old'])
  assert.equal(parseReply('NONE\nold | Old after {} | 1 | 2', true).cues.length, 0)
  assert.equal(parseReply('a\na | S {} | 1 | 2\nb | S {} | 1 | 2\nc | S {} | 1 | 2', true, 2).cues.length, 2)
  assert.equal(parseReply('- | Success is {} | x | y', true).cues[0]?.anchor, null)
  assert.equal(parseCueLine('anchor | statement | default | alternative'), null)
  assert.equal(parseCueLine('a | S {} | only'), null)
  assert.deepEqual(parseCueLine('a | S {} | x | X | y')?.options, ['x', 'y'])
  assert.equal(parseCueLine('**a** | `S {}` | “x” | ‘y’')?.anchor, 'a')
})

test('resolveAnchor: exact, case, whitespace, nearest', () => {
  assert.deepEqual(resolveAnchor('Add the Export Button now', 'Export Button'), { start: 8, end: 21 })
  assert.deepEqual(resolveAnchor('Add the Export Button now', 'export button'), { start: 8, end: 21 })
  assert.deepEqual(resolveAnchor('Add the export\n   button now', 'export button'), { start: 8, end: 24 })
  assert.deepEqual(resolveAnchor('old a old b old', 'old', 9), { start: 6, end: 9 })
  assert.deepEqual(resolveAnchor('old a old b old', 'old'), { start: 0, end: 3 })
  assert.equal(resolveAnchor('nothing here', 'export'), null)
})

test('shiftSpan and splices', () => {
  const span = { start: 4, end: 11 }
  assert.deepEqual(shiftSpan(span, { start: 0, end: 0, text: 'Now ' }), { start: 8, end: 15 })
  assert.deepEqual(shiftSpan(span, { start: 4, end: 4, text: 'x' }), { start: 5, end: 12 }, 'insert at the start edge shifts')
  assert.deepEqual(shiftSpan(span, { start: 11, end: 11, text: 'x' }), { start: 4, end: 11 }, 'insert at the end edge stays')
  assert.equal(shiftSpan(span, { start: 6, end: 6, text: 'x' }), null)
  assert.equal(shiftSpan(span, { start: 0, end: 5, text: '' }), null)
  assert.deepEqual(shiftSpan(span, { start: 0, end: 4, text: '' }), { start: 0, end: 7 })
  assert.deepEqual(diffSplice('Add caching.', 'Add a cache.'), { start: 4, end: 11, text: 'a cache' })
  assert.ok(spliceFits('abc', 'aXc', { start: 1, end: 2, text: 'X' }))
  assert.ok(!spliceFits('abc', 'aXc', { start: 0, end: 1, text: 'X' }))
})

test('decisions: lines, a new block, a user block kept verbatim', () => {
  assert.equal(decisionLine({ statement: 'export covers {}', option: 'all rows' }), 'Export covers all rows.')
  assert.equal(decisionLine({ statement: 'Is it {}', option: 'safe?' }), 'Is it safe?')
  const d = [{ statement: 'Export covers {}', option: 'all rows' }]
  assert.equal(applyDecisions('Add an export.  \n', d), 'Add an export.\n\nDecisions:\n- Export covers all rows.')
  assert.equal(applyDecisions('Add an export.', []), 'Add an export.')
  const typed = 'Add it.\n\nDecisions:\n*  keep the CSV format\n- Logs are kept'
  assert.equal(applyDecisions(typed, d), `${typed}\n- Export covers all rows.`)
  const userSettled = 'Add it.\n\nDecisions:\n- export covers   selected rows only'
  assert.deepEqual(attachDecisions(userSettled, d), { text: userSettled, added: [] })
  const ours = 'Add it.\n\nDecisions:\n- Keep it.\n- Export covers selected rows.'
  assert.deepEqual(attachDecisions(ours, d, ['Export covers selected rows.']), {
    text: 'Add it.\n\nDecisions:\n- Keep it.\n- Export covers all rows.',
    added: ['Export covers all rows.'],
  })
})

test('profiles: front matter, rubric only, examples', () => {
  const p = parseProfile('---\nname: x\ndescription: "d"\nmax_cues: 2\n---\n## Rubric\nR.\n\n## Examples\n### Draft\nD\n### Status\nincomplete\n### Output\nNONE\n')
  assert.equal(p.name, 'x')
  assert.equal(p.description, 'd')
  assert.equal(p.maxCues, 2)
  assert.equal(p.rubric, 'R.')
  assert.deepEqual(p.examples, [{ draft: 'D', output: 'NONE', status: 'incomplete' }])
  const bare = parseProfile('Only a rubric.\n', 'bare')
  assert.deepEqual([bare.name, bare.maxCues, bare.rubric, bare.examples.length], ['bare', 3, 'Only a rubric.', 0])
  assert.deepEqual(buildSystem('S {{max_cues}}', p), ['S 2', 'R.', 'Example\nStatus: incomplete\nDraft:\n<<<\nD\n>>>\nOutput:\nNONE'])
  assert.equal(buildPrompt({ draft: 'D', dismissed: ['A {}', 'B {}'] }), 'Status: complete\nDraft:\n<<<\nD\n>>>\nDismissed: A {}; B {}')
})

test('the repo profiles parse', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = join(here, '..', 'profiles')
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const p = parseProfile(readFileSync(join(dir, name), 'utf8'))
    assert.ok(p.rubric.length > 0, `${name}: rubric`)
    assert.ok(p.examples.length > 0, `${name}: examples`)
    for (const ex of p.examples) assert.ok(ex.output === 'NONE' || parseReply(ex.output, true).cues.length > 0, `${name}: example output parses`)
  }
})

test('sentences', () => {
  assert.ok(isTerminated('Done.'))
  assert.ok(isTerminated('Is it "done?" '))
  assert.ok(isTerminated('one\n'))
  assert.ok(!isTerminated('make it faster'))
  assert.equal(lastSentenceStart('First one. Second'), 11)
  assert.equal(lastSentenceStart('No boundary here'), 0)
  assert.equal(lastSentenceStart('Line one\nline two'), 9)
})

test('identity and the LRU', () => {
  assert.ok(sameCue({ anchor: 'Export  Button', options: ['a', 'B'] }, { anchor: 'export button', options: ['b', 'A'] }))
  assert.ok(!sameCue({ anchor: 'x', options: ['a', 'b'] }, { anchor: 'x', options: ['a', 'c'] }))
  const lru = new Lru<number>(2)
  lru.set('a', 1)
  lru.set('b', 2)
  lru.get('a')
  lru.set('c', 3)
  assert.deepEqual([lru.has('a'), lru.has('b'), lru.has('c')], [true, false, true])
})

test('the core is deterministic and orders its effects', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const assets = JSON.parse(readFileSync(join(here, 'fixtures', 'assets.json'), 'utf8'))
  for (const file of readdirSync(join(here, 'traces')).filter((f) => f.endsWith('.json'))) {
    const trace = JSON.parse(readFileSync(join(here, 'traces', file), 'utf8'))
    const run = () => {
      const c = createCore(assets)
      return trace.steps.map((s: { event: unknown }) => c.handle(s.event as never))
    }
    const a = run()
    assert.deepEqual(a, run(), `${file}: same events, same effects`)
    for (const effects of a) {
      const types = effects.map((e: { type: string }) => e.type)
      const v = types.indexOf('view')
      if (v !== -1) assert.equal(v, types.length - 1, `${file}: view comes last`)
      const t = types.indexOf('timer')
      if (t !== -1) assert.ok(t === types.length - 1 || types[t + 1] === 'view', `${file}: timer only before view`)
      assert.ok(types.filter((x: string) => x === 'view').length <= 1)
    }
  }
})

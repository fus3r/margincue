import assert from 'node:assert/strict'
import { test } from 'node:test'
import './ts-resolve.ts'
import type { ChoiceTier } from '../mods/claude-code/core/choice-tier'

const { choiceTier } = await import('../mods/claude-code/core/choice-tier')
const { rankReceiptEdits } = await import('../mods/claude-code/hooks/receipt-impact')

for (const [statement, value] of [
  ['retention: {}', 'permanently delete archived data'],
  ['database rollout: {}', 'run a schema migration'],
  ['parser: {}', 'add a dependency'],
  ['API: {}', 'rename the public endpoint'],
  ['gate: {}', 'relax authentication'],
  ['delivery: {}', 'email customers'],
  ['release: {}', 'deploy to production'],
]) {
  test(`high consequence from the chosen value: ${value}`, () => {
    assert.equal(choiceTier(statement!, value!), 'high')
  })
}

for (const [reason, edits] of Object.entries({
  deletion: [{ path: 'src/legacy.ts', deleted: true }],
  schema: [{ path: 'db/schema.sql' }],
  migration: [{ path: 'db/migrations/001.sql' }],
  manifest: [{ path: 'apps/web/package.json' }],
  lockfile: [{ path: 'pnpm-lock.yaml' }],
  authentication: [{ path: 'src/auth/session.ts' }],
  permission: [{ path: 'src/permissions.ts' }],
  'exported declaration': [{ path: 'src/format.ts', publicInterface: true }],
  'public contract': [{ path: 'api/openapi.yaml' }],
})) {
  test(`high consequence from a related edit: ${reason}`, () => {
    assert.equal(choiceTier('implementation: {}', 'reuse existing code', edits), 'high')
  })
}

for (const [reason, files] of Object.entries({
  'several files': ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  'several modules': ['src/reader/io.ts', 'src/writer/io.ts'],
  'shared config': ['tsconfig.build.json'],
  'data format': ['var/exports/summary.jsonl'],
})) {
  test(`mid consequence from related edits: ${reason}`, () => {
    assert.equal(choiceTier('implementation: {}', 'reuse existing code', files.map((path) => ({ path }))), 'mid')
  })
}

test('the default is low and borderline signals stay low', () => {
  assert.equal(choiceTier('orientation: {}', 'horizontal'), 'low')
  assert.equal(choiceTier('retention: {}', 'dry run'), 'low')
  assert.equal(choiceTier('retention: {}', 'preview deleting account records'), 'low')
  assert.equal(choiceTier('gate: {}', 'add an authentication label'), 'low')
  for (const files of [
    ['src/package-summary.ts'], ['test/fixtures/package.json'], ['docs/migrations/readme.md'],
    ['src/widget.ts', 'src/widget.css', 'src/widget.ts'], ['src/widget.ts', 'test/widget.test.ts'],
    ['src/user-prefs.json'], ['packages/web/theme.ts'],
  ]) {
    assert.equal(choiceTier('appearance: {}', 'compact', files.map((path) => ({ path }))), 'low', files.join(', '))
  }
})

test('a sensitive edit ranks only the choice that names it or precedes it', () => {
  const choices = ['heading', 'parser', 'delivery', 'format'].map((label) => ({
    label, value: 'existing', options: ['existing', 'new'], tier: 'low' as ChoiceTier,
  }))
  const marks = new Map([
    ['heading', { position: 1, words: '', choice: 'existing' }],
    ['parser', { position: 3, words: '', choice: 'existing' }],
    ['delivery', { position: 5, words: '', choice: 'existing' }],
    ['format', { position: 5, words: 'from old-format.ts', choice: 'existing' }],
  ])
  const ranked = rankReceiptEdits(choices, [
    { path: 'src/heading.ts', position: 2 },
    { path: 'package.json', position: 4 },
    { path: 'db/schema.sql', position: 6 },
    { path: 'src/old-format.ts', deleted: true },
  ], marks)
  assert.deepEqual(ranked.map(({ tier }) => tier), ['low', 'high', 'low', 'high'])
})

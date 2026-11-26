import assert from 'node:assert/strict'
import { test } from 'node:test'
import './ts-resolve.ts'
import softDelete from './fixtures/review-first-soft-delete.json' with { type: 'json' }
import type { ChoiceEdit, ChoiceReview, ReviewChoice, ReviewContext } from '../mods/claude-code/core/review-first'

const { auditExpertProfiles, reviewExpertDecisions, reviewOrder, scoreChoice } = await import('../mods/claude-code/core/review-first')
const { nameKey } = await import('../mods/claude-code/core/grounding')
const { ASSETS } = await import('../mods/claude-code/hooks/assets')
const { reviewReceiptEdits } = await import('../mods/claude-code/hooks/receipt-impact')
const { reviewLogLine, reviewRootHash } = await import('../mods/claude-code/core/review-log')

const cache = { label: 'cache', value: 'in memory', options: ['in memory', 'Redis'] }
const row = { key: 'cache_backend', label: 'cache', statement: 'Cache responses in {}', options: cache.options, leftOpen: true }
const context: ReviewContext = { prompt: '' }
const named = (...edits: ChoiceEdit[]) => ({ kind: 'named' as const, edits })
const match = named({ path: 'src/cache.ts' })

test('a prompt contradiction pins review independently of cost, using whole words', () => {
  const review = scoreChoice(cache, { prompt: 'Store the responses in REDIS.' }, match)
  assert.deepEqual([review.signals.contradiction, review.d, review.c, review.flagged, review.reason],
    ['Redis', 1, 1, true, 'your prompt said "Redis"'])
  for (const prompt of ['Redistribution is needed.', 'Compare Redis and in memory.', 'Build the cache.']) {
    assert.equal(scoreChoice(cache, { prompt }, match).signals.contradiction, null, prompt)
  }
  const shared = { ...cache, value: 'Redis cluster', options: ['Redis cluster', 'single Redis'] }
  assert.equal(scoreChoice(shared, { prompt: 'Use Redis.' }, match).flagged, false)
  assert.equal(scoreChoice(shared, { prompt: 'Use a single Redis.' }, match).reason, 'your prompt said "single Redis"')
  const tiny = { ...cache, value: 'no', options: ['no', 'yes', 'on'] }
  assert.equal(scoreChoice(tiny, { prompt: 'Turn it on.' }, match).flagged, false)
})

test('English and French negations do not name an alternative positively', () => {
  for (const negation of [
    'no', 'without', "don't use", 'don’t use', 'not', 'avoid', 'instead of', 'rather than', 'except', 'never',
    'sans', 'pas de', 'pas', 'au lieu de', 'plutôt que', 'jamais',
  ]) {
    const prompt = `${negation} Redis`
    const review = scoreChoice(cache, { prompt }, match)
    assert.deepEqual([review.signals.contradiction, review.flagged], [null, false], prompt)
  }
})

test('prompt mentions respect the three-word negation window and positive mentions', () => {
  const chosenRedis = { ...cache, value: 'Redis' }
  for (const [choice, prompt, expected] of [
    [cache, 'Use Redis for the cache', 'Redis'],
    [cache, 'PLUTÔT QUE LE SERVICE RÉDIS', null],
    [cache, 'No need for `Redis`', null],
    [cache, 'Not the old local Redis', 'Redis'],
    [cache, 'Not in a new Redis', 'Redis'],
    [cache, 'Avoid Redis. Use Redis here.', 'Redis'],
    [cache, 'Use Redis, not in-memory', 'Redis'],
    [chosenRedis, 'Use Redis, not in-memory', null],
  ] as const) {
    const review = scoreChoice(choice, { prompt }, match)
    assert.deepEqual([review.signals.contradiction, review.flagged], [expected, expected !== null], prompt)
  }
})

test('learned conflict and match follow the card decision key and the project habit threshold', () => {
  const ctx: ReviewContext = { ...context, rows: [row], learned: { cache_backend: { label: 'Redis', count: 2 } } }
  const conflict = scoreChoice(cache, ctx)
  assert.deepEqual([conflict.signals.learnedConflict, conflict.d, conflict.flagged, conflict.reason],
    ['Redis', 0.8, true, 'you usually pick Redis'])
  const agree = scoreChoice({ ...cache, value: 'redis' }, ctx)
  assert.deepEqual([agree.signals.learnedMatch, agree.d, agree.flagged], [true, 0.1, false])
  assert.equal(scoreChoice(cache, { ...ctx, learned: { cache_backend: { label: 'Redis', count: 1 } } }).d, 0.3)
  assert.equal(scoreChoice(cache, { ...ctx, learned: { export_format: { label: 'Redis', count: 2 } } }).d, 0.3)
})

test('the card distinguishes silent choices from untouched rows and switched choices', () => {
  const silent = scoreChoice(cache, context)
  assert.deepEqual([silent.signals.silent, silent.d, silent.c, silent.score, silent.flagged, silent.reason],
    [true, 0.5, 2, 1, false, 'not on the card'])
  const open = scoreChoice(cache, { ...context, rows: [row] })
  assert.deepEqual([open.signals.leftOpen, open.d, open.c, open.score, open.flagged, open.reason],
    [true, 0.3, 2, 0.6, false, 'you left it open'])
  const switched = scoreChoice({ ...cache, switched: true }, { prompt: 'Use Redis.' },
    named({ path: 'legacy.ts', deleted: true }))
  assert.deepEqual([switched.signals.switched, switched.pinned, switched.d, switched.score, switched.flagged], [true, true, 0, 0, false])
})

test('cost nine applies to irreversible wording and each concrete pinned edit', () => {
  const cases = [
    { edit: { path: 'archive.txt', deleted: true }, reason: 'deletes a file' },
    { edit: { path: 'db/migrations/0002_add_index.sql' }, reason: 'changes a migration' },
    { edit: { path: 'db/schema.prisma' }, reason: 'changes a migration' },
    { edit: { path: 'src/auth/rules.ts' }, reason: 'changes access rules' },
    { edit: { path: 'firestore.rules' }, reason: 'changes access rules' },
    { edit: { path: 'index.d.ts' }, reason: 'changes a public interface' },
    { edit: { path: 'api/openapi.yaml' }, reason: 'changes a public interface' },
    { edit: { path: 'src/cache.ts', publicInterface: true }, reason: 'changes a public interface' },
    { edit: { path: 'src/service.ts', sendsOutside: true }, reason: 'sends outside' },
  ]
  for (const { edit, reason } of cases) {
    const review = scoreChoice(cache, { ...context, rows: [row] }, named(edit))
    assert.deepEqual([review.c, review.pinned, review.flagged, review.reason], [9, true, true, reason])
  }
  for (const value of ['delete user records', 'email customers', 'charge customer cards', 'publish to npm', 'run a schema migration']) {
    const review = scoreChoice({ label: 'rollout', value, options: [value] }, context)
    assert.deepEqual([review.c, review.pinned, review.flagged, review.reason], [9, true, true, 'hard to undo'])
  }
  assert.equal(scoreChoice({ label: 'delivery', value: 'preview deleting user records', options: [] }, context, match).flagged, false)
})

test('access wording needs both an access word and a grant or restriction cue in one option', () => {
  for (const choice of [
    { label: 'trigger', value: 'role changes, email changes', options: ['+ user deletion'] },
    { label: 'keep admin access', value: 'unchanged', options: ['review'] },
    { label: 'trigger', value: 'role changes', options: ['keep email notifications'] },
  ]) {
    const review = scoreChoice(choice, context)
    assert.deepEqual([review.pinned, review.c, review.flagged], [false, 2, false], choice.label)
  }
  for (const choice of [
    { label: 'membership', value: 'wait for re-invitation', options: ['Can SIGN-IN after re-invitation'] },
    { label: 'membres retirés', value: 'Révoquer l’accès', options: ['en attente'] },
  ]) {
    const review = scoreChoice(choice, context)
    assert.deepEqual([review.pinned, review.c, review.flagged, review.reason], [true, 9, true, 'changes access'])
  }
})

test('the soft-delete receipt flags migration and access and logs all four choices', () => {
  const { prompt, choices } = softDelete
  const migration = choices[0]!
  const path = 'drizzle/migrations/0007_add_removed_at.sql'
  const marks = new Map([[nameKey(migration.label), { position: 1, words: '', choice: migration.value }]])
  const scored = reviewReceiptEdits(choices, { prompt, rows: [] }, [{ path, matched: true }], marks)
  const logged = JSON.parse(reviewLogLine('soft-delete', 'claude-code', 'fixture', prompt, scored))
  const expected = [
    [true, 0.5, 9, 4.5, true, 'changes a migration', 'matched edit', 'named'],
    [true, 0.5, 9, 4.5, true, 'changes access', "agent's word", 'none'],
    // Known semantic miss for the pilot: the list-only change falls short of "everywhere".
    [true, 0.5, 2, 1, false, 'not on the card', "agent's word", 'none'],
    [true, 0.5, 2, 1, false, 'not on the card', "agent's word", 'none'],
  ]
  const scores = ({ signals, d, c, score, flagged, reason, evidence, linkKind }: ChoiceReview) =>
    [signals.silent, d, c, score, flagged, reason, evidence, linkKind]
  assert.deepEqual(scored.map(({ review }) => scores(review!)), expected)
  assert.deepEqual(logged.choices.map(scores), expected)
  assert.deepEqual(logged.choices.map(({ label, signals, paths }: ChoiceReview & { label: string }) => [label, signals, paths]),
    scored.map(({ label, review }, i) => [label, review!.signals, i === 0 ? [path] : []]))
})

test('material format, dependency, shared config and cross-file references score three', () => {
  for (const [edit, reason] of [
    [{ path: 'orders.csv' }, 'changes a data format'],
    [{ path: 'events.jsonl' }, 'changes a data format'],
    [{ path: 'wire/serialization.ts' }, 'changes a data format'],
    [{ path: 'package.json', dependencies: true }, 'changes dependencies'],
    [{ path: 'tsconfig.json' }, 'changes shared config'],
    [{ path: 'src/cache.ts', referencedName: 'cachedQuery' }, 'other files use cachedQuery'],
  ] as const) {
    const review = scoreChoice(cache, context, named(edit))
    assert.deepEqual([review.c, review.flagged, review.reason], [3, true, reason])
    const nearby = scoreChoice(cache, context, { kind: 'timing', edits: [edit] })
    assert.deepEqual([nearby.c, nearby.flagged, nearby.reason, nearby.evidence], [3, true, 'not on the card', 'nearby edit'])
  }
  const typo = scoreChoice({ label: 'description', value: 'correct spelling', options: ['correct spelling', 'leave it'] },
    context, named({ path: 'package.json', dependencies: false }))
  assert.deepEqual([typo.c, typo.flagged, typo.evidence], [1, false, 'matched edit'])
})

test('the backtest availability choice matches the active profile without edit evidence', () => {
  const prompt = 'Backtest the strategy using historical financial statements.'
  const expert = reviewExpertDecisions(ASSETS.bundles!, auditExpertProfiles(prompt), 'en', () => 'standard')
  const choice = { label: 'statement availability', value: 'fiscal period end', options: ['fiscal period end', 'filing date'] }
  const review = scoreChoice(choice, { prompt, expert })
  assert.deepEqual([review.signals.silent, review.c, review.flagged, review.reason, review.evidence],
    [true, 3, true, '◆ ml-research decision', "agent's word"])
  assert.equal(scoreChoice({ ...choice, label: 'feature_fallback' }, { prompt, expert }, match).costReason, '◆ ml-research decision')
})

test('reason precedence and stable score order', () => {
  const learned = { cache: { label: 'Redis', count: 2 } }
  const migration = named({ path: 'migrations/0001.sql' })
  const pinned = scoreChoice(cache, { ...context, learned }, migration)
  assert.equal(pinned.reason, 'changes a migration')
  const contradiction = scoreChoice(cache, { prompt: 'Use Redis', learned }, migration)
  assert.equal(contradiction.reason, 'your prompt said "Redis"')
  const conflict = scoreChoice(cache, { ...context, learned }, named({ path: 'orders.jsonl' }))
  assert.equal(conflict.reason, 'you usually pick Redis')
  const choices = [false, true, true, true, false].map((flagged, i) =>
    ({ i, review: { flagged, score: [0, 3, 9, 3, 1][i]! } }))
  assert.deepEqual(reviewOrder(choices).map(({ i }) => i), [2, 1, 3, 0, 4])
})

test('only a named changed path or uniquely timed edit provides receipt evidence', () => {
  const choices: ReviewChoice[] = [
    cache, { ...cache, label: 'layout' }, { ...cache, label: 'algorithm' }, { ...cache, label: 'effects' },
  ]
  const marks = new Map([
    ['cache', { position: 1, words: 'In sql/cache.ts.', choice: 'in memory' }],
    ['layout', { position: 4, words: 'In styles.css', choice: 'in memory' }],
    ['algorithm', { position: 4, words: '', choice: 'in memory' }],
    ['effect', { position: 6, words: '', choice: 'in memory' }],
  ])
  const edits = [
    { path: 'sql/cache.ts', matched: true, position: 5 }, { path: 'do-not-link.ts', matched: true, position: 5 },
    { path: 'timed.ts', matched: true, position: 7 },
  ]
  const output = reviewReceiptEdits(choices, context, edits, marks, ['styles.css'])
  assert.deepEqual(output.map(({ review }) => [review?.linkKind, review?.evidence, review?.paths, review?.c, review?.flagged]), [
    ['named', 'matched edit', ['sql/cache.ts'], 1, false], ['none', "agent's word", [], 2, false],
    ['none', "agent's word", [], 2, false], ['timing', 'nearby edit', ['timed.ts'], 2, false],
  ])
})

test('a silent choice only pins a migration it names', () => {
  const choice = { label: 'hide removed members', value: 'members list and all membership lookups',
    options: ['members list only', 'also the activity feed'] }
  const marks = new Map([[nameKey(choice.label), { position: 1, words: '', choice: choice.value }]])
  const edits = [{ path: 'lib/db/migrations/0001_x.sql', matched: true, position: 2 }]
  const [nearby, matched, local] = reviewReceiptEdits([choice, { ...choice, value: 'add a migration file' },
    { ...choice, value: 'filter in members.ts' }], context,
  [...edits, { path: 'lib/db/members.ts', matched: true, position: 3 }], marks)
  const rows = [nearby, matched, local].map((entry) => {
    const { d, c, score, pinned, flagged, reason, evidence, linkKind, paths } = entry!.review!
    return [d, c, score, pinned, flagged, reason, evidence, linkKind, paths]
  })
  assert.deepEqual(rows, [
    [0.5, 3, 1.5, false, true, 'not on the card', 'nearby edit', 'timing', ['lib/db/migrations/0001_x.sql', 'lib/db/members.ts']],
    [0.5, 9, 4.5, true, true, 'changes a migration', 'matched edit', 'named', ['lib/db/migrations/0001_x.sql']],
    [0.5, 1, 0.5, false, false, 'not on the card', 'matched edit', 'named', ['lib/db/members.ts']],
  ])
  const logged = JSON.parse(reviewLogLine('nearby-migration', 'claude-code', 'fixture', context.prompt, [nearby!]))
  assert.equal(logged.choices[0].linkKind, 'timing')
})

test('the private pilot line keeps the prompt ends and only the permitted choice information', async () => {
  const prompt = `START${'🟢'.repeat(5000)}END`
  const edit = { path: 'src/cache.ts', hunks: [{ lines: ['PRIVATE HUNK'] }] }
  const review = scoreChoice(cache, context, named(edit))
  const line = reviewLogLine('receipt-1', 'claude-code', await reviewRootHash('/project'), prompt, [{ ...cache, review }],
    '2026-11-26T12:00:00.000Z')
  const item = JSON.parse(line)
  assert.equal(Array.from(item.prompt).length, 4000)
  assert.match(item.prompt, /^START[\s\S]*\n…\n[\s\S]*END$/)
  assert.match(item.projectRootHash, /^[a-f\d]{64}$/)
  assert.deepEqual(item.choices[0].paths, ['src/cache.ts'])
  assert.deepEqual(item.choices[0].alternatives, ['Redis'])
  assert.ok(!line.includes('PRIVATE HUNK') && !line.includes('/project') && !line.includes('\n'))
})

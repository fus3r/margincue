import assert from 'node:assert/strict'
import { test } from 'node:test'
import './ts-resolve.ts'
import type { Effect, Event, View } from '../mods/claude-code/core/index'

const { createCore } = await import('../mods/claude-code/core/index')
const card = await import('../mods/claude-code/core/card')
const grounding = await import('../mods/claude-code/core/grounding')
const { ASSETS } = await import('../mods/claude-code/hooks/assets')

const OPEN = '⟦'
const CLOSE = '⟧'
const DRAFT = 'Add a CSV export to the orders page for big accounts.'
const READING = [
  'read | You want a CSV download of orders that copes with very large accounts.',
  'kind | change',
  'row | export_rows | rows | one | Export {} | the filtered orders | all orders | @CSV export',
  'row | export_limit | max rows | num | Cap one export at {} | 100000 | 1000 | 1000000 | rows',
].join('\n')

const config = (extra: Partial<Extract<Event, { type: 'config' }>> = {}): Event =>
  ({ type: 'config', mode: 'auto', profile: 'general', enabled: true, sheet: true, streaming: false, eagerPlan: false, ...extra })
const requests = (effects: Effect[]) => effects.filter((effect): effect is Extract<Effect, { type: 'request' }> => effect.type === 'request')
const lastView = (effects: Effect[]): View | undefined =>
  effects.filter((effect): effect is Extract<Effect, { type: 'view' }> => effect.type === 'view').at(-1)?.view

test('card replies parse into typed rows and skip what is malformed', () => {
  const parsed = card.parseCard([
    'Here is the card:', READING,
    'row | 9 lives | x | one | X {} | a | b',
    'row | two_holes | x | one | {} and {} | a | b',
    'row | lonely | x | one | Pick {} | only one',
    'row | ranged | speed | range | Run {} | slow | normal* | fast',
    'row | picks | detect | many | Detect {} | collisions* | clipping* | frame drops',
    'row | export_rows | rows | one | Export {} | again | twice',
  ].join('\n'))
  assert.equal(parsed.read, 'You want a CSV download of orders that copes with very large accounts.')
  assert.equal(parsed.kind, 'change')
  assert.deepEqual(parsed.rows.map((row) => [row.key, row.type, row.defaults]), [
    ['export_rows', 'one', [0]], ['export_limit', 'range', [6]], ['ranged', 'range', [1]], ['picks', 'many', [0, 1]],
  ])
  assert.equal(parsed.rows[0]!.anchor, 'CSV export')
  assert.equal(parsed.rows[1]!.unit, 'rows')
  assert.equal(parsed.rows[1]!.options[parsed.rows[1]!.defaults[0]!], '100000 rows')
})

test('an anchor written into the last option is taken out of it', () => {
  const row = card.parseCard('row | source | source | one | Use {} | existing play logs | new event logging | both @play logs').rows[0]!
  assert.deepEqual(row.options, ['existing play logs', 'new event logging', 'both'])
  assert.equal(row.anchor, 'play logs')
})

test('words joined by a slash link when the code has the path but are never called missing', () => {
  const tiny = grounding.indexVocabulary(grounding.buildVocabulary({ files: ['demo/a.ts', 'demo/b.ts'], declarations: '', names: '' }))
  const found = grounding.ground('An agent proposed a demo/, still basic/AI-slop, see Logs/Analytics and src/main.ts.', tiny)
  assert.deepEqual(found.map((m) => [m.phrase, m.status]), [['demo/', 'found'], ['src/main.ts', 'missing']])
})

test('number rows become readable steps that include the default', () => {
  assert.deepEqual(card.numberSteps(45, 5, 300), [5, 8, 14, 25, 40, 45, 65, 110, 180, 300])
  assert.deepEqual(card.numberSteps(500, 100, 5000), [100, 160, 270, 430, 500, 710, 1200, 1900, 3100, 5000])
  assert.deepEqual(card.numberSteps(100000, 1000, 1000000), [1000, 2400, 5600, 13000, 32000, 75000, 100000, 180000, 420000, 1000000])
  assert.deepEqual(card.numberSteps(3, 0, 10), [0, 1, 3, 4, 5, 6, 8, 9, 10])
  assert.deepEqual(card.numberSteps(1, 1, 1), [])
  assert.equal(card.formatNumber(30, '%'), '30%')
  assert.equal(card.formatNumber(2.5, 's'), '2.5 s')
})

test('values, cycling and toggling follow the row type', () => {
  const many = { type: 'many' as const, options: ['a', 'b', 'c'], defaults: [0, 1] }
  assert.equal(card.rowValue(many, [1, 0]), 'a and b')
  assert.equal(card.rowValue(many, []), 'none of these')
  assert.deepEqual(card.cycleSelection(many, [0, 1]), [0, 1, 2])
  assert.deepEqual(card.cycleSelection(many, [0, 1, 2]), [0])
  assert.deepEqual(card.cycleSelection(many, [0]), [0, 1])
  const one = { type: 'one' as const, options: ['x', 'y', 'z'], defaults: [0] }
  assert.deepEqual(card.cycleSelection(one, [2]), [0])
  assert.deepEqual(card.cycleSelection(one, [0], -1), [2])
  assert.deepEqual(card.toggleSelection(many, [0, 1], 1), [0])
  assert.deepEqual(card.toggleSelection(one, [0], 2), [2])
})

test('sketches keep their drawing and drop fences, margins and NONE', () => {
  assert.equal(card.parseSketch('NONE'), null)
  const sketch = card.parseSketch('```\ntitle | Report after a run\n   run 14 · 3 findings\n     ▲ collisions\n```')
  assert.deepEqual(sketch, { title: 'Report after a run', lines: ['run 14 · 3 findings', '  ▲ collisions'] })
})

test('blanks are read from prose only and drawn as their value', () => {
  const text = `Logs go to ${OPEN}run log: one JSONL file | SQLite${CLOSE}. ` +
    `\`${OPEN}not: this | one${CLOSE}\` and ${OPEN}no alternatives: x${CLOSE} and ${OPEN}stuck after: 45 s | 30 s | 45 s${CLOSE}.`
  const blanks = card.parseBlanks(text)
  assert.deepEqual(blanks.map((b) => [b.label, b.choice, b.alternatives]), [
    ['run log', 'one JSONL file', ['SQLite']], ['stuck after', '45 s', ['30 s']],
  ])
  const drawn = card.renderBlanks(text, (blank) => blank.label === 'stuck after' ? '30 s' : undefined)
  assert.ok(drawn.startsWith('Logs go to **one JSONL file**.'))
  assert.ok(drawn.endsWith('and **30 s** (was 45 s).'))
})

const vocab = grounding.buildVocabulary({
  files: ['app/src/entities/traffic.ts', 'app/src/threat/index.ts', 'app/src/threat/pursuit.ts', 'app/src/map/canvas.ts',
    'tools/runlog/analyze.mjs', 'tools/runlog/qa.mjs', 'app/src/runlog/writer.ts', 'app/src/runlog/events.ts', 'README.md'],
  declarations: 'app/src/entities/traffic.ts:4:export type Vehicle\napp/src/threat/index.ts:2:export class Threat\n',
  names: "app/src/map/canvas.ts:9:'South of Market'\napp/src/map/canvas.ts:11:'Maya'\n",
})
const index = grounding.indexVocabulary(vocab)

test('grounding links names to the code and offers the nearest names for a missing one', () => {
  const draft = 'Vehicles clip through walls, threats stall, and Maya takes ages to leave the Old Market. Fix the Logs/Analytics part.'
  const mentions = grounding.ground(draft, index)
  assert.deepEqual(mentions.map((m) => [m.phrase, m.status, m.files[0] ?? m.near[0]?.name]), [
    ['Vehicles', 'found', 'app/src/entities/traffic.ts'],
    ['threats', 'found', 'app/src/threat/index.ts'],
    ['Maya', 'found', 'app/src/map/canvas.ts'],
    ['Old Market', 'missing', 'South of Market'],
  ])
  assert.deepEqual(grounding.ground('Fix the button on the settings page please.', index), [])
})

test('references cite only what the draft wrote as code; common words and bare file stems do not link', () => {
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    files: ['tools/mine/public_adapters.py', 'bench/latency/codex.mjs', 'src/export/csv_writer.ts'],
    declarations: 'tools/mine/public_adapters.py:3:class Session\nsrc/export/csv_writer.ts:1:export function writeCsv\n',
    names: '',
  }))
  const text = 'I tested it live in another session with Codex; now make writeCsv stream rows.'
  assert.deepEqual(grounding.ground(text, repo).map((m) => [m.phrase, m.status, m.as]), [['writeCsv', 'found', 'code']])
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'vocabulary', vocab: repo.vocab })
  core.handle({ type: 'draft', now: 100, text, origin: 'paste' })
  const sent = core.handle({ type: 'submit', now: 200, text }).find((e): e is Extract<Effect, { type: 'submit' }> => e.type === 'submit')!
  assert.equal(sent.text, `${text}\n\nDecisions:\n- Where things are: writeCsv (src/export/csv_writer.ts).`)
})

test('options travel whole: a long option is kept as written, a too-long one is left out', () => {
  const long = 'running live in Claude Code and checking the frames'
  const row = card.parseCard(`row | verify | verify | one | Verify it by {} | ${long} | running the tests | ${'x'.repeat(90)}`).rows[0]!
  assert.deepEqual(row.options, [long, 'running the tests'])
})

test("the project's own name and words matching many folders do not point to a folder", () => {
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    project: 'MarginCue',
    files: ['demo/margincue-x/render.py', 'demo/margincue-x/capture.py', 'crates/margincue-codex/main.rs', 'crates/margincue-codex/sheet.rs',
      'mods/claude-code/hooks/band.ts', 'mods/claude-code/hooks/register.tsx'],
    declarations: '', names: '',
  }))
  assert.deepEqual(grounding.relatedFolders('Drastically improve the current UI of MarginCue and its hooks', repo).map((f) => f.dir),
    ['mods/claude-code/hooks'])
})

const project = await import('../mods/claude-code/core/project')
const vocabOf = (name: string, files: string[], libs: Record<string, number> = {}) =>
  ({ ...grounding.buildVocabulary({ files, declarations: '', names: '' }), project: name, libs })

test('a project tells which expert profile it calls for and what is at stake there', () => {
  const lens = (v: ReturnType<typeof vocabOf>) => project.detectLenses(v).map((l) => [l.profile, l.rigor])
  assert.deepEqual(lens(vocabOf('dataset-challenge', ['Project_train.csv', 'Project_test.csv', 'submission.zip', 'research.ipynb',
    'results/a.png'], { sklearn: 4, pandas: 9 })), [['ml-research', 'compete']])
  assert.deepEqual(lens(vocabOf('researchlang', ['research/x.py', 'paper/main.md', 'benchmarks/a/submission.json', 'pyproject.toml'],
    { numpy: 3, scipy: 2, torch: 1 })), [['ml-research', 'study']])
  assert.deepEqual(lens(vocabOf('weekend-hackathon', ['app.py', 'notebook.ipynb'], { pandas: 1, numpy: 1 })), [['ml-research', 'compete']])
  assert.deepEqual(lens(vocabOf('Tiny Town', ['app/src/main.ts', 'app/src/city/index.ts'], { three: 40 })), [])
  assert.deepEqual(lens(vocabOf('orders', ['Dockerfile', 'docker-compose.yml', 'migrations/001.sql', 'src/api.ts'], { kafkajs: 3 })),
    [['system-design', 'build']])
})

test('libraries are counted from imports, notebooks and manifests', () => {
  const libs = project.countLibraries(['from sklearn', 'import torch', '"import pandas', "from './card'", "require('ioredis'",
    'numpy==1.26', '  "lightgbm', '- xgboost', '"@nestjs/core": "^10', "from '@tensorflow/tfjs'"].join('\n'))
  for (const lib of ['sklearn', 'torch', 'pandas', 'ioredis', 'numpy', 'lightgbm', 'xgboost', 'nestjs', 'tfjs']) assert.ok(libs[lib], lib)
  assert.equal(libs['.'], undefined)
})

test("a project's profile reaches every reading, as cached system text, at the project's stakes", () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'vocabulary', vocab: vocabOf('finalchallengedata', ['train.csv', 'test.csv', 'submission.csv', 'eda.ipynb'], { lightgbm: 3 }) })
  const text = 'Clean up the plotting code in the notebook so the figures are readable.'
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  assert.ok(req!.system.some((block) => block.startsWith('Expert decisions (ml-research; this project: a challenge or competition')))
  assert.ok(!req!.prompt.includes('Expert decisions'))
  assert.deepEqual(core.projectProfiles().map((l) => [l.profile, l.rigor]), [['ml-research', 'compete']])
  // Study-only decisions wait for a project that studies; a challenge gets those that matter when scored.
  const offered = req!.system.find((block) => block.startsWith('Expert decisions'))!
  assert.match(offered, /final_score_partition/)
  assert.doesNotMatch(offered, /multiplicity_scope|coverage_scope/)
})

const onboarding = await import('../mods/claude-code/hooks/onboarding')

test('the first-run questions follow the answers, and the answers become one line about the person', async () => {
  const answers: Record<string, string> = {
    'Your work': 'Data science and ML, Apps and products, quant research',
    'ML level': 'Researcher (I publish or review)',
    'You decide': 'What gets built, Data and results',
  }
  const asked: string[] = []
  const user = await onboarding.interview(async (_question, options) => {
    asked.push(options.header)
    return answers[options.header]!
  })
  assert.deepEqual(asked, ['Your work', 'ML level', 'You decide'])
  assert.deepEqual(user, { work: ['ml', 'apps'], levels: { 'ml-research': 'expert' }, decide: ['scope', 'data'], note: 'quant research' })
  assert.equal(onboarding.describeUser(user), 'Works on apps and products and data science and machine learning (statistics and ML: researcher). ' +
    'In their words: quant research. Makes these choices themselves: what gets built and how data and results are handled; ' +
    'leaves architecture and code-level details to the agent.')
  assert.deepEqual(onboarding.preferredProfiles(user), ['ml-research'])
  assert.equal(onboarding.depthFor('learning'), 'essentials')
  assert.equal(onboarding.depthFor('expert'), 'research')
  assert.deepEqual(onboarding.readUser({ work: ['ml'], levels: { 'ml-research': 'guru' }, decide: [] }), { work: ['ml'], levels: {}, decide: [] })
  assert.equal(onboarding.readUser('nope'), null)
  await assert.rejects(onboarding.interview(async () => { throw new Error('dismissed') }))
})

test('who the person is reaches the reading, their level sets each field\'s depth, and their fields need less evidence', () => {
  const user = 'Works on data science and machine learning (statistics and ML: learning).'
  const weak = vocabOf('homework-3', ['solution.ipynb', 'helpers.py'])
  assert.deepEqual(project.detectLenses(weak), [])
  assert.deepEqual(project.detectLenses(weak, ['ml-research']).map((l) => l.profile), ['ml-research'])
  const core = createCore(ASSETS)
  core.handle(config({ user, prefer: ['ml-research'], depths: { 'ml-research': 'essentials' }, depth: 'research' }))
  core.handle({ type: 'vocabulary', vocab: weak })
  const text = 'Train a model on the homework data and tell me how well it does on new data.'
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  assert.equal(req!.system[1], `About the developer: ${user}`)
  const offered = req!.system.find((block) => block.startsWith('Expert decisions (ml-research'))!
  const bundle = ASSETS.bundles!.find((b) => b.profile === 'ml-research')!
  const ids = [...offered.matchAll(/^([a-z_]+) \| when:/gm)].map((m) => m[1]!)
  assert.ok(ids.length > 0)
  // A learner's depth: essentials only, however deep the rest is set.
  assert.ok(ids.every((id) => bundle.slots.find((slot) => slot.id === id)!.tier === 'essential'))
})

test('related folders come from the words of the draft', () => {
  const folders = grounding.relatedFolders('Work deeply on the logging of play runs and the threats', index)
  assert.deepEqual(folders.map((f) => f.dir), ['tools/runlog', 'app/src/runlog', 'app/src/threat'])
  assert.match(vocab.map, /app\/src\/runlog\/ \(2\): writer\.ts, events\.ts/)
})

test('the card reads a long draft at once at a sentence end and attaches only what is set', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'vocabulary', vocab })
  const long = `${DRAFT} ${'It should also stay quick for small accounts and keep the current filters working. '.repeat(4)}`.trim()
  const typed = core.handle({ type: 'draft', now: 100, text: long, origin: 'type', edit: { start: long.length - 1, end: long.length - 1, text: '.' } })
  const [req] = requests(typed)
  assert.equal(req?.kind, 'card')
  assert.ok(req!.prompt.startsWith(`Draft:\n<<<\n${long}\n>>>`))
  assert.match(req!.system[0]!, /in English, even when the draft is not/)
  assert.match(req!.system[1]!, /^Repository outline/)
  const shown = lastView(core.handle({ type: 'reply', now: 2000, req: req!.req, text: READING, done: true }))!
  assert.equal(shown.card?.read, 'You want a CSV download of orders that copes with very large accounts.')
  assert.deepEqual(shown.card?.rows.map((row) => [row.key, row.selected, row.chosen]), [['export_rows', [0], false], ['export_limit', [6], false]])
  assert.deepEqual(shown.decisions, [])
  // A change to something that exists gets no sketch: it would have to invent what it changes.
  assert.equal(requests(core.handle({ type: 'timer', now: 2000 })).length, 0)
  const cycled = lastView(core.handle({ type: 'cardCycle', now: 2100 }))!
  assert.deepEqual(cycled.card?.rows[0]?.selected, [1])
  assert.deepEqual(cycled.decisions, ['Export all orders.'])
  core.handle({ type: 'cardFocus', dir: 1 })
  core.handle({ type: 'cardSet', now: 2200, row: cycled.card!.rows[1]!.id, option: 0 })
  const sent = core.handle({ type: 'submit', now: 2300, text: long })
  assert.equal(sent.find((e) => e.type === 'submit' && 'text' in e)?.type, 'submit')
  const submit = sent.find((e): e is Extract<Effect, { type: 'submit' }> => e.type === 'submit')!
  assert.equal(submit.text, `${long}\n\nDecisions:\n- Export all orders.\n- Cap one export at 1000 rows.`)
  assert.deepEqual(sent.filter((e) => e.type === 'learn'), [
    { type: 'learn', key: 'export_rows', label: 'all orders' },
    { type: 'learn', key: 'export_limit', label: '1000 rows' },
  ])
})

test('during a turn, switching a marked choice sends one amendment after the last press', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'submit', now: 100, text: 'Make the run logs useful for finding bugs in the game.' })
  core.handle({ type: 'turnStart', now: 110 })
  const marked = lastView(core.handle({ type: 'blank', now: 200, label: 'stuck after', choice: '45 s', alternatives: ['30 s', '60 s'] }))!
  assert.equal(marked.card?.stage, 'turn')
  assert.deepEqual(marked.card?.rows[0]?.options, ['45 s', '30 s', '60 s'])
  assert.deepEqual(core.handle({ type: 'cardCycle', now: 300 }).filter((e) => e.type === 'amend'), [])
  assert.deepEqual(core.handle({ type: 'cardCycle', now: 400 }).filter((e) => e.type === 'amend'), [])
  const sent = core.handle({ type: 'timer', now: 1900 }).filter((e) => e.type === 'amend')
  assert.deepEqual(sent.map((e) => 'text' in e && e.text), ['Amendment to my last prompt: for stuck after, use 60 s instead of 45 s.'])
  const after = lastView(core.handle({ type: 'endAmendment', now: 3000 }))!
  assert.deepEqual(after.receipt, { id: 1, yours: [], agent: [{ label: 'stuck after', value: '60 s', was: '45 s', options: ['45 s', '30 s', '60 s'] }] })
  assert.equal(after.card?.stage, 'after')
  const fill = core.handle({ type: 'cardSet', now: 3100, row: after.card!.rows[0]!.id, option: 1 }).find((e) => e.type === 'fill')
  assert.deepEqual(fill, { type: 'fill', text: 'Change stuck after: 30 s instead of 60 s. Keep everything else as it is.', replaces: null })
})

test('expert words bring a profile catalog into the reading, and its decisions keep the catalog wording', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const text = 'Train a churn classifier on the customer dataset and report test accuracy against a baseline.'
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  assert.equal(req?.kind, 'card')
  assert.match(req!.prompt, /Expert decisions \(ml-research\)/)
  assert.match(req!.prompt, /split_strategy \| when: /)
  const reply = 'read | You want a churn classifier with an honest test score.\nkind | build\n' +
    'row | split_strategy | split | one | Hold out {} | new customers | later records | @test accuracy'
  const view = lastView(core.handle({ type: 'reply', now: 900, req: req!.req, text: reply, done: true }))!
  const row = view.card!.rows[0]!
  assert.equal(row.origin, 'lens')
  assert.equal(row.lens, 'ml-research')
  // The catalog's wording at the configured depth (standard reads the expert phrasing), not the reply's.
  const slot = ASSETS.bundles!.find((b) => b.profile === 'ml-research')!.slots.find((s) => s.id === 'split_strategy')!
  assert.ok([slot.statement.en.plain, slot.statement.en.expert].includes(row.statement))
  assert.notEqual(row.statement, 'Hold out {}')
  assert.equal(row.options.length, slot.options.length)
  assert.equal(row.start, text.indexOf('test accuracy'))
})

test('a follow-up written while the agent works gets its own card, its decisions travel, and the agent\'s choices come back', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'submit', now: 100, text: 'Build deep analytics for my play logs so you can find bugs.' })
  core.handle({ type: 'blank', now: 200, label: 'log format', choice: 'one JSONL file per run', alternatives: ['SQLite'] })
  const follow = 'Also make sure the analytics run on Windows and Linux machines.'
  const drafted = core.handle({ type: 'draft', now: 300, text: follow, origin: 'paste' })
  const [req] = requests(drafted)
  assert.equal(req?.kind, 'card')
  const reply = 'read | You want the analytics to run on Windows and Linux too.\nkind | change\nrow | ci | checked by | one | Check it {} | in CI on both | by hand once'
  const shown = lastView(core.handle({ type: 'reply', now: 900, req: req!.req, text: reply, done: true }))!
  assert.equal(shown.card?.stage, 'draft')
  // A choice the agent marks meanwhile still lands on the turn's card, behind the draft.
  core.handle({ type: 'blank', now: 950, label: 'stuck after', choice: '45 s', alternatives: ['30 s'] })
  core.handle({ type: 'cardSet', now: 1000, row: shown.card!.rows[0]!.id, option: 1 })
  const sent = core.handle({ type: 'submit', now: 1100, text: follow, amendable: false })
  const submit = sent.find((e): e is Extract<Effect, { type: 'submit' }> => e.type === 'submit')!
  assert.equal(submit.text, `${follow}\n\nDecisions:\n- Check it by hand once.`)
  const back = lastView(sent)!
  assert.equal(back.card?.stage, 'turn')
  assert.deepEqual(back.card?.rows.map((row) => row.label), ['log format', 'stuck after'])
  const end = lastView(core.handle({ type: 'endAmendment', now: 2000 }))!
  assert.deepEqual(end.receipt?.yours, [])
  assert.deepEqual(end.receipt?.agent.map((item) => item.label), ['log format', 'stuck after'])
  // The engine runs the queued message as the next turn: its decision is in that turn's receipt.
  core.handle({ type: 'turnStart', now: 2100 })
  const next = lastView(core.handle({ type: 'endAmendment', now: 3000 }))!
  assert.deepEqual(next.receipt?.yours, ['Check it by hand once.'])
})

test('paths a draft writes resolve as paths, and a name being introduced is not called missing', () => {
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    files: ['spec/card.unit.ts', 'mods/claude-code/hooks/card-view.ts', 'mods/claude-code/core/card.ts'],
    declarations: 'mods/claude-code/hooks/card-view.ts:80:export function layoutCard\n', names: '',
  }))
  const text = 'Fix the failing test in spec/card.unit.ts, then rename layoutCard to drawCard in hooks/card-view.ts and add a new ExportPanel.'
  assert.deepEqual(grounding.ground(text, repo).map((m) => [m.phrase, m.status, m.files[0] ?? '']), [
    ['spec/card.unit.ts', 'found', 'spec/card.unit.ts'],
    ['layoutCard', 'found', 'mods/claude-code/hooks/card-view.ts'],
    ['hooks/card-view.ts', 'found', 'mods/claude-code/hooks/card-view.ts'],
  ])
})

test('a question is answered, not built: its card is the reading alone', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const text = 'Why does the band flicker when I type fast in the terminal?'
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  const view = lastView(core.handle({ type: 'reply', now: 900, req: req!.req, done: true,
    text: 'read | You want the cause of the flicker explained.\nkind | ask\nrow | scope | scope | one | Look at {} | the band only | the whole render path' }))!
  assert.equal(view.card?.read, 'You want the cause of the flicker explained.')
  assert.deepEqual(view.card?.rows, [])
})

test('a product named in prose is not a misremembered code name; a near miss of a place still is', () => {
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    files: ['tools/run_claude.py', 'bench/codex.mjs', 'server/app-server.ts', 'game/zones.ts'],
    declarations: 'tools/run_claude.py:3:def run_claude\nbench/codex.mjs:1:export const CODEX\nserver/app-server.ts:1:export class AppServer\n',
    names: 'game/zones.ts:4:"South of Market"\ngame/zones.ts:5:"Produce Market"\n',
  }))
  const products = 'Make it available in the Claude Desktop Appp and the Codex Desktop App too.'
  assert.deepEqual(grounding.ground(products, repo).filter((m) => m.near.length).map((m) => m.phrase), [])
  const place = grounding.ground('Count how often Maya gets stuck in the Old Market.', repo).find((m) => m.phrase === 'Old Market')
  assert.equal(place?.status, 'missing')
  assert.deepEqual(place?.near.map((n) => n.name), ['Produce Market', 'South of Market'])
})

test('"to the X page" points at something that should exist; only a renaming "to" introduces a name', () => {
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    files: ['lib/db/schema.ts', 'lib/db/queries.ts'],
    declarations: 'lib/db/schema.ts:40:export const activityLogs\nlib/db/queries.ts:90:export async function getActivityLogs\n',
    names: '',
  }))
  const asked = grounding.ground('Add an export button to the Audit Log page so owners can download it.', repo)
  assert.deepEqual(asked.map((m) => [m.phrase, m.status, m.near.map((n) => n.name)]),
    [['Audit Log', 'missing', ['activityLogs', 'getActivityLogs']]])
  // Ties go to a name that ends on the same word.
  const typed = grounding.indexVocabulary(grounding.buildVocabulary({ files: ['lib/db/schema.ts'],
    declarations: 'lib/db/schema.ts:1:export async function logActivity\nlib/db/schema.ts:9:export type ActivityLog\n', names: '' }))
  assert.deepEqual(grounding.ground('Fix the Audit Log export.', typed)[0]?.near.map((n) => n.name), ['ActivityLog', 'logActivity'])
  assert.deepEqual(grounding.ground('Rename the Activity page to the Audit Log page.', repo).filter((m) => m.status === 'missing'), [])
  assert.deepEqual(grounding.ground('Add a new Audit Log page next to Activity.', repo).filter((m) => m.status === 'missing'), [])
})

test('a streamed reading shows its line first and each row as it completes; the sketch waits for the end', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const [req] = requests(core.handle({ type: 'draft', now: 100, text: DRAFT, origin: 'paste' }))
  const [line, ...rows] = READING.split('\n')
  const first = lastView(core.handle({ type: 'reply', now: 300, req: req!.req, text: `${line}\n${rows[0]}\nro`, done: false }))!
  assert.equal(first.card?.read, 'You want a CSV download of orders that copes with very large accounts.')
  assert.deepEqual(first.card?.rows.map((row) => row.key), [])
  const more = core.handle({ type: 'reply', now: 400, req: req!.req, text: `w | export_rows | rows | one | Export {} | the filtered orders | all orders | @CSV export\n`, done: false })
  assert.deepEqual(lastView(more)!.card?.rows.map((row) => row.key), ['export_rows'])
  assert.equal(requests(more).length, 0)
  const end = core.handle({ type: 'reply', now: 500, req: req!.req, text: `${rows[2]}\n`, done: true })
  assert.deepEqual(lastView(end)!.card?.rows.map((row) => row.key), ['export_rows', 'export_limit'])
})

test('picks that are lists themselves stay apart in a decision', () => {
  assert.equal(card.joinList(['sign-ins', 'invitations', 'role changes']), 'sign-ins, invitations and role changes')
  assert.equal(card.joinList(['name, email, message', 'company and role', 'phone number']), 'name, email, message; company and role; phone number')
})

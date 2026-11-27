import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import reviewFixtures from './fixtures/autoreview-replies.json' with { type: 'json' }
import autoreview2 from './fixtures/autoreview2.json' with { type: 'json' }
import autoreview3 from './fixtures/autoreview3.json' with { type: 'json' }
import autoreview4 from './fixtures/autoreview4.json' with { type: 'json' }
import './ts-resolve.ts'
import type { Depth } from '../mods/claude-code/core/bundle'
import type { Effect, Event, View } from '../mods/claude-code/core/index'

const { createCore, fillStatement, stateCue } = await import('../mods/claude-code/core/index')
const card = await import('../mods/claude-code/core/card')
const { chapterContext } = await import('../mods/claude-code/core/chapters')
const { nearExpertDecision, parseExpert } = await import('../mods/claude-code/core/expert')
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

test('a normal typed draft sends the v0.4.31 card request byte for byte', () => {
  for (const reviewFirst of [false, true]) {
    const core = createCore(ASSETS)
    core.handle(config({ reviewFirst }))
    const request = requests(core.handle({ type: 'draft', now: 100, text: DRAFT, origin: 'type' }))
      .find(({ kind }) => kind === 'card')
    assert.ok(request)
    assert.equal(createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      'fdb751b9c493bbeb795f681f33c5f5380affb305ca6f716e3137dd086730cbbf')
  }
})

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

test('a missing card kind falls back to clear build requests or questions', () => {
  for (const draft of [
    'Build a dashboard export tool.',
    'Add a CSV export to the dashboard.',
    'Please create an export dialog.',
    'Could you make a CSV export?',
    'A new account settings page for team owners.',
  ]) assert.equal(card.deriveCardKind(draft), 'build', draft)
  assert.equal(card.deriveCardKind('How do I create a new settings page?'), 'ask')
  assert.equal(card.deriveCardKind('Is the new settings page live?'), 'ask')
  assert.equal(card.deriveCardKind('Fix the title on the new settings page.'), null)
  assert.equal(card.canSketch(null), false)
})

test('an anchor written into the last option is taken out of it', () => {
  const row = card.parseCard('row | source | source | one | Use {} | existing play logs | new event logging | both @play logs').rows[0]!
  assert.deepEqual(row.options, ['existing play logs', 'new event logging', 'both'])
  assert.equal(row.anchor, 'play logs')
})

test('a quoted anchor is metadata instead of an option', () => {
  const row = card.parseCard('row | interval | scope | one | Cover uncertainty in {} | new suppliers | refitting | "@one bootstrap confidence interval"').rows[0]!
  assert.deepEqual(row.options, ['new suppliers', 'refitting'])
  assert.equal(row.anchor, 'one bootstrap confidence interval')
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

const REQUEST_RANGE = 'row | rate_limit | limit | range | Allow each client {} requests per minute | 1 requests | 100 requests* | 1000 requests'

test('the rate-limit card uses the unit once, even if it was in both the statement and the options', () => {
  const row = card.parseCard(REQUEST_RANGE).rows[0]!
  assert.deepEqual(row.options, ['1 request', '100 requests', '1000 requests'])
  assert.deepEqual(row.defaults, [1])
  assert.deepEqual(row.options.map((value) => fillStatement(row.statement, value)), [
    'Allow each client 1 request per minute',
    'Allow each client 100 requests per minute',
    'Allow each client 1000 requests per minute',
  ])
})

test('range units stay readable with bare options, longer units and compact symbols', () => {
  for (const [type, statement, values, expected] of [
    ['range', 'Allow each client {} requests per minute', '1 request per minute | 100', ['Allow each client 1 request per minute', 'Allow each client 100 requests per minute']],
    ['num', 'Allow each client {} requests per minute', '100 | 1 | 100 | requests', ['Allow each client 1 request per minute', 'Allow each client 100 requests per minute']],
    ['range', 'Set opacity to {}%.', '25% | 75', ['Set opacity to 25%.', 'Set opacity to 75%.']],
    ['range', 'Set the delay to {}.', '1 ms | 100 ms', ['Set the delay to 1 ms.', 'Set the delay to 100 ms.']],
  ] as const) {
    const row = card.parseCard(`row | range_test | limit | ${type} | ${statement} | ${values}`).rows[0]!
    assert.deepEqual([row.options[0]!, row.options.at(-1)!].map((value) => fillStatement(row.statement, value)), expected)
  }
})

test('the rate-limit decision is worded the same on the card, in the prompt and on the receipt', () => {
  const text = 'Add a per-client rate limit to the API.'
  for (const [option, line] of [[0, 'Allow each client 1 request per minute.'], [1, 'Allow each client 100 requests per minute.']] as const) {
    const core = createCore(ASSETS)
    core.handle(config())
    core.handle({ type: 'learned', picks: { rate_limit: { label: '1 requests', count: 2 } } })
    const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
    const card = lastView(core.handle({ type: 'reply', now: 200, req: req!.req, text: REQUEST_RANGE, done: true }))!.card!
    const row = card.rows[0]!
    assert.deepEqual(row.selected, [0])
    assert.equal(row.learned, true)
    const picked = lastView(core.handle({ type: 'cardSet', now: 300, row: row.id, option }))!
    assert.deepEqual(picked.decisions, [line])
    const sent = core.handle({ type: 'submit', now: 400, text }).find((effect) => effect.type === 'submit')!
    assert.equal(sent.text, `${text}\n\nDecisions:\n- ${line}`)
    const end = lastView(core.handle({ type: 'endAmendment', now: 500 }))!
    assert.deepEqual(end.receipt?.yours, [line])
  }
})

test('values, cycling and toggling follow the row type', () => {
  const many = { type: 'many' as const, options: ['a', 'b', 'c'], defaults: [0, 1] }
  assert.equal(card.rowValue(many, [1, 0]), 'a and b')
  assert.equal(card.rowValue(many, []), 'none of these')
  assert.deepEqual(card.cycleSelection(many, [0, 1]), [0, 1, 2])
  assert.deepEqual(card.cycleSelection(many, [0, 1, 2]), [0, 1])
  assert.deepEqual(card.cycleSelection(many, [0]), [0, 1])
  // Each press adds one more extra: never two at once.
  const wide = { type: 'many' as const, options: ['a', 'b', 'c', 'd'], defaults: [0] }
  assert.deepEqual([[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]].map((s) => card.cycleSelection(wide, s)), [[0, 1], [0, 1, 2], [0, 1, 2, 3], [0]])
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
  core.handle(config({ send: 'picked' }))
  core.handle({ type: 'draft', now: 300, text, origin: 'paste' })
  // Where things are comes from the repo index, not from the reading's guesses: it travels in picked mode too.
  assert.equal(core.handle({ type: 'submit', now: 400, text }).find((e) => e.type === 'submit')?.text,
    `${text}\n\nDecisions:\n- Where things are: writeCsv (src/export/csv_writer.ts).`)
})

test('options travel whole: a long option is kept as written, a too-long one is left out', () => {
  const long = 'running live in Claude Code and checking the frames before releasing the new version'
  assert.ok(long.length > card.CARD_OPTION_TARGET)
  const row = card.parseCard(`row | verify | verify | one | Verify it by {} | ${long} | running the tests | ${'x'.repeat(card.MAX_OPTION + 1)}`).rows[0]!
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

test("Claude Code's tags around a folded paste are neither a name, a folder nor a choice, and still reach the agent", () => {
  // A real case (2026-11-27): a paste alone, read at Enter in a repo whose code quotes HTTP status texts.
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    files: ['src/http/status.ts', 'src/http/headers.ts', 'src/content/posts.ts', 'src/content/pages.ts'],
    declarations: 'src/http/status.ts:1:export function statusText\n',
    names: "src/http/status.ts:3:'Unprocessable Content'\nsrc/http/status.ts:4:'Content Too Large'\nsrc/http/headers.ts:2:'Content-Security-Policy'\n",
  }))
  const pasted = "Side note: maybe this isn't the case right now, but our architectural decisions must not rely too much on my analytics data.\n" +
    'I was wondering if the code is ready to actually log data from other users (my friends), or if it is best to wait.\n'
  const text = `\n\n<pasted_content id="f24e">\n${pasted}</pasted_content id="f24e">`
  // Blanked in place: what the draft says is read at the same offsets, and the tags add nothing.
  assert.equal(grounding.blankHostTags(text).length, text.length)
  assert.equal(grounding.blankHostTags(text).trim(), pasted.trim())
  assert.deepEqual(grounding.ground(text, repo), grounding.ground(grounding.blankHostTags(text), repo))
  assert.equal(grounding.ground(text, repo).some((m) => /pasted|content/i.test(m.phrase)), false)
  assert.deepEqual(grounding.relatedFolders(text, repo), [])
  // The person's own words about the tag still count: only the host's markup is blanked.
  assert.deepEqual(grounding.ground('Strip the pasted_content tags before reading.', repo).map((m) => [m.phrase, m.status]),
    [['pasted_content', 'missing']])

  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'vocabulary', vocab: repo.vocab })
  const [request] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste', afterEnter: true, transient: true }))
  assert.equal(request?.kind, 'card')
  assert.doesNotMatch(request!.prompt, /Not found in the code|Folders that may already/)
  assert.deepEqual(core.currentView().card!.rows, [])
  core.handle({ type: 'reply', now: 200, req: request!.req, text: 'read | You ask whether logging from other users is ready.\nkind | question', done: true })
  const sent = core.handle({ type: 'submit', now: 300, text, plan: false, amendable: false })
    .find((effect): effect is Extract<Effect, { type: 'submit' }> => effect.type === 'submit')!
  // The agent gets the paste as Claude Code wrapped it, with no question about the wrapper.
  assert.equal(sent.text, text)
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
    'Agent use': 'Practitioner (I use them regularly)',
    'Product': 'Learning (first product or feature)',
    'ML level': 'Researcher (I publish or review)',
    'You decide': 'What gets built, Data and results',
  }
  const asked: string[] = []
  const user = await onboarding.interview(async (_question, options) => {
    asked.push(options.header)
    return answers[options.header]!
  })
  assert.deepEqual(asked, ['Your work', 'Agent use', 'Product', 'ML level', 'You decide'])
  assert.deepEqual(user, {
    work: ['ml', 'apps'], levels: { general: 'practitioner', product: 'learning', 'ml-research': 'expert' },
    decide: ['scope', 'data'], note: 'quant research',
  })
  assert.equal(onboarding.describeUser(user), 'Works on apps and products (product development: learning) and data science and machine learning (statistics and ML: researcher). ' +
    'States their level in general coding-agent use (practitioner). ' +
    'In their words: quant research. Makes these choices themselves: what gets built and how data and results are handled; ' +
    'leaves architecture and code-level details to the agent.')
  assert.deepEqual(onboarding.preferredProfiles(user), ['product', 'ml-research'])
  assert.equal(onboarding.depthFor('learning'), 'essentials')
  assert.equal(onboarding.depthFor('expert'), 'research')
  assert.deepEqual(onboarding.readUser({ work: ['ml'], levels: { 'ml-research': 'guru' }, decide: [] }), { work: ['ml'], levels: {}, decide: [] })
  assert.equal(onboarding.readUser('nope'), null)
  await assert.rejects(onboarding.interview(async () => { throw new Error('dismissed') }))
})

test('expert requests carry the profile and level without chapter notes at any level', () => {
  const cases = [
    ['general', 'Please verify live after merging the patch.'],
    ['ml-research', 'Compare ridge regression and lasso for the study.'],
    ['product', 'Plan the A/B test for this feature and set guardrails.'],
    ['system-design', 'Set an error budget for the inbound API.'],
  ] as const
  for (const [profile, text] of cases) {
    for (const level of onboarding.USER_LEVELS) {
      const depths = onboarding.userDepths({ levels: { [profile]: level }, work: [], decide: [] })
      const depth = depths[profile]!
      const notes = chapterContext(ASSETS.chapters!.filter((chapter) => chapter.profile === profile), text, () => depth)
      assert.ok(notes, text)
      const core = createCore(ASSETS)
      core.handle(config({ profile, read: 'key', depths }))
      core.handle({ type: 'draft', text, now: 100, origin: 'paste' })
      const [req] = requests(core.handle({ type: 'review', now: 200 }))
      assert.equal(req?.kind, 'expert', profile)
      assert.ok(req!.prompt.includes(`Draft:\n<<<\n${text}\n>>>`))
      assert.ok(req!.prompt.includes(`Review profile: ${profile}\nLevel: ${depth}`))
      const payload = [req!.prompt, ...req!.system].join('\n')
      assert.doesNotMatch(payload, /\bchapters?\b|^(?:Theory|Workflow|Choice)\./im)
      for (const chapter of ASSETS.chapters!) {
        assert.ok(!payload.includes(`[${chapter.profile}] ${chapter.title}`))
        for (const note of Object.values(chapter.notes)) assert.ok(!payload.includes(note))
      }
    }
  }
})

test('the chapter matcher recognizes French topics and keeps the two strongest', () => {
  const text = 'Précise la validation croisée, le jeu de test et la fuite de données. Compare la régression linéaire aux moindres carrés et mesure les faux positifs. Vérifie aussi le budget d’erreur et le taux de conversion.'
  const chapters = ASSETS.chapters!.filter((chapter) => chapter.profile === 'ml-research')
  const notes = chapterContext(chapters, text, () => 'essentials')
  assert.deepEqual(notes.match(/^\[[a-z-]+\] .+$/gm), [
    '[ml-research] Resampling, leakage, and final assessment',
    '[ml-research] Linear models, shrinkage, and selection',
  ])
})

test('the general card request starts with the draft and contains no chapter notes', () => {
  const core = createCore(ASSETS)
  core.handle(config({ profile: 'product', depths: { product: 'essentials', 'ml-research': 'essentials' } }))
  core.handle({ type: 'vocabulary', vocab: vocabOf('finalchallengedata', ['train.csv', 'test.csv', 'submission.csv', 'eda.ipynb'], { lightgbm: 3 }) })
  assert.deepEqual(core.projectProfiles().map((lens) => lens.profile), ['ml-research'])
  const text = 'Design an A/B test for the feature. Hold out a test set for the classifier.'
  const [req] = requests(core.handle({ type: 'draft', text, now: 100, origin: 'paste' }))
  assert.equal(req?.kind, 'card')
  const general = createCore(ASSETS)
  general.handle(config())
  const [generalReq] = requests(general.handle({ type: 'draft', text, now: 100, origin: 'type' }))
  // The default typed request matches v0.4.30, including the full system and prompt.
  assert.equal(createHash('sha256').update(JSON.stringify(generalReq)).digest('hex'),
    '559f254c36cd48b28b79a88025b421dabf22ed3fc9d96bd3fc991ac89f764929')
  assert.equal(createHash('sha256').update(JSON.stringify(req)).digest('hex'),
    '8ea6c2c31ef513d59b0ea6469e53fa7ae6dd3140fdfa9a087a96b5bd3446e25b')
  assert.ok(req!.prompt.startsWith(`Draft:\n<<<\n${text}\n>>>`))
  assert.doesNotMatch([req!.prompt, ...req!.system].join('\n'),
    /Profile chapters|\[ml-research\] Resampling|\[product\] Experiments|Rows from the same person|Concurrent random assignment/)
})

test('a one-off reading at Enter sends a decision without a sketch, a learned pick or a cached reading', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const draft = { type: 'draft', text: DRAFT, origin: 'paste' } as const
  const [request] = requests(core.handle({ ...draft, now: 100, afterEnter: true, transient: true }))
  assert.equal(request?.kind, 'card')
  const effects = core.handle({ type: 'reply', now: 200, req: request!.req, text: READING, done: true })
  assert.deepEqual(requests(effects), [])
  const row = core.currentView().card!.rows[0]!
  core.handle({ type: 'cardSet', now: 300, row: row.id, option: 1 })
  const sent = core.handle({ type: 'submit', now: 400, text: DRAFT, plan: false, amendable: false })
  assert.ok(sent.find((effect) => effect.type === 'submit')?.text.includes('Export all orders.'))
  assert.equal(sent.some((effect) => effect.type === 'learn'), false)

  const [normal] = requests(core.handle({ ...draft, now: 500 }))
  assert.equal(normal?.kind, 'card')
  assert.notEqual(normal!.req, request!.req)
})

const PRODUCT_DRAFT = 'Plan an A/B test for this feature and tell me what to measure.'
const PRODUCT_FIELD = { prefer: onboarding.preferredProfiles({ work: ['apps'] }) }

test('chapter references require a field, a substantive request, and specific local evidence', () => {
  const reference = (text: string, extra: Partial<Extract<Event, { type: 'config' }>> = {}) => {
    const core = createCore(ASSETS)
    core.handle(config({ read: 'key', ...extra }))
    const effects = core.handle({ type: 'draft', now: 100, origin: 'paste', text })
    assert.deepEqual(requests(effects), [])
    return core.currentView().card?.chapter?.title
  }
  assert.equal(reference(PRODUCT_DRAFT), undefined)
  const bothFields = { ...PRODUCT_FIELD, profile: 'system-design' }
  assert.equal(reference(`${PRODUCT_DRAFT} Define the point-in-time recovery procedure.`, bothFields),
    'Recovery, durability, and degraded operation')
  for (const modes of [{ mode: 'quiet' }, { mode: 'off' }, { sheet: false }, { chapters: false }] as const) {
    assert.equal(reference(PRODUCT_DRAFT, { ...PRODUCT_FIELD, ...modes }), undefined)
  }
  const ml = { prefer: ['ml-research'] }
  assert.equal(reference('Use PCA and preserve variance for the sensor features.', ml), 'Unsupervised structure and dimension reduction')
  assert.equal(reference('Use PCA on the readings from the sensors.', ml), undefined)
  for (const draft of [
    'Fix the typo in our cross-validation instructions.',
    'Add --seed to the cross-validation command.',
    'Add a flag to toggle cross-validation.',
    'Sort the imports in the random forest training script.',
    'What is cross-validation and when is it used?',
  ]) assert.equal(reference(draft, ml), undefined, draft)
  const general = 'Design the public interface and define acceptance criteria for account exports.'
  assert.equal(reference(general), undefined)
  assert.equal(reference(general, { profileSelected: true }), 'Scope, interfaces, and acceptance')

  const core = createCore(ASSETS)
  core.handle(config({ read: 'key', depth: 'research' }))
  const text = 'Design how clients should read from a read replica.'
  core.handle({ type: 'draft', now: 100, origin: 'paste', text })
  assert.equal(core.currentView().card?.chapter, undefined)
  core.handle({ type: 'vocabulary', vocab: vocabOf('service', ['Dockerfile', 'openapi.yaml'], {}) })
  const chapter = ASSETS.chapters!.find((chapter) => chapter.title === 'Replication, consistency, and isolation')!
  assert.equal(core.currentView().card?.chapter?.notes, chapter.notes.standard)
})

test('a reference updates to the field level, counts display and expansion, and stays dismissed', () => {
  const core = createCore(ASSETS)
  const setup = { ...PRODUCT_FIELD, read: 'key' as const, depths: { product: 'essentials' as const } }
  core.handle(config(setup))
  core.handle({ type: 'draft', now: 100, origin: 'paste', text: PRODUCT_DRAFT })
  const { id, chapter } = core.currentView().card!
  assert.ok(chapter)
  const source = ASSETS.chapters!.find((entry) => entry.title === chapter.title)!
  assert.equal(chapter.choice, source.notes.essentials.split('\n')[2]!.slice('Choice. '.length))
  const metrics = (effects: Effect[]) => effects.filter((effect) => effect.type === 'metric')
  const shown = { type: 'cardShown', now: 200, id, chapter: chapter.title } as const
  assert.deepEqual(metrics(core.handle(shown)), [{ type: 'metric', name: 'chapter-shown' }])
  assert.deepEqual(metrics(core.handle(shown)), [])
  assert.deepEqual(metrics(core.handle({ type: 'chapter', action: 'toggle' })), [{ type: 'metric', name: 'chapter-expanded' }])
  assert.equal(core.currentView().card?.chapter?.expanded, true)
  assert.deepEqual(metrics(core.handle({ type: 'chapter', action: 'toggle' })), [])
  assert.equal(core.currentView().card?.chapter?.expanded, false)
  assert.deepEqual(requests(core.handle(config({ ...setup, depths: { product: 'research' } }))), [])
  assert.equal(core.currentView().card?.chapter?.notes, source.notes.research)
  core.handle({ type: 'chapter', action: 'dismiss' })
  core.handle({ type: 'draft', now: 300, origin: 'type', text: `${PRODUCT_DRAFT} Include guardrail metrics.` })
  assert.equal(core.currentView().card?.chapter, undefined)
  core.handle({ type: 'draft', now: 400, origin: 'type', text: '' })
  core.handle({ type: 'draft', now: 500, origin: 'paste', text: PRODUCT_DRAFT })
  assert.equal(core.currentView().card?.chapter?.expanded, false)
})

test('chapter visibility and expansion leave requests, Decisions, and the receipt byte-for-byte unchanged', () => {
  function flow(chapters: boolean) {
    const core = createCore(ASSETS)
    core.handle(config({ ...PRODUCT_FIELD, chapters, read: 'key' }))
    core.handle({ type: 'draft', now: 100, origin: 'paste', text: PRODUCT_DRAFT })
    assert.equal(Boolean(core.currentView().card?.chapter), chapters)
    assert.deepEqual(requests(core.handle({ type: 'chapter', action: 'toggle' })), [])
    const [general] = requests(core.handle({ type: 'cardRead', now: 200 }))
    assert.equal(general?.kind, 'card')
    core.handle({ type: 'reply', now: 300, req: general!.req, text: READING.replace('kind | change', 'kind | build'), done: true })
    const [sketch] = requests(core.handle({ type: 'timer', now: 300 }))
    assert.equal(sketch?.kind, 'sketch')
    const [expert] = requests(core.handle({ type: 'review', now: 400, profile: 'product' }))
    assert.equal(expert?.kind, 'expert')
    core.handle({ type: 'cardSet', now: 500, row: core.currentView().card!.rows[0]!.id, option: 1 })
    const submit = core.handle({ type: 'submit', now: 600, text: PRODUCT_DRAFT }).find((effect) => effect.type === 'submit')
    core.handle({ type: 'turnStart', now: 700 })
    core.handle({ type: 'endAmendment', now: 800 })
    const receipt = core.currentView().receipt
    assert.ok(submit?.decisions.length)
    assert.deepEqual(receipt?.yours, submit.decisions)
    assert.equal(core.currentView().card?.chapter, undefined)
    return { general, sketch, expert, submit, receipt }
  }
  assert.deepEqual(flow(true), flow(false))
})

for (const fixture of reviewFixtures) {
  test(`review parser recovers the saved ${fixture.probe} ${fixture.depth} catalog reply when the catalog is supplied`, () => {
    const { profile, depth, draft, reply, key, statement, options, anchor } = fixture
    const slot = ASSETS.bundles!.find((bundle) => bundle.profile === profile)!.slots.find((slot) => slot.id === key)!
    const items = parseExpert(reply, draft, [{ ...stateCue({ slot, options: slot.options }, 'en', depth as Depth), key, persistent: true }],
      () => true).map((item) => ({
      key: item.key, statement: item.statement, options: item.options.map((option) => option.label),
      anchor: item.span ? draft.slice(item.span.start, item.span.end) : null,
    }))
    assert.deepEqual(items, [{ key, statement, options, anchor }])
  })
}

for (const fixture of autoreview2.parser) {
  test(`review parser handles the recorded ${fixture.id} reply`, () => {
    const items = parseExpert(fixture.reply, fixture.draft, [], () => false)
    assert.deepEqual(items.map((item) => item.key), fixture.keys)
    for (const item of items) assert.equal(item.statement.split('{}').length, 2)
  })
}

const reservedReviewKeys = new Set(ASSETS.bundles!.flatMap((bundle) => bundle.slots.map((slot) => slot.id)))
for (const [round, fixtures] of [[3, autoreview3], [4, autoreview4]] as const) {
  for (const { id, draft, reply, expected } of fixtures) {
    test(`review parser handles round ${round} case ${id}`, () => {
      const items = parseExpert(reply, draft, [], (key) => reservedReviewKeys.has(key))
      assert.deepEqual(items.map((item) => ({
        key: item.key, label: item.label, statement: item.statement, options: item.options.map((option) => option.label),
        ...(item.defaultIndex !== undefined && { defaultIndex: item.defaultIndex }),
        ...(item.span && { anchor: draft.slice(item.span.start, item.span.end) }),
      })), expected ? [expected] : [])
    })
  }
}

test('a review choice uses its statement as a label and keeps options around an optional anchor', () => {
  const draft = 'Add a CSV export for all orders.'
  const items = parseExpert([
    'choice | | Export {} | | all orders | the filtered orders * | | @ CSV export |',
    'choice | Send {} | a link | CSV export | a file',
    'choice | Include {} | all orders | only new orders',
    'choice | Notify {} | @sales | @support | @ recipients',
  ].join('\n'), draft, [], () => false)
  assert.deepEqual(items.map((item) => [item.key, item.label, item.options.map((option) => option.label),
    item.defaultIndex, item.span && draft.slice(item.span.start, item.span.end)]), [
    ['export', 'Export', ['all orders', 'the filtered orders'], 1, 'CSV export'],
    ['send', 'Send', ['a link', 'a file'], undefined, 'CSV export'],
    ['include', 'Include', ['all orders', 'only new orders'], undefined, undefined],
    ['notify', 'Notify', ['@sales', '@support'], undefined, undefined],
  ])
})

test('a statement-derived review key can coexist with a catalog key', () => {
  const items = parseExpert('choice | Measure {} | errors | latency', '', [], (key) => key === 'measure')
  assert.equal(items[0]?.key, 'choice_measure')
})

for (const [reason, reply] of [
  ['the statement has no slot', 'choice | @CSV export | Which rows should go in the file? | all orders | the filtered orders'],
  ['there is only one nonempty option', 'choice | Export {} | | all orders | * | @CSV export |'],
  ['there are no options', 'choice | Export {} | |'],
] as const) {
  test(`review parser rejects a choice when ${reason}`, () => {
    assert.deepEqual(parseExpert(reply, 'Add a CSV export.', [], () => false), [])
  })
}

const DISTINCT_REVIEW = 'choice | A/B test | Assignment unit | Randomize by {} | account | workspace'
const DUPLICATE_REVIEW = 'choice | | Export scope | Download {} | all orders | the filtered orders'

test('on-demand review passes card rows and shows at most two new choices', () => {
  const core = createCore(ASSETS)
  core.handle(config({ ...PRODUCT_FIELD, sketch: false }))
  const [reading] = requests(core.handle({ type: 'draft', now: 100, text: PRODUCT_DRAFT, origin: 'paste' }))
  assert.equal(reading?.kind, 'card')
  core.handle({ type: 'reply', req: reading!.req, now: 200, text: READING, done: true })
  const [manual] = requests(core.handle({ type: 'review', now: 300, profile: 'product' }))
  assert.match(manual!.system[0]!, /\x60choice \|\x60/)
  assert.doesNotMatch(manual!.system[0]!, /new_key|catalog_key/)
  assert.match(manual!.prompt, /Decisions already on the card/)
  for (const { key, statement, options } of core.currentView().card!.rows) {
    assert.ok(manual!.prompt.includes(JSON.stringify({ key, statement, options })))
  }
  assert.doesNotMatch(manual!.prompt, /Candidate catalog/)
  core.handle({ type: 'reply', req: manual!.req, now: 400, done: true, text: [
    DUPLICATE_REVIEW, DISTINCT_REVIEW, DISTINCT_REVIEW,
    'Launch after {} | one week | two weeks*',
    'choice | Measure {} | activation | retention',
  ].join('\n') })
  const items = core.currentView().expert?.items
  assert.deepEqual(items?.map((item) => item.key), ['assignment_unit', 'launch_after'])
  assert.deepEqual(items?.[0]?.span, { start: PRODUCT_DRAFT.indexOf('A/B test'), end: PRODUCT_DRAFT.indexOf('A/B test') + 8 })
  assert.equal(items?.[1]?.span, undefined)
  assert.equal(items?.[1]?.defaultIndex, 1)
})

test('the general request matches v0.4.26 and an old auto setting is ignored', () => {
  for (const oldSettings of [{}, { review: 'auto' }]) {
    const core = createCore(ASSETS)
    core.handle(config({ ...PRODUCT_FIELD, ...oldSettings }))
    const reading = requests(core.handle({ type: 'draft', now: 100, text: PRODUCT_DRAFT, origin: 'paste' }))
    assert.deepEqual(reading.map((effect) => effect.kind), ['card'])
    assert.equal(createHash('sha256').update(JSON.stringify(reading[0])).digest('hex'),
      'c57af4e70f1f2f180bec9a3fbf78e73e619b91bb8dd423277c5487fb98bb99c2')
    assert.deepEqual(requests(core.handle({ type: 'reply', req: reading[0]!.req, now: 200, text: READING, done: true })), [])
    assert.deepEqual(requests(core.handle({ type: 'review', profile: 'product', now: 300 })).map((effect) => effect.kind), ['expert'])
  }
})

for (const [heading, unrelated, relevant] of [
  ['[ml-research] Margins and kernels', ['Support vector search in the existing API.'],
    'Tune a support vector classifier for this dataset.'],
  ['[ml-research] Nonlinearity, splines, and additive models', ['Fix the SVG spline in the diagram.'],
    'Fit a smoothing spline to the response across ages.'],
  ['[ml-research] Uncertainty for performance and comparisons', ['Bootstrap the service.'],
    'Compute paired bootstrap intervals for the performance gap.'],
  ['[product] Policy, permissions, and user trust', ['Fix keyboard accessibility.', 'Fix the keyboard accessibility requirement for the dialog.'],
    'Define account permissions for workspace owners and staff.'],
] as const) {
  test(`chapter routing for ${heading} requires a relevant topic`, () => {
    for (const draft of unrelated) {
      assert.ok(!chapterContext(ASSETS.chapters!, draft, () => 'standard').includes(heading), draft)
    }
    assert.ok(chapterContext(ASSETS.chapters!, relevant, () => 'standard').includes(heading), relevant)
  })
}

test('chapter routing recognizes FWER and FDR as multiple testing', () => {
  for (const criterion of ['FWER', 'FDR']) {
    const notes = chapterContext(ASSETS.chapters!, `We need to control ${criterion}.`, () => 'standard')
    assert.match(notes, /\[ml-research\] Multiple testing and selective claims/, criterion)
  }
})

test('chapter routing sends the one-standard-error rule to shrinkage', () => {
  for (const rule of ['one standard error rule', 'one-SE rule']) {
    const notes = chapterContext(ASSETS.chapters!, `Use the ${rule}.`, () => 'standard')
    assert.match(notes, /\[ml-research\] Linear models, shrinkage, and selection/, rule)
    assert.doesNotMatch(notes, /\[ml-research\] Uncertainty for performance and comparisons/, rule)
  }
})

test('chapter routing recognizes inflections and domain synonyms', () => {
  for (const [profile, topic, drafts] of [
    ['system-design', 'Messaging, retries, and idempotency', [
      'Make webhook retries idempotent in the billing worker.',
      'Define the idempotency guarantee for webhook retries.',
    ]],
    ['ml-research', 'Linear models, shrinkage, and selection', [
      'Compare L2 regularization with feature selection for these predictors.',
      'Use ridge regularization and pick the strength for the regression.',
    ]],
    ['ml-research', 'Multiple testing and selective claims', [
      'Account for multiple comparisons when reporting the results.',
      'Account for multiple testing when reporting the results.',
    ]],
    ['ml-research', 'Resampling, leakage, and final assessment', [
      'Evaluate the approach with cross-validation and score on held-out data.',
    ]],
  ] as const) {
    for (const text of drafts) {
      const chapters = ASSETS.chapters!.filter((chapter) => chapter.profile === profile)
      assert.ok(chapterContext(chapters, text, () => 'standard').includes(`[${profile}] ${topic}`), text)
    }
  }
})

for (const { id, rows, choice } of autoreview2.near) {
  test(`the recorded review choice ${id} repeats a card decision`, () => {
    assert.ok(rows.some((row) => nearExpertDecision(row, choice)))
  })
}

test('an alert time window is distinct from alert delivery', () => {
  assert.equal(nearExpertDecision({
    key: 'alert_route', statement: 'Send burn alerts {}',
    options: ['to the on-call pager for fast burn, ticket for slow burn', 'to the on-call pager only', 'to a chat channel only'],
  }, {
    key: 'burn_alert_window', statement: 'Fast-burn alert window uses {}',
    options: ['long and short window pair', 'single long window only'],
  }), false)
})

test('on-demand review deduplicates against the card whichever reply arrives first', () => {
  const { rows, choice } = autoreview2.near.find(({ id }) => id === 'I21')!
  const draft = 'Add a retry policy with jitter to all outgoing HTTP calls.'
  const cardRows = rows.slice(0, 3)
  const general = ['kind | change', ...cardRows.map(({ key, statement, options }) =>
    ['row', key, 'choice', 'one', statement, ...options].join(' | '))].join('\n')
  const novel = 'Cap the total wait at {} | 20 seconds | 60 seconds'
  const duplicate = ['choice', 'Ambiguous effect resolution', choice.statement, ...choice.options].join(' | ')
  for (const reviewFirst of [false, true]) {
    const core = createCore(ASSETS)
    core.handle(config({ profile: 'system-design', sketch: false }))
    const [card] = requests(core.handle({ type: 'draft', now: 100, text: draft, origin: 'paste' }))
    const [review] = requests(core.handle({ type: 'review', now: 150 }))
    const replies = [
      { req: card!.req, text: general },
      { req: review!.req, text: [duplicate, novel].join('\n') },
    ]
    if (reviewFirst) replies.reverse()
    for (const [i, reply] of replies.entries()) core.handle({ type: 'reply', now: 200 + i, done: true, ...reply })
    assert.deepEqual(core.currentView().expert?.items.map((item) => item.key), ['cap_the_total_wait_at'])
    assert.deepEqual(core.currentView().card?.rows.map((row) => row.key), cardRows.map(({ key }) => key))
  }
})

test('changing a field level rereads the draft and keeps a confirmed row', () => {
  const core = createCore(ASSETS)
  const settings = { profile: 'ml-research', sketch: false }
  core.handle(config({ ...settings, depths: { 'ml-research': 'essentials' } }))
  const text = 'Use lasso to build the report, which can go in two places.'
  const [first] = requests(core.handle({ type: 'draft', text, now: 100, origin: 'paste' }))
  const reply = 'read | You want a report.\nkind | build\nrow | place | place | one | Put the report in {} | output | reports'
  core.handle({ type: 'reply', now: 200, req: first!.req, text: reply, done: true })
  const row = core.currentView().card!.rows[0]!
  core.handle({ type: 'cardSet', now: 300, row: row.id, option: 1 })
  const edited = `${text} Keep it short.`
  const [pending] = requests(core.handle({ type: 'draft', text: edited, now: 400, origin: 'paste' }))
  assert.equal(pending?.kind, 'card')
  const [before] = requests(core.handle({ type: 'review', now: 410 }))
  assert.equal(before?.kind, 'expert')
  assert.match(before!.prompt, /Review profile: ml-research\nLevel: essentials/)
  const effects = core.handle(config({ ...settings, depths: { 'ml-research': 'research' } }))
  for (const req of [pending!.req, before!.req]) {
    assert.ok(effects.some((effect) => effect.type === 'cancel' && effect.req === req))
  }
  const [updated] = requests(effects)
  assert.equal(updated?.kind, 'card')
  assert.ok(updated!.prompt.startsWith(`Draft:\n<<<\n${edited}\n>>>`))
  assert.match(updated!.prompt, /Already decided \(no row for these\):\n- Put the report in reports\./)
  core.handle({ type: 'reply', now: 500, req: pending!.req, text: reply, done: true })
  assert.equal(core.currentView().card?.read, null)
  core.handle({ type: 'reply', now: 510, req: updated!.req, text: 'read | You want a short report.\nkind | build', done: true })
  assert.equal(core.currentView().card?.read, 'You want a short report.')
  const confirmed = core.currentView().card?.rows.find((entry) => entry.id === row.id)
  assert.deepEqual(confirmed?.selected, [1])
  assert.equal(confirmed?.chosen, true)
  const [after] = requests(core.handle({ type: 'review', now: 520 }))
  assert.equal(after?.kind, 'expert')
  assert.match(after!.prompt, /Review profile: ml-research\nLevel: research/)
  assert.ok(after!.prompt.includes(`Draft:\n<<<\n${edited}\n\nDecisions:\n- Put the report in reports.\n>>>`))
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

test('picked mode sends only set rows, while all sends the completed card', () => {
  const submit = (send: 'all' | 'picked', option?: number) => {
    const core = createCore(ASSETS)
    core.handle(config({ send }))
    const [req] = requests(core.handle({ type: 'draft', now: 100, text: DRAFT, origin: 'paste' }))
    const view = lastView(core.handle({ type: 'reply', now: 200, req: req!.req, text: READING, done: true }))!
    if (option !== undefined) core.handle({ type: 'cardSet', now: 300, row: view.card!.rows[0]!.id, option })
    return core.handle({ type: 'submit', now: 400, text: DRAFT }).find((e) => e.type === 'submit')!
  }
  assert.equal(submit('picked').text, DRAFT)
  // Choosing the suggested value explicitly makes it the person's pick.
  assert.deepEqual(submit('picked', 0).decisions, ['Export the filtered orders.'])
  assert.deepEqual(submit('all').decisions, ['Export the filtered orders.', 'Cap one export at 100000 rows.'])
})

test('all asks about an untouched purge, while an explicit pick of that default binds', () => {
  const text = 'Build a settings page for team retention, including a paginated audit chart and an export button.'
  const reading = [
    'read | You want a team retention settings page.', 'kind | build',
    'row | purge | retention | one | After {}, the agent will permanently delete the team in a scheduled job | 30 days | 7 days',
    'row | rate | limit | range | Allow {} requests per minute | 60* | 100',
    'row | page | page size | one | Show {} per page | 50 rows | 100 rows',
    'row | history | chart window | one | Chart the last {} | 90 days | 30 days',
    'row | button | placement | one | Place the export button {} | beside the filters | in the menu',
    'row | invites | invites | one | Handle expired invitations with {} | a recoverable archive | a nightly purge job',
  ].join('\n')
  const read = (send: 'all' | 'open' | 'picked') => {
    const core = createCore(ASSETS)
    core.handle(config({ send }))
    const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
    core.handle({ type: 'reply', now: 200, req: req!.req, text: reading, done: true })
    return core
  }
  const submit = (core: ReturnType<typeof createCore>) => core.handle({ type: 'submit', now: 400, text }).find((e) => e.type === 'submit')!
  const ordinary = ['Allow 60 requests per minute.', 'Show 50 rows per page.', 'Chart the last 90 days.',
    'Place the export button beside the filters.', 'Handle expired invitations with a recoverable archive.']
  const question = 'After …, the agent will permanently delete the team in a scheduled job (7 days / 30 days)?'
  const decision = 'After 30 days, the agent will permanently delete the team in a scheduled job.'

  const untouched = read('all')
  assert.deepEqual(untouched.currentView().card!.rows.filter((row) => row.openOnSend).map((row) => row.key), ['purge'])
  const [sketch] = requests(untouched.handle({ type: 'timer', now: 200 }))
  assert.equal(sketch?.kind, 'sketch')
  assert.match(sketch!.prompt, /- Chart the last 90 days\./)
  assert.doesNotMatch(sketch!.prompt, /permanently delete/)
  const sent = submit(untouched)
  assert.deepEqual(sent.decisions, ordinary)
  assert.match(sent.text, /\n\nOpen choices \(.+say what you chose/)
  assert.ok(sent.text.endsWith(`\n- ${question}`))
  assert.ok(!sent.text.includes(decision))
  untouched.handle({ type: 'blank', now: 500, label: 'team retention', choice: 'keep a recoverable archive', alternatives: ['purge after 30 days'] })
  untouched.handle({ type: 'endAmendment', now: 600 })
  assert.deepEqual(untouched.currentView().receipt?.yours, ordinary)
  assert.equal(untouched.currentView().receipt?.agent[0]?.value, 'keep a recoverable archive')

  const picked = read('all')
  picked.handle({ type: 'cardSet', row: picked.currentView().card!.rows[0]!.id, option: 0 })
  assert.equal(picked.currentView().card!.rows[0]!.openOnSend, undefined)
  const confirmed = submit(picked)
  assert.deepEqual(confirmed.decisions, [decision, ...ordinary])
  assert.doesNotMatch(confirmed.text, /Open choices/)

  const open = read('open')
  assert.equal(open.currentView().card!.rows[0]!.openOnSend, true)
  const delegated = submit(open)
  assert.deepEqual(delegated.decisions, [])
  assert.ok(delegated.text.includes(question) && delegated.text.includes('Chart the last …'))

  const picksOnly = read('picked')
  assert.equal(picksOnly.currentView().card!.rows[0]!.openOnSend, true)
  assert.ok(submit(picksOnly).text.endsWith(`\n- ${question}`))

  const kept = read('open')
  kept.handle({ type: 'cardKeep', now: 300 })
  assert.deepEqual(kept.currentView().card!.rows.map((row) => row.chosen), [false, true, true, true, true, true])
  const bulk = submit(kept)
  assert.deepEqual(bulk.decisions, ordinary)
  assert.ok(bulk.text.endsWith(`\n- ${question}`))
  kept.handle({ type: 'blank', now: 500, label: 'team retention', choice: 'keep a recoverable archive', alternatives: ['purge after 30 days'] })
  kept.handle({ type: 'endAmendment', now: 600 })
  assert.deepEqual(kept.currentView().receipt?.yours, ordinary)
  assert.equal(kept.currentView().receipt?.agent[0]?.value, 'keep a recoverable archive')
})

test('picked mode keeps learned picks and applicable project decisions', () => {
  const core = createCore(ASSETS)
  core.handle(config({ send: 'picked' }))
  core.handle({ type: 'learned', picks: { export_rows: { label: 'the filtered orders', count: 2 } } })
  core.handle({ type: 'loadState', now: 0, state: {
    model: null, values: [{ slot: 'cleanup_reach', option: 'unused_only', scope: 'project', setAt: 0 }],
  } })
  const text = `${DRAFT} Delete the old test databases.`
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  core.handle({ type: 'reply', now: 200, req: req!.req, text: READING, done: true })
  const sent = core.handle({ type: 'submit', now: 300, text }).find((e) => e.type === 'submit')!
  assert.deepEqual(sent.decisions, ['Export the filtered orders.', 'Deletion targets unreferenced matches only.'])
})

test('a step-order row stays only on a draft that lists steps', () => {
  for (const text of [
    '1. Add a created_at column. 2. Backfill it. 3. Show it on the admin page.',
    'Step 1: write failing tests. Step 2: fix the bug.',
    'First update the schema, then migrate the rows, and finally expose the fields.',
    'Do this:\n1) add the column\n2) backfill it',
  ]) assert.equal(card.listsSteps(text), true, text)
  for (const text of [
    'Make team invitations expire so old invites stop working.',
    'Build a weekly report for team owners: who signed in, who got invited, what changed.',
    'Upgrade to HTTP/1.1 and keep 2.0 for later.',
    'Add rate limiting to the public API so one noisy client cannot take the service down.',
  ]) assert.equal(card.listsSteps(text), false, text)

  const reading = `${READING}\nrow | step_order | order | one | Do the steps {} | in written order, from step 1 | in whatever order works`
  const rows = (text: string) => {
    const core = createCore(ASSETS)
    core.handle(config())
    const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
    return lastView(core.handle({ type: 'reply', now: 200, req: req!.req, text: reading, done: true }))!.card!.rows.map((row) => row.key)
  }
  assert.deepEqual(rows(DRAFT), ['export_rows', 'export_limit'])
  assert.deepEqual(rows(`First add a CSV export to the orders page, then link it from the menu.`), ['export_rows', 'export_limit', 'step_order'])
})

test('an open choice names the gap and every option, none marked and in a neutral order', () => {
  assert.equal(card.openChoiceLine({ type: 'one', statement: 'Limit requests per {}', options: ['client API key', 'client IP address', 'user account'] }),
    'Limit requests per … (client API key / client IP address / user account)?')
  // The reading lists its guess first; the question does not.
  assert.equal(card.openChoiceLine({ type: 'one', statement: 'Expire invites {} after creation', options: ['after 30 days', 'after 7 days', 'after 24 hours'] }),
    'Expire invites … after creation (after 7 days / after 24 hours / after 30 days)?')
  assert.equal(card.openChoiceLine({ type: 'many', statement: 'Include in the email {}', options: ['the team name', 'a link, then a button'] }),
    'Include in the email … (any of: a link, then a button / the team name)?')
  assert.equal(card.openChoiceLine({ type: 'range', statement: 'Allow {} requests per minute', options: ['10', '30', '60', '100', '1000'] }),
    'Allow … requests per minute (10 / 30 / 60 / 100 / 1000)?')
  assert.equal(card.openChoiceLine({ type: 'range', statement: 'Run {}', options: ['slow', 'normal', 'fast'] }), 'Run … (slow / normal / fast)?')
})

test('the default sends set rows as decisions and asks the agent about the rest', () => {
  const steps = 'First add a CSV export to the orders page for big accounts, then link it from the menu.'
  const reading = `${READING}\nrow | step_order | order | one | Do the steps {} | in written order, from step 1 | in whatever order works`
  const submit = (send: 'all' | 'open' | undefined, text: string, option?: number, done = true) => {
    const core = createCore(ASSETS)
    core.handle(config({ send }))
    const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
    const view = lastView(core.handle({ type: 'reply', now: 200, req: req!.req, text: done ? reading : reading.slice(0, 60), done }))!
    if (option !== undefined) core.handle({ type: 'cardSet', now: 300, row: view.card!.rows[0]!.id, option })
    return { sent: core.handle({ type: 'submit', now: 400, text }).find((e) => e.type === 'submit')!, view }
  }
  const ask = 'Open choices (a quick read flagged these; they are not decisions, and its options may not fit the code. ' +
    'Settle each one yourself, without stopping to ask, and say what you chose where you first act on it):'
  const limit = 'Cap one export at … (1000 rows / 2400 rows / 5600 rows / 13000 rows / 32000 rows / 75000 rows / 100000 rows / 180000 rows / 420000 rows / 1000000 rows)?'

  // Nothing set: the reading's guesses stay home, its questions travel, and the card says they are left to the agent.
  const untouched = submit(undefined, DRAFT)
  assert.equal(untouched.sent.text, `${DRAFT}\n\n${ask}\n- Export … (all orders / the filtered orders)?\n- ${limit}`)
  assert.deepEqual(untouched.sent.decisions, [])
  assert.equal(untouched.view.card!.pickedOnly, true)

  // A set row is the person's decision; the other is still asked.
  const set = submit('open', DRAFT, 1)
  assert.equal(set.sent.text, `${DRAFT}\n\nDecisions:\n- Export all orders.\n\n${ask}\n- ${limit}`)
  assert.deepEqual(set.sent.decisions, ['Export all orders.'])

  // Steps the draft wrote keep their order: that comes from the person, not from the reading.
  const ordered = submit('open', steps)
  assert.ok(ordered.sent.text.includes('Decisions:\n- Do the steps in written order, from step 1.'))
  assert.ok(!ordered.sent.text.includes('Do the steps …'))

  // A reading that has not finished asks nothing: Enter never waits, and the prompt goes as typed.
  assert.equal(submit('open', DRAFT, undefined, false).sent.text, DRAFT)
  // Ordinary defaults in `all` travel as decisions.
  assert.equal(submit('all', DRAFT).sent.text, `${DRAFT}\n\nDecisions:\n- Export the filtered orders.\n- Cap one export at 100000 rows.`)
})

test('key mode reads only on request and sends only set choices after an edit', () => {
  const core = createCore(ASSETS)
  core.handle(config({ read: 'key' }))
  const typed = core.handle({ type: 'draft', now: 100, text: DRAFT.slice(0, -1), origin: 'type' })
  assert.equal(lastView(typed)?.card?.awaitingRead, true)
  assert.ok(!typed.some((e) => e.type === 'request' || e.type === 'timer'))
  assert.deepEqual(requests(core.handle({ type: 'timer', now: 1100 })), [])
  assert.deepEqual(requests(core.handle({ type: 'draft', now: 1200, text: DRAFT, origin: 'type' })), [])

  const [req] = requests(core.handle({ type: 'cardRead', now: 1201 }))
  assert.equal(req?.kind, 'card')
  assert.ok(req!.prompt.includes(`<<<\n${DRAFT}\n>>>`))
  assert.deepEqual(requests(core.handle({ type: 'cardRead', now: 1202 })), [])
  const read = lastView(core.handle({ type: 'reply', now: 1300, req: req!.req, text: READING, done: true }))?.card
  assert.ok(read?.read)
  assert.equal(read.awaitingRead, undefined)
  assert.deepEqual(requests(core.handle({ type: 'cardRead', now: 1400 })), [])

  core.handle({ type: 'cardSet', now: 1500, row: read.rows[0]!.id, option: 1 })
  const text = `${DRAFT} Include a download button.`
  const edited = core.handle({ type: 'draft', now: 1600, text, origin: 'paste' })
  assert.deepEqual(requests(edited), [])
  assert.equal(lastView(edited)?.card?.read, read.read)
  assert.equal(lastView(edited)?.card?.awaitingRead, true)
  const sent = core.handle({ type: 'submit', now: 1700, text })
  assert.deepEqual(requests(sent), [])
  assert.deepEqual(sent.find((e) => e.type === 'submit')?.decisions, ['Export all orders.'])
})

test('switching to key clears the idle timer and only a key can replace an older reading', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const text = DRAFT.slice(0, -1)
  const typed = core.handle({ type: 'draft', now: 100, text, origin: 'type' })
  assert.equal(typed.find((e) => e.type === 'timer')?.at, 1000)
  assert.equal(core.handle(config({ read: 'key' })).find((e) => e.type === 'timer')?.at, null)
  assert.deepEqual(requests(core.handle({ type: 'timer', now: 1000 })), [])

  const [first] = requests(core.handle({ type: 'cardRead', now: 1100 }))
  core.handle({ type: 'draft', now: 1200, text: DRAFT, origin: 'type' })
  const effects = core.handle({ type: 'cardRead', now: 1201 })
  assert.equal(effects.find((e) => e.type === 'cancel')?.req, first!.req)
  const [second] = requests(effects)
  assert.ok(second!.prompt.includes(`<<<\n${DRAFT}\n>>>`))

  core.handle({ type: 'draft', now: 1300, text: `${DRAFT} Make it fast.`, origin: 'type' })
  const completed = core.handle({ type: 'reply', now: 2300, req: second!.req, text: READING, done: true })
  assert.ok(!completed.some((e) => e.type === 'request' || e.type === 'timer'))
  assert.equal(lastView(completed)?.card?.awaitingRead, true)
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

test('the receipt keeps every marked choice, including a switch dismissed during the turn', () => {
  const core = createCore(ASSETS)
  core.handle(config({ reviewFirst: true }))
  core.handle({ type: 'turnStart', now: 10 })
  for (let i = 0; i < 9; i++) {
    core.handle({ type: 'blank', now: 11 + i, label: `setting ${i}`, choice: 'on', alternatives: ['off'] })
  }
  const row = core.currentView().card!.rows[0]!.id
  core.handle({ type: 'cardDismiss', now: 20, row })
  core.handle({ type: 'endAmendment', now: 21 })
  const view = core.currentView()
  assert.equal(view.receipt?.agent.length, 9)
  assert.equal(view.receipt?.agent.find((item) => item.label === 'setting 0')?.value, 'on')
  assert.equal(view.card?.rows.length, 8)
})

test('a receipt uses the card at send time, the original prompt and the learned decision at turn end', () => {
  const core = createCore(ASSETS)
  const prompt = 'Keep the results available quickly for everyone on the dashboard.'
  core.handle(config({ reviewFirst: true }))
  const [req] = requests(core.handle({ type: 'draft', now: 100, text: prompt, origin: 'paste' }))
  core.handle({ type: 'reply', now: 500, req: req!.req, done: true, text: [
    'read | Keep the dashboard fast.',
    'row | cache_backend | cache | one | Cache results in {} | local memory | Redis',
    'row | expiration_time | lifetime | one | Keep cached results for {} | thirty seconds | one minute',
  ].join('\n') })
  core.handle({ type: 'submit', now: 700, text: prompt })
  core.handle({ type: 'turnStart', now: 710, text: 'This is the rewritten prompt.' })
  core.handle({ type: 'draft', now: 720, origin: 'type', text: 'Use local memory in the other tool.' })
  core.handle({ type: 'learned', picks: { cache_backend: { label: 'Redis', count: 2 } } })
  core.handle({ type: 'blank', now: 800, label: 'cache', choice: 'local memory', alternatives: ['Redis'] })
  core.handle({ type: 'blank', now: 801, label: 'lifetime', choice: 'one minute', alternatives: ['thirty seconds'] })
  core.handle({ type: 'endAmendment', now: 900 })
  const receipt = core.currentView().receipt!
  assert.equal(receipt.reviewContext?.prompt, prompt)
  assert.deepEqual(receipt.agent.map(({ review }) => [review?.signals.leftOpen, review?.reason, review?.flagged]),
    [[true, 'you usually pick Redis', true], [true, 'you left it open', false]])
})

test('restated choices retain a switch, including a switch back to the original value', () => {
  const core = createCore(ASSETS)
  core.handle(config({ reviewFirst: true }))
  core.handle({ type: 'turnStart', now: 10, text: 'Use thirty seconds for the initial timeout.' })
  core.handle({ type: 'blank', now: 11, label: 'timeout', choice: 'thirty seconds', alternatives: ['one minute', 'two minutes'] })
  const row = core.currentView().card!.rows[0]!.id
  core.handle({ type: 'cardSet', now: 20, row, option: 1 })
  core.handle({ type: 'timer', now: 1600 })
  core.handle({ type: 'cardSet', now: 1610, row, option: 0 })
  core.handle({ type: 'timer', now: 3200 })
  core.handle({ type: 'blank', now: 3210, label: 'timeout', choice: 'two minutes', alternatives: ['one minute'] })
  core.handle({ type: 'endAmendment', now: 3300 })
  const [item] = core.currentView().receipt!.agent
  assert.deepEqual([item?.value, item?.review?.signals.switched, item?.review?.flagged], ['thirty seconds', true, false])
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

test('the reader cannot reopen a catalog decision that the draft explicitly settled', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const text = 'Compare the classifier with the baseline. Use the existing test set and report test accuracy.'
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  const reply = 'read | You want a classifier comparison on the existing test set.\nkind | explore\n' +
    'row | split_strategy | split | one | Hold out {} | new customers | later records'
  core.handle({ type: 'reply', now: 200, req: req!.req, text: reply, done: true })
  assert.deepEqual(core.currentView().card?.rows, [])
})

test('an explicitly pinned chart is inserted as requested, while an open asset choice still shows', () => {
  const action = 'Insert the existing reliability chart into the incident note.'
  for (const [source, open] of [
    ['Use the saved SVG, its current caption, and the current data window.', false],
    ['Use the saved SVG or regenerate it from the current data, whichever reads better.', true],
  ] as const) {
    const core = createCore(ASSETS)
    core.handle(config())
    const [req] = requests(core.handle({ type: 'draft', now: 100, text: `${action} ${source}`, origin: 'paste' }))
    const reply = 'read | You want the reliability chart in the incident note.\nkind | change\n' +
      'row | source | source | one | Use the chart {} | as saved | regenerated from the current data'
    core.handle({ type: 'reply', req: req!.req, text: reply, now: 200, done: true })
    assert.equal(core.currentView().card?.rows.length, Number(open))
  }
})

test('catalog prompts and rendered rows use the same snapshot prerequisites', () => {
  const text = 'Plan how database reads work during a network partition. Editors can accept unavailable reads or browse a clearly tagged snapshot.'
  for (const ready of [true, false]) {
    const core = createCore(ASSETS)
    core.handle(config({ profile: 'system-design' }))
    const input = ready ? text : 'Plan how database reads work during a network partition. Editors need a useful failure response.'
    const [req] = requests(core.handle({ type: 'draft', now: 100, text: input, origin: 'paste' }))
    assert.equal(req!.prompt.includes('live_degradation | when:'), ready)
    const reply = 'read | You want a partition policy for reads.\nkind | explore\n' +
      'row | live_degradation | outage | one | Users see {} | a labeled snapshot | an unavailable response'
    core.handle({ type: 'reply', req: req!.req, text: reply, now: 200, done: true })
    assert.equal(core.currentView().card?.rows.length, ready ? 1 : 0)
  }
})

test('a proposed merge that deploys waits as an open choice on submit', () => {
  const text = 'Finish the billing fix. We can open it for review or merge it to deploy.'
  const core = createCore(ASSETS)
  core.handle(config())
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  const reply = 'read | You want the billing fix finished.\nkind | change\n' +
    'row | release | release | one | Merge the PR to deploy {} | now, while you can watch the service | after review'
  core.handle({ type: 'reply', req: req!.req, text: reply, now: 200, done: true })
  assert.equal(core.currentView().card?.rows[0]?.openOnSend, true)
  const sent = core.handle({ type: 'submit', now: 300, text }).find((effect) => effect.type === 'submit')!
  assert.deepEqual(sent.decisions, [])
  assert.match(sent.text, /Open choices/)
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

test('stars inside an option mark it a default and never reach the text', () => {
  const parsed = card.parseCard('read | You want a report.\nkind | build\nrow | covers | covers | many | Cover {} | sign-ins*, invites*, changes | + role changes | failed sign-ins')
  assert.deepEqual(parsed.rows[0]?.options, ['sign-ins, invites, changes', '+ role changes', 'failed sign-ins'])
  assert.deepEqual(parsed.rows[0]?.defaults, [0])
})

test('a product named in a prompt (Claude Desktop, GitHub Actions) never asks which code name it is', () => {
  const repo = grounding.indexVocabulary(grounding.buildVocabulary({
    files: ['hooks/surfaces.ts'], declarations: 'hooks/surfaces.ts:1:export const desktopSurface\nhooks/surfaces.ts:2:export function actionsDesktop\n', names: '',
  }))
  const mentions = grounding.ground('Make it work in the Claude Desktop app and with GitHub Actions.', repo)
  assert.deepEqual(mentions.filter((m) => m.status === 'missing').map((m) => m.phrase), [])
})

test('a missing name the person matched to a code name shows as found', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'vocabulary', vocab: grounding.buildVocabulary({
    files: ['lib/db/schema.ts'], declarations: 'lib/db/schema.ts:9:export type ActivityLog\n', names: '' }) })
  const text = 'Build a weekly report for team owners from the Audit Log page.'
  const first = lastView(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))!
  const row = first.card!.rows.find((r) => r.origin === 'repo')!
  assert.equal(first.card!.mentions.find((m) => m.phrase === 'Audit Log')?.status, 'missing')
  const picked = lastView(core.handle({ type: 'cardSet', now: 200, row: row.id, option: 0 }))!
  assert.deepEqual(picked.card!.mentions.filter((m) => m.phrase === 'Audit Log').map((m) => [m.status, m.match]), [['found', 'ActivityLog']])
})

test('picked mode keeps the written step order, which comes from the draft and not from the reading', () => {
  const core = createCore(ASSETS)
  core.handle(config({ send: 'picked' }))
  const text = 'First add a CSV export to the orders page, then link it from the menu.'
  const reading = `${READING}\nrow | step_order | order | one | Do the steps {} | in written order, from step 1 | in whatever order works`
  const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
  core.handle({ type: 'reply', now: 200, req: req!.req, text: reading, done: true })
  const sent = core.handle({ type: 'submit', now: 300, text }).find((e) => e.type === 'submit')!
  assert.deepEqual(sent.decisions, ['Do the steps in written order, from step 1.'])
})

/** A Next.js app with the same file and function names in several folders. */
const twins = grounding.indexVocabulary(grounding.buildVocabulary({
  files: ['app/layout.tsx', 'app/(dashboard)/layout.tsx', 'app/(dashboard)/dashboard/layout.tsx', 'app/(login)/actions.ts',
    'lib/payments/actions.ts', 'app/(dashboard)/dashboard/page.tsx', 'app/(dashboard)/pricing/page.tsx', 'app/(login)/sign-in/page.tsx',
    'app/(login)/sign-up/page.tsx', 'app/(dashboard)/page.tsx', 'lib/format.ts', 'tests/format.test.ts'],
  declarations: [
    'app/(login)/actions.ts:52:export const signUp', 'app/(login)/actions.ts:399:export const inviteTeamMember',
    'app/(dashboard)/dashboard/page.tsx:190:function InviteTeamMember', 'lib/format.ts:1:export function formatDate',
    'tests/format.test.ts:3:function formatDate',
  ].join('\n'),
  names: '',
}))
const where = (text: string) => grounding.ground(text, twins).filter((m) => m.as === 'code').map((m) => [m.phrase, m.places ?? m.files[0]])

test('a name written as code that the code has in several files asks which one, unless the draft says', () => {
  // Nothing says which layout: all three, the shallowest first.
  assert.deepEqual(where('Add a footer with the copyright year to `layout.tsx`.'),
    [['layout.tsx', ['app/layout.tsx', 'app/(dashboard)/layout.tsx', 'app/(dashboard)/dashboard/layout.tsx']]])
  // A word only some of their paths have narrows them; one left is where the name points.
  assert.deepEqual(where('Add a footer to the dashboard `layout.tsx`.'),
    [['layout.tsx', ['app/(dashboard)/layout.tsx', 'app/(dashboard)/dashboard/layout.tsx']]])
  assert.deepEqual(where('In the payments `actions.ts`, log each checkout.'), [['actions.ts', 'lib/payments/actions.ts']])
  // Another name of the draft that lives in one of them settles it.
  assert.deepEqual(where('In `actions.ts`, make signUp also record the user agent.'),
    [['actions.ts', 'app/(login)/actions.ts'], ['signUp', 'app/(login)/actions.ts']])
  // The draft's own spelling is the code's own name: the action, not the component of the same words.
  assert.deepEqual(where('Make `inviteTeamMember` send an email.'), [['inviteTeamMember', 'app/(login)/actions.ts']])
  assert.deepEqual(where('Show a spinner in `InviteTeamMember`.'), [['InviteTeamMember', 'app/(dashboard)/dashboard/page.tsx']])
  // A test's copy is not what a draft means, unless it speaks of tests.
  assert.deepEqual(where('Make `formatDate` show the weekday.'), [['formatDate', 'lib/format.ts']])
  assert.deepEqual(where('Make `formatDate` in the tests use UTC.'), [['formatDate', ['lib/format.ts', 'tests/format.test.ts']]])
  // In more files than one question can offer: no question, and no file named.
  assert.deepEqual(where('Add a loading skeleton to `page.tsx`.'), [['page.tsx', []]])
  // A plain word never asks: what it may mean is the reading's to raise.
  assert.deepEqual(grounding.ground('Add a footer with the copyright year to the layout.', twins).filter((m) => m.places), [])
})

test('a row asks which file a name in several files means; the pick travels as a decision, never a guess', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle({ type: 'vocabulary', vocab: twins.vocab })
  const text = 'Add a footer with the copyright year to `layout.tsx`.'
  const effects = core.handle({ type: 'draft', now: 100, text, origin: 'paste' })
  const row = lastView(effects)!.card!.rows.find((r) => r.origin === 'repo')!
  assert.deepEqual([row.key, row.label, row.statement, row.options, row.selected], ['file_layouttsx', 'layout.tsx',
    '"layout.tsx" is the one in {}', ['app/layout.tsx', 'app/(dashboard)/layout.tsx', 'app/(dashboard)/dashboard/layout.tsx'], []])
  // The reading is told the files and that the question is already asked, so it adds no row of its own for it.
  const prompt = requests(effects)[0]!.prompt
  assert.ok(prompt.includes('In several files, which one is asked about separately (no row for this): layout.tsx (app/layout.tsx, app/(dashboard)/layout.tsx, app/(dashboard)/dashboard/layout.tsx)'), prompt)
  assert.ok(!prompt.includes('In the code:'), prompt)
  // Left alone, the prompt names every file it may be, not one picked for it.
  const sent = (draft: string) => core.handle({ type: 'submit', now: 300, text: draft }).find((e): e is Extract<Effect, { type: 'submit' }> => e.type === 'submit')!.decisions
  assert.deepEqual(sent(text), ['Where things are: layout.tsx (app/layout.tsx or app/(dashboard)/layout.tsx or app/(dashboard)/dashboard/layout.tsx).'])
  core.handle({ type: 'draft', now: 400, text, origin: 'paste' })
  const again = core.currentView().card!.rows.find((r) => r.origin === 'repo')!
  core.handle({ type: 'cardSet', now: 500, row: again.id, option: 1 })
  assert.deepEqual(sent(text), ['"layout.tsx" is the one in app/(dashboard)/layout.tsx.'])
  // Silent where the draft settles it, and where a name is in too many files to ask about (nor pointed at).
  for (const [draft, refs] of [
    ['In `actions.ts`, make signUp also record the user agent.', ['Where things are: actions.ts (app/(login)/actions.ts), signUp (app/(login)/actions.ts).']],
    ['Add a loading skeleton to `page.tsx`.', []],
  ] as const) {
    const view = lastView(core.handle({ type: 'draft', now: 600, text: draft, origin: 'paste' }))!
    assert.deepEqual(view.card!.rows.filter((r) => r.origin === 'repo'), [], draft)
    assert.deepEqual(sent(draft), refs, draft)
  }
})

test('ambiguous names do not narrow each other to the first files in the index', () => {
  const files = Array.from({ length: 5 }, (_, i) => `area-${i}/seats.ts`)
  const index = grounding.indexVocabulary(grounding.buildVocabulary({
    files,
    declarations: files.flatMap((file) => [`${file}:1:export function listSeats`, `${file}:2:export function loadSeats`]).join('\n'),
    names: '',
  }))
  const mentions = grounding.ground('Add tracing to `listSeats` and `loadSeats`.', index)
  assert.deepEqual(mentions.map(({ phrase, places }) => [phrase, places]), [['listSeats', []], ['loadSeats', []]])
})

test("a reading's row offering the same files as a name's own row is that question again, and is left out", () => {
  const text = 'Add a footer with the copyright year to `layout.tsx`.'
  // A reading that asked anyway, as one did in a trial run.
  const reading = [
    'read | You want a copyright-year footer added to a layout file.',
    'kind | change',
    'row | footer_layout | layout | one | Add the footer to {} | app/layout.tsx, the root layout | app/(dashboard)/layout.tsx, the dashboard shell | app/(dashboard)/dashboard/layout.tsx, the dashboard page layout | @layout.tsx',
    'row | footer_year | year | one | Show the year {} | the current year, computed at render | a fixed year typed in the code | @copyright year',
  ].join('\n')
  const vocabulary = { type: 'vocabulary', vocab: twins.vocab } as const
  for (const lateIndex of [false, true]) {
    const core = createCore(ASSETS)
    core.handle(config())
    if (!lateIndex) core.handle(vocabulary)
    const [req] = requests(core.handle({ type: 'draft', now: 100, text, origin: 'paste' }))
    core.handle({ type: 'reply', now: 200, req: req!.req, text: reading, done: true })
    if (lateIndex) core.handle(vocabulary)
    assert.deepEqual(core.currentView().card!.rows.map((row) => row.key), ['file_layouttsx', 'footer_year'])
  }
})

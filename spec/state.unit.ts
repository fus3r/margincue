import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import './ts-resolve.ts'
import type { Event, LanguageSetting, Mode, StoredDecision } from '../mods/claude-code/core/index'
import { buildBundle, parseCards } from '../mods/claude-code/scripts/build-bundles.ts'

const { ASSETS } = await import('../mods/claude-code/hooks/assets')
const { createCore, DecisionState, readBundle } = await import('../mods/claude-code/core/index')
const { layoutBand, segmentsWidth } = await import('../mods/claude-code/hooks/band')

const configure = (mode: Mode, profile = 'general', depth: 'standard' | 'research' = 'standard', language?: LanguageSetting): Event =>
  ({ type: 'config', enabled: true, mode, profile, depth, language, streaming: false, eagerPlan: false })
const draft = (text: string, now = 100): Event => ({ type: 'draft', origin: 'type', text, now })
const value = (option: string, scope: StoredDecision['scope'], model?: string): StoredDecision =>
  ({ slot: 'cleanup_reach', option, scope, setAt: 1, ...(model && { model }) })
const raw = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('bundle builder reproduces all three canonical catalogs and their shipped copies', () => {
  for (const [profile, count] of [['general', 14], ['ml-research', 12], ['system-design', 12]] as const) {
    const source = raw(`../profiles/${profile}/decisions.md`)
    const schema = profile === 'general' ? undefined : JSON.parse(raw(`../bench/quality/schema/${profile}.json`))
    const bundle = buildBundle(profile, source, schema)
    assert.equal(bundle.slots.length, count)
    assert.deepEqual(JSON.parse(raw(`../profiles/${profile}/bundle.json`)), bundle)
    assert.deepEqual(ASSETS.bundles?.find((item) => item.profile === profile), bundle)
    assert.ok(bundle.slots.every((slot) => slot.touch.en.match.length && slot.touch.fr.match.length))
  }
  assert.equal(readBundle({ formatVersion: 42 }), null)
  const general = raw('../profiles/general/decisions.md')
  assert.throws(() => buildBundle('general', general.replace(/^plain_fr:.*$/m, 'plain_fr: absent')), /translation mismatch/)
  assert.equal(parseCards('### example\nwhen: First line\n  continued.\npair:\n  open: x')[0]?.fields.when, 'First line continued.')
})

test('plain guard wording matches in both languages at word boundaries', () => {
  const core = createCore(ASSETS)
  core.handle(configure('auto'))
  for (const [en, fr, slot] of [
    ['Deploy', 'Déploie', 'ship_authority'],
    ['Publish', 'Publie', 'ship_authority'],
    ['Send', 'Envoie', 'send_or_draft'],
    ['Delete', 'Supprime', 'cleanup_reach'],
    ['Spend', 'Dépense', 'spend_cap'],
  ]) {
    for (const text of [en, fr]) {
      const effects = core.handle(draft(text))
      const view = core.currentView()
      assert.equal(view.state?.first?.slot, slot, text)
      assert.deepEqual(view.state?.first?.span, { start: 0, end: text.length }, text)
      assert.equal(view.state?.first?.guard, true)
      assert.ok(!effects.some((effect) => effect.type === 'request'), text)
    }
  }
  for (const text of ['A deletionJob reads records', 'How to delete a tag?', 'Build a delete button.', "Don't deploy.",
    'Ne supprime pas les archives.', 'Send the email directly.', 'Reply OK.', 'Do not spend anything.']) {
    core.handle(draft(text))
    assert.equal(core.currentView().state?.first, null, text)
  }
})

test('the general card pairs touch their slot and settle when given the stated answer', () => {
  const state = new DecisionState(ASSETS.bundles!, [])
  state.use('general')
  const source = raw('../profiles/general/decisions.md')
  const pairs = [...source.matchAll(/^### (\w+)\n[\s\S]*?^  open: (.+)\n  settled: Append "(.+)"\.?$/gm)]
  assert.equal(pairs.length, 14)
  for (const [, id, open, settled] of pairs) {
    assert.equal(state.evaluate(open!).byId.get(id!)?.status, 'open', id)
    assert.equal(state.evaluate(`${open} ${settled}`).byId.get(id!)?.status, 'filled', id)
  }
})

test('guards outrank non-guards; only one cue is eligible even under delegation markers', () => {
  const core = createCore(ASSETS)
  core.handle(configure('auto', 'general', 'standard', 'auto'))
  core.handle(draft('Build a new landing page with animations. Delete old files.'))
  let state = core.currentView().state
  assert.equal(state?.open, 2)
  assert.equal(state.first?.slot, 'cleanup_reach')
  core.handle({ type: 'dismiss', cue: 'cleanup_reach' })
  assert.equal(core.currentView().state?.first?.slot, 'preview_first')
  core.handle({ type: 'submit', now: 105, text: core.currentView().text })
  core.handle(draft('Fais au mieux. Crée une page d’accueil avec animations. Supprime les anciens fichiers.', 110))
  state = core.currentView().state
  assert.equal(state?.first?.slot, 'cleanup_reach')
  assert.equal(state.first.label, 'Nettoyage')
  assert.equal(state.open, 1)
  assert.ok(!core.handle({ type: 'delegate', now: 111, slot: 'cleanup_reach' }).some((effect) => effect.type === 'persist'))
})

test('the review request and its catalog choices use the selected language', () => {
  const french = 'Supprime les anciens fichiers.'
  for (const setting of ['en', 'auto'] as const) {
    const english = setting === 'en'
    const core = createCore(ASSETS)
    core.handle(configure('quiet', 'general', 'standard', setting))
    core.handle(draft(french))
    const review = core.handle({ type: 'review', now: 150 }).find((effect) => effect.type === 'request')!
    assert.match(review.system[0]!, english ? /alternatives in English\./ : /alternatives in the draft's language\./)
    const statement = english ? 'Deletion targets {}' : 'La suppression vise {}'
    assert.ok(review.prompt.includes(statement))
    assert.ok(review.prompt.includes(french))
    core.handle({ type: 'reply', req: review.req, now: 200, text: 'Supprime | cleanup_reach', done: true })
    assert.equal(core.currentView().expert?.items[0]?.statement, statement)
    core.handle({ type: 'expertPick', now: 250, review: review.req, key: 'cleanup_reach', option: 'unused_only', scope: 'session' })
    assert.deepEqual(core.currentView().decisions, [english
      ? 'Deletion targets unreferenced matches only.' : 'La suppression vise les éléments non référencés.'])
  }
})

test('marks for choices settled in the draft follow the language setting', () => {
  const line = 'La suppression vise les éléments non référencés.'
  const text = `Supprime les anciens fichiers.\n\nDecisions:\n- ${line}`
  for (const setting of ['en', 'auto'] as const) {
    const core = createCore(ASSETS)
    core.handle(configure('quiet', 'general', 'standard', setting))
    core.handle(draft(text))
    assert.equal(core.currentView().state?.marks[0]?.value, setting === 'en' ? 'set in the draft' : line)
    assert.equal(core.handle({ type: 'submit', now: 200, text }).find((effect) => effect.type === 'submit')?.text, text)
  }
})

test('scope precedence, model conditions, session reset and the model store keys', () => {
  const state = new DecisionState(ASSETS.bundles!, [])
  const load = (model: string, withProject = true) => state.load({
    model,
    values: [value('all_matches', 'user'), value('unused_only', 'model', 'largest'),
      ...(withProject ? [value('task_only', 'project')] : [])],
  })
  load('largest')
  assert.equal(state.resolve('cleanup_reach')?.option, 'task_only')
  state.set(state.slot('cleanup_reach')!, 'session', 'all_matches', 2)
  assert.equal(state.resolve('cleanup_reach')?.scope, 'session')
  load('small')
  assert.equal(state.resolve('cleanup_reach')?.scope, 'session')
  state.reset()
  assert.equal(state.resolve('cleanup_reach')?.scope, 'project')
  state.forget('cleanup_reach')
  assert.equal(state.resolve('cleanup_reach')?.scope, 'user')
  load('largest', false)
  assert.equal(state.resolve('cleanup_reach')?.option, 'unused_only')
  assert.deepEqual(state.list().find((entry) => entry.scope === 'model'), value('unused_only', 'model', 'largest'))
})

test('frames do not open sibling slots; prerequisites distinguish unknown and inapplicable', () => {
  const state = new DecisionState(ASSETS.bundles!, [])
  state.use('system-design')
  const text = 'Add timeout handling to the badge-issue button. The issuer may already have printed the badge. It supports an idempotency key and a status check.'
  const evaluate = (text: string) => state.evaluate(text).byId
  let slots = evaluate(text)
  assert.equal(slots.get('retry_after_unknown')?.status, 'open')
  assert.equal(slots.get('submission_confirmation')?.status, 'unknown')
  slots = evaluate('Add timeout handling to the badge-issue button. It supports an idempotency key.')
  assert.equal(slots.get('retry_after_unknown')?.status, 'unknown')
  state.load({ model: null, values: [], facts: { keyed_retry: false } })
  slots = evaluate(text)
  assert.equal(slots.get('retry_after_unknown')?.status, 'inapplicable')
  assert.deepEqual(slots.get('retry_after_unknown')?.options.map((o) => o.id), ['status_before_retry'])
})

test('touched standing values and confirmations attach once, respecting instructions and authored decisions', () => {
  const core = createCore(ASSETS)
  core.handle(configure('quiet'))
  core.handle({ type: 'loadState', now: 0, state: { model: null, values: [value('unused_only', 'project')] } })
  const text = 'Delete the old databases.'
  core.handle(draft(text))
  assert.equal(core.currentView().state?.marks[0]?.value, 'unreferenced matches only')
  const send = (text: string) => core.handle({ type: 'submit', text, now: 500 }).find((e) => e.type === 'submit')
  assert.equal(send(text)?.text, text + '\n\nDecisions:\n- Deletion targets unreferenced matches only.')
  assert.equal(send('Check the logs.')?.text, 'Check the logs.')
  const authored = text + '\n\nDecisions:\n- Cleanup deletes only my temporary files.'
  assert.equal(send(authored)?.text, authored)
  core.handle({ type: 'loadState', now: 600, state: { model: null, values: [value('unused_only', 'project')], instructionSlots: ['cleanup_reach'] } })
  assert.equal(send(text)?.text, text)
  core.handle({ type: 'loadState', now: 610, state: { model: null, values: [] } })
  core.handle(draft(text, 620))
  core.handle({ type: 'set', now: 625, slot: 'cleanup_reach', option: 'other', text: 'only temporary fixtures tagged mc', scope: 'session' })
  core.handle(draft('Remove the artifacts in the example.', 640))
  assert.deepEqual(send('Remove the artifacts in the example.')?.decisions, ['Deletion targets only temporary fixtures tagged mc.'])
})

test('auto, on, quiet, off, clause boundaries and bilingual prompt-local markers', () => {
  const core = createCore(ASSETS)
  const request = (effects: ReturnType<typeof core.handle>) => effects.find((effect) => effect.type === 'request')
  core.handle(configure('auto'))
  const first = 'Add an export button,'
  assert.ok(request(core.handle(draft(first))))
  core.handle({ type: 'submit', now: 200, text: first })
  assert.equal(request(core.handle(draft('Add another export button.', 500))), undefined)
  const long = 'Plan ' + 'a detailed replacement for the import workflow '.repeat(6) + 'today,'
  assert.ok(request(core.handle(draft(long, 1000))))
  assert.equal(request(core.handle(draft(`Okay, ${long}`, 1500))), undefined)
  core.handle(draft('', 1900))
  assert.ok(request(core.handle(draft('Ask me first. Add a report,', 2000))))
  assert.equal(request(core.handle(draft("Don't ask. Add a report,", 2500))), undefined)
  core.handle(draft('', 2900))
  assert.ok(request(core.handle(draft('Fais au mieux. Demande-moi d’abord. Prépare le rapport,', 3000))))

  core.handle(configure('on'))
  assert.ok(request(core.handle(draft('Build another import workflow:', 3500))))
  core.handle(configure('quiet'))
  const finished = core.handle(draft('Delete old test files.', 4000))
  assert.ok(!request(finished))
  assert.equal(core.currentView().state?.open, 1)
  assert.equal(core.currentView().state?.first, null)
  core.handle(configure('off'))
  assert.ok(!request(core.handle(draft("Ask me first. Review it.", 4500))))
  assert.equal(core.currentView().phase, 'off')
  assert.equal(core.currentView().state?.open, 0)
})

test('late review is offered only for the exact sent text and can be delivered once', () => {
  const core = createCore(ASSETS)
  core.handle(configure('on'))
  const text = 'Add an export button to the dashboard.'
  const result = 'export button\nexport button | Export covers {} | filtered rows | all rows'
  const req = core.handle(draft(text)).find((event) => event.type === 'request')!
  const submitted = core.handle({ type: 'submit', now: 200, text })
  assert.ok(!submitted.some((e) => e.type === 'cancel'))
  core.handle({ type: 'reply', now: 800, req: req.req, done: true, text: result })
  const amendment = core.currentView().amendment!
  assert.equal(amendment.statement, 'Export covers {}')
  const effects = core.handle({ type: 'amend', now: 900, cue: amendment.id, option: 1 })
  assert.deepEqual(effects.find((e) => e.type === 'amend'), {
    type: 'amend', cue: amendment.id, option: 1, text: 'Amendment to my last prompt: Export covers all rows.', ms: 700,
  })
  assert.ok(!core.handle({ type: 'amend', now: 901, cue: amendment.id, option: 0 }).some((e) => e.type === 'amend'))

  const again = core.handle(draft(text, 2000)).find((event) => event.type === 'request')!
  core.handle({ type: 'submit', now: 2100, text: `${text} Different.` })
  core.handle({ type: 'reply', now: 2200, req: again.req, done: true, text: result })
  assert.equal(core.currentView().amendment, undefined)
})

test('100-column band keeps every built-in choice numbered and shows both scope and mark paths', () => {
  const core = createCore(ASSETS)
  core.handle(configure('auto'))
  for (const bundle of ASSETS.bundles!) {
    for (const slot of bundle.slots) {
      for (const language of ['en', 'fr'] as const) {
        const first = {
          ...slot, scope: 'project' as const, label: slot.label[language], statement: slot.statement[language].expert,
          options: slot.options.map((o) => ({ id: o.id, label: o.wording[language].expert })),
        }
        const band = layoutBand({
          mode: 'auto', enabled: true, phase: 'idle', profile: bundle.profile, hasDraft: true, cues: [], focus: null,
          latencyMs: null, note: null, language, first, marks: [], open: 1, canReview: true,
        }, 100, 'ctrl+x tab')
        assert.ok(segmentsWidth(band) <= 100, slot.id)
        const keys = band.flatMap((s) => s.kind === 'button' ? [s.key] : [])
        assert.ok(keys.includes('scope'), slot.id)
        for (let i = 0; i < first.options.length + Number(!first.guard); i++) assert.ok(keys.includes(`state-opt-${i}`), slot.id)
      }
    }
  }
})

test('the pilot pairs settle their own slot without relying on the frame alone', () => {
  const state = new DecisionState(ASSETS.bundles!, [])
  for (const profile of ['ml-research', 'system-design']) {
    state.use(profile)
    const pairs = [...raw(`../profiles/${profile}/decisions.md`).matchAll(/^### (\w+)\n[\s\S]*?^  open: (.+)\n  settled: Append “(.+)”\.?$/gm)]
    assert.equal(pairs.length, 12)
    for (const [, id, open, settled] of pairs) {
      assert.equal(state.evaluate(open!).byId.get(id!)?.status, 'open', id)
      assert.equal(state.evaluate(`${open} ${settled}`).byId.get(id!)?.status, 'filled', id)
    }
  }
})

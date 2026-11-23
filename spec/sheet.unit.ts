import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import './ts-resolve.ts'
import type { Assets, Effect, Event } from '../mods/claude-code/core/index'

const { createCore, decisionLine, attachDecisions } = await import('../mods/claude-code/core/index')
const { parseSheet, SHEET_MAX_QUESTION, SHEET_MAX_OPTION } = await import('../mods/claude-code/core/sheet')
const { ASSETS } = await import('../mods/claude-code/hooks/assets')
const { layoutBandRows, layoutSheetPane, segmentsWidth, sheetQuestionRows } = await import('../mods/claude-code/hooks/band')

const KICKOFF = 'Build a tracker for our book club'
const REPLY = 'Who can mark books as read? | the organizer | all members\nWhere should progress live? | local storage | shared database'
const config = (extra: Partial<Extract<Event, { type: 'config' }>> = {}): Event =>
  ({ type: 'config', mode: 'auto', profile: 'general', enabled: true, sheet: true, streaming: false, eagerPlan: false, ...extra })
const draft = (text: string, now = 100, origin: 'paste' | 'type' | 'history' = 'paste'): Event =>
  ({ type: 'draft', text, now, origin })
const request = (effects: Effect[]) => effects.find((effect) => effect.type === 'request')
const reply = (req = 1, now = 200, text = REPLY): Event => ({ type: 'reply', req, now, text, done: true })

test('sheet parser keeps valid lines, checks bounds, and caps the sheet at five', () => {
  assert.deepEqual(parseSheet(' NONE \r\n'), [])
  const question = `${'Q'.repeat(SHEET_MAX_QUESTION - 1)}?`
  const option = 'o'.repeat(SHEET_MAX_OPTION)
  const text = ['preface', '- Markup? | yes | no', ' | a | b',
    'Too few? | a', 'Too many? | a | b | c | d | e', 'Empty option? | a |  ',
    `${question}? | a | b`, `Too long? | ${option}x | no`,
    ` ${question} | ${option} | b `, 'Platform | Web | Mobile', 'Three? | a | b | c', 'Four？ | a | b | c | d',
    'Question five? | a | b', 'Question six? | a | b'].join('\r\n')
  assert.deepEqual(parseSheet(text), [
    { statement: question, options: [option, 'b'] },
    { statement: 'Platform', options: ['Web', 'Mobile'] },
    { statement: 'Three?', options: ['a', 'b', 'c'] },
    { statement: 'Four？', options: ['a', 'b', 'c', 'd'] },
    { statement: 'Question five?', options: ['a', 'b'] },
  ])
})

test('sheet requests use the frozen prompt and exact draft, and cancel before showing mixed drafts', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  assert.ok(!request(core.handle(draft(KICKOFF, 100, 'type'))))
  assert.equal(core.currentView().sheet, undefined)
  const next = KICKOFF + '.'
  const first = request(core.handle({ type: 'timer', now: 380 }))!
  assert.deepEqual(first, {
    type: 'request', req: 1, kind: 'sheet', maxTokens: 320, prompt: KICKOFF,
    system: [readFileSync(new URL('../bench/sheet/product/sheet-prompt.md', import.meta.url), 'utf8').trim().replace('{language}', 'in English')],
  })
  assert.equal(core.currentView().sheet?.pending, true)
  const edited = core.handle(draft(next, 390, 'type'))
  assert.equal(edited[0]?.type, 'cancel')
  assert.deepEqual(edited.find((effect) => effect.type === 'timer'), { type: 'timer', at: 680 })
  assert.deepEqual(core.handle(reply(1, 600)), [])
  assert.equal(request(core.handle({ type: 'timer', now: 680 }))?.prompt, next)
  core.handle({ type: 'reply', req: 2, text: REPLY.slice(0, 34), done: false, now: 700 })
  assert.equal(core.currentView().sheet?.pending, true)
  assert.deepEqual(core.currentView().sheet?.items, [])
  core.handle(reply(2, 800, REPLY.slice(34)))
  assert.equal(core.currentView().sheet?.pending, false)
  assert.deepEqual(core.currentView().sheet?.items.map((item) => item.chosen), [null, null])
  assert.ok(!request(core.handle(draft(KICKOFF, 900, 'history'))))
  assert.ok(!request(core.handle(draft(next, 1000, 'history'))))
  assert.equal(core.currentView().sheet, undefined)
})

test('first-prompt fallback survives commands, ends on submit or resume, and returns on session reset', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  assert.equal(request(core.handle(draft('/model choose fast mode'))), undefined)
  const unclear = 'Sort my downloads automatically'
  assert.equal(request(core.handle(draft(unclear, 200)))?.kind, 'sheet')
  core.handle({ type: 'sessionReset', now: 300 })
  core.handle({ type: 'loadState', now: 400, state: { model: null, values: [], submitted: true } })
  assert.equal(request(core.handle(draft(unclear, 500))), undefined)
  core.handle({ type: 'sessionReset', now: 600 })
  core.handle({ type: 'submit', now: 700, text: 'Fix the imports.' })
  core.handle({ type: 'endAmendment', now: 800 })
  assert.equal(request(core.handle(draft(unclear, 900))), undefined)
  core.handle({ type: 'sessionReset', now: 1000 })
  assert.equal(request(core.handle(draft(unclear, 1100)))?.kind, 'sheet')
})

test('sheet choices never cross edits or a different submitted payload', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle(draft(KICKOFF))
  core.handle(reply())
  core.handle({ type: 'acceptAll', now: 300 })
  assert.deepEqual(core.currentView().decisions, [])
  core.handle({ type: 'pick', now: 400, cue: 'c1', option: 0 })
  const other = KICKOFF + ' and archive old entries'
  assert.ok(core.handle({ type: 'submit', now: 500, text: other }).some((effect) =>
    effect.type === 'submit' && effect.text === other && !effect.decisions.length))
  assert.equal(core.currentView().sheet, undefined)
})

test('sheet options are literal answers in the Decisions block', () => {
  const decision = { statement: 'How should {} be interpreted?', option: 'as a literal', question: true } as const
  assert.equal(decisionLine(decision), 'How should {} be interpreted? as a literal.')
  const userDraft = `${KICKOFF}\n\nDecisions:\n- How should {} be interpreted? Use the pattern syntax.`
  assert.deepEqual(attachDecisions(userDraft, [decision]), { text: userDraft, added: [] })
})

test('a main turn blocks fresh requests and its end releases a settled next draft', () => {
  const core = createCore(ASSETS)
  core.handle(config({ mode: 'on' }))
  core.handle(draft(KICKOFF))
  assert.deepEqual(core.handle({ type: 'turnStart', now: 120 }).filter((effect) => effect.type !== 'view'), [{ type: 'cancel', req: 1 }])
  assert.equal(core.currentView().sheet, undefined)
  assert.deepEqual(core.handle(reply(1, 200)), [])
  const next = 'Build a refresh button for search results'
  assert.equal(request(core.handle(draft(next, 300, 'type'))), undefined)
  assert.equal(request(core.handle({ type: 'timer', now: 1000 })), undefined)
  assert.equal(request(core.handle({ type: 'endAmendment', now: 1100 }))?.prompt, next)
})

test('expert profiles append up to twelve cards using the active language and depth', () => {
  const existingBundle = ASSETS.bundles!.find((bundle) => bundle.profile === 'ml-research')!
  const clone = { ...existingBundle.slots[0]!, id: 'thirteenth_slot', statement: { en: { plain: 'UNUSED {}', expert: 'UNUSED {}' }, fr: { plain: 'UNUSED {}', expert: 'UNUSED {}' } } }
  const assets: Assets = { ...ASSETS, bundles: ASSETS.bundles?.map((bundle) => bundle === existingBundle
    ? { ...bundle, slots: [...bundle.slots, clone] } : bundle) }
  const slot = existingBundle.slots.find((entry) => entry.statement.fr.plain !== entry.statement.fr.expert)!
  for (const [language, locale, instruction] of [
    ['en', 'en', 'in English.'], ['auto', 'fr', 'in the language of the request.'],
  ] as const) {
    for (const depth of ['essentials', 'research'] as const) {
      const core = createCore(assets)
      core.handle(config({ profile: 'ml-research', depth, language }))
      const effect = request(core.handle(draft('Crée un outil pour comparer les résultats de nos modèles.')))
      assert.ok(effect?.system[0]?.endsWith(instruction))
      assert.equal(effect?.system[0]?.startsWith('Write every question and option in English'), language === 'en')
      const system = effect?.system[1] ?? ''
      assert.equal(system.split('\n').filter((line) => line.startsWith('- ')).length, 12)
      assert.ok(system.includes(slot.statement[locale][depth === 'essentials' ? 'plain' : 'expert'].replace('{}', '…')))
      assert.ok(!system.includes('UNUSED'))
    }
  }
})

test('the band keeps the guard, lists questions, and shows choices only in the answering surface', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  core.handle(draft('Build a new tool. Remove old files.'))
  core.handle(reply(1, 200, `${REPLY}\nHow should sharing work? | only invited people | team-wide pages | links with passwords | public links`))
  const render = (columns = 95) => {
    const view = core.currentView()
    return layoutBandRows({ ...view, hasDraft: true, mode: 'auto', first: view.state?.first, canReview: true, depth: 'standard' }, columns, 'ctrl+x tab')
  }
  const rows = render()
  assert.equal(rows.length, 5)
  assert.ok(rows[0]?.some((s) => s.kind === 'button' && s.key === 'state-opt-0'))
  assert.ok(segmentsWidth(rows[1]!) < 95)
  assert.ok(rows[1]?.some((s) => s.kind === 'button' && s.primary && s.label === 'Answer  Alt+↑'))
  assert.deepEqual(rows.slice(2).map((row) => row[1]?.kind === 'button' && row[1].key),
    ['sheet-question-c1', 'sheet-question-c2', 'sheet-question-c3'])
  assert.ok(rows[2]?.some((s) => s.kind === 'button' && s.bold))
  assert.ok(rows[3]?.some((s) => s.kind === 'button' && s.dim))

  const pane = (move: 'open' | 'skip' | 'back' | 'close') => core.handle({ type: 'sheetPane', id: 1, move })
  pane('open')
  pane('skip')
  pane('skip')
  const sheet = core.currentView().sheet!
  assert.deepEqual(sheet.pane, { item: 'c3', position: 3, total: 3, canGoBack: true })
  assert.equal(render().length, 1)
  const question = sheetQuestionRows(sheet, sheet.items[2]!, 95, 'pane')
  assert.deepEqual(question[0]?.map((s) => s.kind === 'text' && s.text), ['How should sharing work?'])
  const choices = question.slice(1).flatMap((row) => row.filter((s) => s.kind === 'button'))
  assert.deepEqual(choices.map((s) => [s.hotkey, s.label]), [
    ['1', 'only invited people'], ['2', 'team-wide pages'], ['3', 'links with passwords'], ['4', 'public links'],
  ])
  const long = { ...sheet.items[2]!, statement: 'Who can open shared links, and which actions should people be able to take?' }
  const narrowPane = layoutSheetPane(sheet, long, sheet.pane!, 38)
  assert.ok(narrowPane.every((row) => segmentsWidth(row) <= 38))
  assert.equal(narrowPane.slice(1, 3).flat().map((s) => s.kind === 'text' && s.text).join(' '), long.statement)
  core.handle({ type: 'sheetAnswer', id: 1, now: 250, cue: 'c3', option: 2, via: 'pane' })
  assert.equal(core.currentView().sheet?.pane, undefined)
  assert.ok(render()[1]?.some((s) => s.kind === 'text' && s.text === '1 selected'))
  assert.ok(render()[4]?.some((s) => s.kind === 'button' && s.label === 'links with passwords' && s.detail?.includes('How should sharing work?')))
  assert.ok(render(38).slice(1).every((row) => segmentsWidth(row) <= 38))
  assert.ok(render(38)[4]?.some((s) => s.kind === 'button' && s.label === 'links with passwords'))
})

test('thinking has a localized label and disappears when no sheet arrives', () => {
  const core = createCore(ASSETS)
  core.handle(config({ language: 'auto' }))
  core.handle(draft('Crée un tableau pour le jardin partagé.'))
  const render = () => layoutBandRows({ ...core.currentView(), hasDraft: true, mode: 'auto' }, 95, 'ctrl+x tab')
  assert.deepEqual(render(), [[{ kind: 'progress', label: 'MarginCue · réflexion…' }]])
  core.handle(reply(1, 200, 'NONE'))
  assert.deepEqual(render(), [])
})

test('sheet telemetry logs IDs and counts with time from the first displayed row', () => {
  const core = createCore(ASSETS)
  core.handle(config())
  const effects = [
    ...core.handle(draft(KICKOFF)), ...core.handle(reply()),
    ...core.handle({ type: 'sheetShown', now: 220, id: 1 }),
    ...core.handle({ type: 'sheetShown', now: 230, id: 1 }),
    ...core.handle({ type: 'sheetPane', id: 1, move: 'open' }),
    ...core.handle({ type: 'sheetAnswer', id: 1, now: 250, cue: 'c1', option: 1, via: 'pane' }),
    ...core.handle({ type: 'sheetPane', id: 1, move: 'close' }),
    ...core.handle({ type: 'submit', now: 300, text: KICKOFF }),
    ...core.handle({ type: 'sheetAnswer', id: 1, now: 400, cue: 'c2', option: 0, via: 'composer' }),
  ]
  const metrics = effects.filter((effect) => effect.type === 'metric' && effect.name.startsWith('sheet-'))
  assert.deepEqual(metrics, [
    { type: 'metric', name: 'sheet-requested', req: 1 },
    { type: 'metric', name: 'sheet-reply', req: 1, items: 2, ms: 100, empty: false, ok: true },
    { type: 'metric', name: 'sheet-shown', req: 1, items: 2, afterSubmit: false },
    { type: 'metric', name: 'sheet-pane-opened', req: 1, afterSubmit: false },
    { type: 'metric', name: 'sheet-pick', req: 1, item: 'c1', option: 1, afterSubmit: false, ms: 30 },
    { type: 'metric', name: 'sheet-pane-answer', req: 1, item: 'c1', option: 1, afterSubmit: false },
    { type: 'metric', name: 'sheet-pane-closed', req: 1, open: 1, afterSubmit: false },
    { type: 'metric', name: 'sheet-submitted', req: 1, picked: 1, open: 1, pending: false },
    { type: 'metric', name: 'sheet-pick', req: 1, item: 'c2', option: 0, afterSubmit: true, ms: 180 },
    { type: 'metric', name: 'sheet-composer-answer', req: 1, item: 'c2', option: 0, afterSubmit: true },
  ])
})

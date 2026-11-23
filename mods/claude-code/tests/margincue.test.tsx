// `claude plugin test mods/claude-code`: the mod's hooks against the engine's
// own test kit. Every hook the test registers with `on` stands for the engine.
import type { On, PromptChangeInput, PromptChangeResult, PromptEditInput, PromptEditResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { ASSETS } from '../hooks/assets'
import type { ProfileBundle } from '../core/bundle'

const DRAFT = 'Build an export tool for the dashboard'
const REPLY = 'Which rows should it export? | filtered rows | all rows | selected rows only\nWhere should it run? | browser | terminal'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND = {
  plugin: 'margincue',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 95,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const
const ANSWER_PANE = {
  plugin: 'margincue', component: 'Pane', requestId: 'margincue-sheet', surface: 'terminal',
  props: { title: 'MarginCue', placement: 'inline', isFocused: true, bodyColumns: 98, scroll: { offset: 0, bodyRows: 7 }, view: {} },
} as const

type Engine = On

/** The composer's events, which the kit raises like any other though its `$` types do not list them. */
type Composer = {
  edit: (e: PromptEditInput) => Promise<PromptEditResult>
  change: (e: PromptChangeInput) => Promise<PromptChangeResult>
}
const composer = ($: { prompt: unknown }) => $.prompt as Composer

/** The engine beneath: a box that applies splices, a model that answers REPLY, a clock and a store. */
function world(on: Engine, reply: string | ((prompt: string, system: string) => Promise<string>) = REPLY) {
  const clock = mock.clock(on, { now: 1000 })
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const writes: string[] = []
  const root = '/project'
  const model = { name: 'largest' }
  const identity = { id: 'a-private-session-id' }
  const home = '/test-home'
  mock.env(on, { HOME: home })
  on('session.root', () => ({ value: root }))
  on('session.model', () => ({ value: model.name }))
  on('session.turns', () => ({ value: 0 }))
  on('session.id', () => ({ value: identity.id }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()].filter((path) => path.slice(0, path.lastIndexOf('/')) === e.path)
      .map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.stat', (_, e) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: files.get(e.path)!.length, mtimeMs: writes.length, isLink: false } }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    writes.push(e.path)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  const panes: unknown[] = []
  on('ui.open', (_, e) => {
    panes.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  const calls: string[] = []
  const painted: unknown[] = []
  on('command.register', () => ({ value: { command: 'margincue' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const box = { text: '', cursor: 0 }
  on('prompt.read', () => ({ value: { ...box } }))
  on('prompt.fill', (_, e) => {
    Object.assign(box, { text: e.text, cursor: e.cursor ?? e.text.length })
    return { isFilled: true, ...box }
  })
  on('prompt.paint', (_, e) => {
    painted.push(e.decorations)
    return { value: { isPainted: true, text: e.text ?? '', cursor: (e.text ?? '').length } }
  })
  on('model.complete', async (_, e) => {
    calls.push(e.prompt)
    const text = typeof reply === 'string' ? reply : await reply(e.prompt, e.system ?? '')
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    Object.assign(box, { text, cursor: e.start + e.inputText.length })
    return { ...box }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.change', (_, e) => {
    Object.assign(box, { text: e.text, cursor: e.cursor })
    return { text: e.text }
  })
  return { clock, calls, painted, store, files, writes, model, root, home, identity, box, panes }
}

/** Types `text` at the end of `before`, one edit, as the composer reports it. */
function edit(before: string, text: string) {
  return {
    origin: { kind: 'composer' as const },
    key: { key: text.slice(-1) },
    text: before,
    cursor: before.length,
    start: before.length,
    end: before.length,
    inputText: text,
  }
}

test('the answering pane advances and restores the draft with its caret after the last answer', async ($, on) => {
  const { clock, calls, box, panes } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const typed = await composer($).edit(edit(DRAFT, '.'))
  expect(typed.text).toBe(`${DRAFT}.`)
  expect(typed.decorations).toEqual([])
  await clock.settle()
  expect(calls).toEqual([`${DRAFT}.`])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'sheet-question-c1' }))?.props.label).toBe('Which rows should it export?')
  expect((await ui.find({ key: 'sheet-question-c2' }))?.props.label).toBe('Where should it run?')
  expect(await ui.find({ key: 'sheet-c1-0' })).toBeUndefined()
  expect((await ui.find({ key: 'sheet-open' }))?.props).toMatchObject({ label: 'Answer  Alt+↑', variant: 'primary' })
  box.cursor = 8
  await ui.press({ key: 'sheet-open' })
  expect(panes.at(-1)).toMatchObject({ id: 'margincue-sheet', focus: true, closeOnEscape: true })
  expect(box.text).toBe('')
  const pane = await $.ui.mount(ANSWER_PANE)
  expect(await pane.find({ type: 'Text', text: /1 of 2/ })).toBeDefined()
  expect((await pane.find({ key: 'sheet-c1-0' }))?.props).toMatchObject({ label: 'filtered rows', autoFocus: true, hotkey: '1' })
  expect(await pane.find({ key: 'sheet-c2-0' })).toBeUndefined()
  await pane.press({ key: 'sheet-c1-1' })
  expect(await pane.find({ type: 'Text', text: /2 of 2/ })).toBeDefined()
  expect(await pane.find({ key: 'sheet-c1-1' })).toBeUndefined()
  await pane.press({ key: 'sheet-c2-0' })
  expect(box).toEqual({ text: DRAFT + '.', cursor: 8 })
  expect(await ui.find({ type: 'Text', text: /2 selected/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
  expect((await ui.find({ key: 'sheet-question-c1' }))?.props.label).toBe('all rows  ·  Which rows should it export?')
  await pane.unmount()
  await ui.unmount()

  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Which rows should it export? all rows.\n- Where should it run? browser.`)
})

test('pressing a band question opens that question, including after an answer', async ($, on) => {
  const { clock, box } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pane = await $.ui.mount(ANSWER_PANE)
  await band.press({ key: 'sheet-question-c2' })
  expect(await pane.find({ type: 'Text', text: /2 of 2/ })).toBeDefined()
  await pane.press({ key: 'sheet-c2-1' })
  expect(box.text).toBe(DRAFT + '.')
  expect((await band.find({ key: 'sheet-question-c2' }))?.props.label).toBe('terminal  ·  Where should it run?')
  await band.press({ key: 'sheet-question-c2' })
  expect((await pane.find({ key: 'sheet-c2-1' }))?.props.autoFocus).toBe(true)
  await pane.press({ key: 'sheet-c2-0' })
  expect((await band.find({ key: 'sheet-question-c2' }))?.props.label).toBe('browser  ·  Where should it run?')
  expect((await band.find({ key: 'sheet-question-c1' }))?.props.label).toBe('Which rows should it export?')
  await pane.unmount()
  await band.unmount()
})

test('ignoring every sheet option leaves the submitted text alone', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.`)
})

test('the clear that precedes a submit does not lose the decisions', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'sheet-cycle' })
  await clock.settle()
  await ui.unmount()
  // Enter: the engine empties the box, then raises prompt.submit.
  await composer($).change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Which rows should it export? filtered rows.`)
})

test('/margincue off sends nothing and stays off in the next session', async ($, on) => {
  const { clock, calls, store } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({ command: 'margincue', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(off.text).toContain('off')
  expect(store.get('settings')).toMatchObject({ enabled: false })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.advance(2000)
  expect(calls.length).toBe(0)

  // A new session (a restart) reads the stored switch.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(`${DRAFT}.`, ' Now.'))
  await clock.advance(2000)
  expect(calls.length).toBe(0)

  const status = await $.command.run({ command: 'margincue', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(status.text).toContain('MarginCue is off')
})

test('slash commands are never reviewed and draw no band', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit('/compact keep the decisions we made toda', 'y'))
  await clock.advance(2000)
  expect(calls.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /margincue/ })).toBeUndefined()
  await ui.unmount()
})

test('the band lays out on every surface', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'sheet-question-c1' })).toBeDefined()
    await ui.unmount()
  }
})

test('language defaults to English and auto persists across sessions', async ($, on) => {
  const frenchDraft = 'Crée un tableau de bord pour le club'
  const { clock, calls, store } = world(on, async (_, system) => system.endsWith('in English.')
    ? 'Who can view it? | club members | anyone'
    : 'Qui peut le consulter ? | les membres du club | tout le monde')
  const start = () => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  const type = async () => {
    await composer($).edit(edit(frenchDraft, '.'))
    await clock.settle()
  }

  await start()
  expect((await command('status')).text).toContain('language en')
  await type()
  const english = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await english.find({ type: 'Text', text: /1 open decision/ })).toBeDefined()
  expect((await english.find({ key: 'sheet-question-c1' }))?.props.label).toBe('Who can view it?')
  await command('language auto')
  expect(store.get('settings')).toMatchObject({ language: 'auto' })
  expect(await english.find({ key: 'sheet-question-c1' })).toBeUndefined()
  await english.unmount()

  await start()
  expect((await command('status')).text).toContain('language auto')
  await type()
  const auto = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await auto.find({ type: 'Text', text: /1 décision ouverte/ })).toBeDefined()
  expect((await auto.find({ key: 'sheet-question-c1' }))?.props.label).toBe('Qui peut le consulter ?')
  expect(calls).toEqual([`${frenchDraft}.`, `${frenchDraft}.`])
  await command('language en')
  expect(store.get('settings')).toMatchObject({ language: 'en' })
  await auto.unmount()
})

const CLEANUP = "Remove the old test databases. Don't ask."
const PROJECT_DECISIONS = '/project/.margincue/decisions.json'
const cli = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

test('first-touch guard is local, saves the selected project option, and repeats as a mark', async ($, on) => {
  const { clock, calls, files, writes } = world(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const typed = await composer($).edit(edit(CLEANUP.slice(0, -1), '.'))
  expect(typed.decorations?.[0]).toMatchObject({ start: 0, end: 6, color: 'warning' })
  expect(calls.length).toBe(0)
  expect(writes.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'scope' })).toBeDefined()
  expect(await ui.find({ key: 'state-opt-1' })).toBeDefined()
  await ui.press({ key: 'state-opt-1' })
  await clock.settle()
  expect(JSON.parse(files.get(PROJECT_DECISIONS)!).decisions).toMatchObject([
    { slot: 'cleanup_reach', option: 'unused_only', scope: 'project' },
  ])
  expect(writes).toEqual([PROJECT_DECISIONS])
  await composer($).change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  const next = "Remove unused records. Don't ask."
  await composer($).edit(edit(next.slice(0, -1), '.'))
  expect(await ui.find({ key: 'state-opt-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Cleanup unreferenced matches only/ })).toBeDefined()
  const sent = await $.prompt.submit({ ...cli, text: next, wait: false })
  expect(sent.text).toBe(next + '\n\nDecisions:\n- Deletion targets unreferenced matches only.')
  expect(calls.length).toBe(0)
  const status = await $.command.run({ ...cli, command: 'margincue', args: 'state' })
  expect(status.text).toContain('This project')
  expect(status.text).toContain('cleanup_reach')
  expect((await $.command.run({ ...cli, command: 'margincue', args: 'forget cleanup_reach' })).text).toContain('Forgot')
  expect(JSON.parse(files.get(PROJECT_DECISIONS)!).decisions).toEqual([])
  await ui.unmount()
})

test('a model-only choice follows the session model, and a disk change refreshes the mark', async ($, on) => {
  const { clock, model, files, store } = world(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(CLEANUP.slice(0, -1), '.'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'scope' })
  await ui.press({ key: 'scope' })
  await ui.press({ key: 'state-opt-1' })
  expect([...store.values()]).toMatchObject([{ slot: 'cleanup_reach', option: 'unused_only', model: 'largest', scope: 'model' }])
  expect(files.has(PROJECT_DECISIONS)).toBe(false)
  expect(await ui.find({ type: 'Text', text: /unreferenced matches only/ })).toBeDefined()
  model.name = 'small'
  await clock.advance(1300)
  expect(await ui.find({ key: 'state-opt-0' })).toBeDefined()
  files.set(PROJECT_DECISIONS, JSON.stringify({ version: 1, decisions: [{
    slot: 'cleanup_reach', option: 'task_only', scope: 'project', setAt: 73,
  }] }))
  await clock.advance(1300)
  expect(await ui.find({ type: 'Text', text: /task-created artifacts only/ })).toBeDefined()
  await ui.unmount()
})

test('quiet shows a count and loads a personal bundle from the temporary home', async ($, on) => {
  const { calls, files, home, store } = world(on)
  const original = ASSETS.bundles!.find((bundle) => bundle.profile === 'general')!
  const slot = { ...original.slots[0]!, id: 'personal_trip', guard: false, label: { en: 'Trip checklist', fr: 'Préparation' },
    touch: { en: { match: ['trip checklist'] }, fr: { match: ['liste de voyage'] } } }
  const bundle: ProfileBundle = { ...original, profile: 'personal', slots: [slot] }
  files.set(`${home}/.margincue/bundles/personal.json`, JSON.stringify(bundle))
  store.set('settings', { mode: 'quiet' })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit('Update the trip checklist', '.'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^1 open$/ })).toBeDefined()
  expect(await ui.find({ key: 'state-opt-0' })).toBeUndefined()
  expect(calls.length).toBe(0)
  await ui.unmount()
})

test('review uses the requested catalog and offers a checklist with a persistent pick', async ($, on) => {
  let waitForReply: () => Promise<void>
  const { clock, calls, files, store } = world(on, async () => {
    await waitForReply()
    return 'holdout | final_score_partition\n'
  })
  waitForReply = () => clock.sleep(550)
  store.set('settings', { mode: 'quiet', sheet: false })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const draft = 'Validation picked our best checkpoint. Logs and an untouched labeled holdout are ready. Give me a headline number.'
  await composer($).edit(edit(draft.slice(0, -1), '.'))
  const command = await $.command.run({ ...cli, command: 'margincue', args: 'review ml-research' })
  expect(command.text).toContain('ml-research')
  expect(calls[0]).toContain('Candidate catalog:')
  expect(calls[0]).toContain('final_score_partition')
  const pane = await $.ui.mount({
    plugin: 'margincue', component: 'Pane', requestId: 'margincue-review', surface: 'terminal',
    props: { title: 'MarginCue review', placement: 'inline', isFocused: true, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /MarginCue · thinking…/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /MarginCue · thinking…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Running…/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Running…/ })).toBeUndefined()
  await clock.advance(600)
  expect(await ui.find({ type: 'Text', text: /MarginCue · thinking…/ })).toBeUndefined()
  await ui.unmount()
  expect(await pane.find({ key: 'final_score_partition-untouched_holdout' })).toBeDefined()
  await pane.press({ key: 'final_score_partition-untouched_holdout' })
  expect(JSON.parse(files.get(PROJECT_DECISIONS)!).decisions).toMatchObject([{ slot: 'final_score_partition', option: 'untouched_holdout' }])
  const sent = await $.prompt.submit({ ...cli, text: draft, wait: false })
  expect(sent.text).toContain('Headline evaluation uses untouched labeled holdout.')
  await pane.unmount()
})

test('event log records suppressed candidates without source text and preserves existing JSONL', async ($, on) => {
  const { clock, files, store } = world(on)
  const path = '/project/test-log.jsonl'
  files.set(path, '{"prior":true}\n')
  store.set('settings', { mode: 'quiet' })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const enabled = await $.command.run({ ...cli, command: 'margincue', args: `log ${path}` })
  expect(enabled.text).toContain('Logging decision events')
  await composer($).edit(edit('Delete conf1dent1al-old-records', '.'))
  await clock.advance(120)
  await $.command.run({ ...cli, command: 'margincue', args: 'log off' })
  const contents = files.get(path)!
  expect(contents).not.toContain('conf1dent1al')
  expect(contents).not.toContain('a-private-session-id')
  expect(contents).not.toContain('"/project"')
  const rows = contents.trim().split('\n').map((line) => JSON.parse(line))
  expect(rows[0]).toEqual({ prior: true })
  expect(rows.find((row) => row.event === 'candidate')).toMatchObject({
    mode: 'quiet', profile: 'general', slot: 'cleanup_reach', shown: false, reason: 'quiet',
    optionOrder: ['all_matches', 'unused_only', 'task_only'], default: 'all_matches',
  })
})

test('a late sheet shows numbered choices only for the matching turn and advances per answer', async ($, on) => {
  let waitForReply: () => Promise<void>
  const { clock, calls } = world(on, async () => {
    await waitForReply()
    return REPLY
  })
  waitForReply = () => clock.sleep(550)
  const session = mock.session(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const text = DRAFT + '.'
  await composer($).edit(edit(DRAFT, '.'))
  expect(calls.length).toBe(1)
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  const workingBand = { ...BAND.props, isWorking: true }
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: workingBand })
  expect(await ui.find({ type: 'Text', text: /MarginCue · thinking…/ })).toBeDefined()
  expect(await ui.find({ key: 'sheet-c1-0' })).toBeUndefined()
  expect((await composer($).edit(edit('', '1'))).text).toBe('1')
  await $.turn.start({ text: 'An unrelated turn.', turnId: 'other' })
  await clock.advance(600)
  expect(await ui.find({ key: 'sheet-c1-0' })).toBeUndefined()
  await $.turn.start({ text, turnId: 'submitted' })
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal',
    props: { ...workingBand, maxRows: 2, scroll: { offset: 2, bodyRows: 1 } } })
  expect((await ui.find({ key: 'sheet-c1-1' }))?.props.hotkey).toBeUndefined()
  expect((await composer($).edit(edit('', '2'))).text).toBe('2')
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: workingBand })
  expect(await ui.find({ type: 'Text', text: /MarginCue · thinking…/ })).toBeUndefined()
  expect((await ui.find({ key: 'sheet-c1-1' }))?.props.hotkey).toBe('2')
  expect(await ui.find({ key: 'sheet-c2-0' })).toBeUndefined()
  expect((await composer($).edit(edit('draft ', '2'))).text).toBe('draft 2')
  expect(session.appended()).toEqual([])
  expect((await composer($).edit(edit('', '2'))).text).toBe('')
  await clock.settle()
  expect(session.appended()).toMatchObject([{
    door: 'note', message: { type: 'user', content: [{ type: 'text', text: 'Amendment to my last prompt: Which rows should it export? all rows.' }] },
  }])
  expect(await ui.find({ key: 'sheet-c1-0' })).toBeUndefined()
  expect((await ui.find({ key: 'sheet-c2-0' }))?.props.hotkey).toBe('1')
  await $.turn.complete({ turnId: 'submitted', reason: 'answer', answer: 'Done.', durationMs: 1000, isAborted: false })
  expect(await ui.find({ key: 'sheet-c2-0' })).toBeUndefined()
  expect((await composer($).edit(edit('', '1'))).text).toBe('1')
  await ui.unmount()
})

test('quiet shows only a count and answers through the same pane', async ($, on) => {
  const { clock, calls, store } = world(on)
  store.set('settings', { mode: 'quiet' })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'sheet-open' }))?.props.label).toBe('2 open decisions · alt↑ to open')
  expect(await ui.find({ key: 'sheet-c1-0' })).toBeUndefined()
  await ui.press({ key: 'sheet-open' })
  const pane = await $.ui.mount(ANSWER_PANE)
  await pane.press({ key: 'sheet-skip' })
  expect((await pane.find({ key: 'sheet-c2-0' }))?.props.hotkey).toBe('1')
  await pane.press({ key: 'sheet-back' })
  await pane.press({ key: 'sheet-c1-0' })
  await pane.press({ key: 'sheet-c2-1' })
  expect(await pane.find({ key: 'sheet-c2-0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^0 open decisions$/ })).toBeDefined()
  await pane.unmount()

  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  expect((await command('sheet off')).text).toContain('off')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit('Build a tool to help our club keep score', '.'))
  await clock.settle()
  expect(calls).toEqual([`${DRAFT}.`])
  expect((await command('status')).text).toContain('sheet off')
  await ui.unmount()
})

test('A/B logs a sticky session assignment and reads totals for each arm', async ($, on) => {
  const { clock, calls, files, store, home, identity } = world(on)
  const start = () => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  await start()
  expect((await command('ab on')).text).toContain('new sessions')
  expect(store.get('settings')).toMatchObject({ ab: true, sheet: true })

  identity.id = 'first-trial'
  await start()
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const status = await command('ab status')
  const arm = status.text?.includes('in the sheet arm') ? 'sheet' : 'control'
  expect(status.text).toContain(`in the ${arm} arm`)
  expect(calls.length).toBe(arm === 'sheet' ? 1 : 0)
  if (arm === 'sheet') {
    await ui.press({ key: 'sheet-cycle' })
  }
  await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  expect((await command('ab status')).text).toContain('1 prompts sent')
  const [path] = [...files.keys()].filter((file) => file.startsWith(`${home}/.margincue/ab/`))
  const log = files.get(path!)!
  expect(log).not.toContain(identity.id)
  expect(log).not.toContain(DRAFT)
  expect(log).not.toContain('filtered rows')
  const rows = log.trim().split('\n').map((line) => JSON.parse(line))
  expect(rows[0]).toMatchObject({ event: 'session-arm', arm })
  expect(rows.at(-1)).toMatchObject({ event: 'sheet-submitted', arm, picked: arm === 'sheet' ? 1 : 0 })
  await start()
  expect((await command('ab status')).text).toContain(`${arm}: 1 sessions`)
  expect((await command('ab off')).text).toContain('off')
  expect((await command('ab status')).text).toContain(`${arm}: 1 sessions`)
  await ui.unmount()
})

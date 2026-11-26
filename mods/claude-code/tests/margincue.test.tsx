// `claude plugin test mods/claude-code`: the mod's hooks against the engine's
// own test kit. Every hook the test registers with `on` stands for the engine.
import type { ModelCompleteInput, ModelCompleteResult, On, PromptChangeInput, PromptChangeResult, PromptEditInput, PromptEditResult, RenderNode } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MountSelectTarget, TestBody } from 'claude-code/testing'
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
/** A card reply for DRAFT: two one-of rows and a number row (a slider of ten steps, 500 by default). */
const CARD = [
  'read | You want a CSV export of the dashboard data, built as a separate tool.',
  'kind | build',
  'row | export_rows | rows | one | Export {} | the filtered rows | all rows | the selected rows | @export tool',
  'row | runs_where | runs in | one | Run it {} | in the browser | from the terminal',
  'row | batch_size | batch | num | Write {} per batch | 500 | 100 | 5000 | rows',
].join('\n')
const SKETCH = ['title | Export dialog', '┌ Export ───────────┐', '│ Rows: filtered    │', '│ [ Download CSV ]  │', '└───────────────────┘'].join('\n')
const OPEN_CHOICES = '\n\nOpen choices ('
const EXPORT_QUESTION = '\n- Export … (all rows / the filtered rows / the selected rows)?'
const RUN_QUESTION = '\n- Run it … (from the terminal / in the browser)?'
const BATCH_QUESTION = '\n- Write … per batch (100 rows / 160 rows / 270 rows / 430 rows / 500 rows / 710 rows / 1200 rows / 1900 rows / 3100 rows / 5000 rows)?'
/** The preview as it travels with a prompt, once drawn for the choices being sent. */
const TARGET = `Target output, as sketched (Export dialog):\n\`\`\`text\n${SKETCH.split('\n').slice(1).join('\n')}\n\`\`\``

/** The model as MarginCue calls it: a card reading, a sketch, or anything else. */
function replies(card = CARD, sketch = SKETCH, other = REPLY) {
  return async (_prompt: string, system: unknown) => {
    const text = typeof system === 'string' ? system : JSON.stringify(system)
    return text.includes('how the agent will read it') ? card : text.includes('Draw what the finished result') ? sketch : other
  }
}

type Engine = On
type ModelFailure = (request: ModelCompleteInput) => ModelCompleteResult | undefined | Promise<ModelCompleteResult | undefined>

/** The composer's events, which the kit raises like any other though its `$` types do not list them. */
type Composer = {
  edit: (e: PromptEditInput) => Promise<PromptEditResult>
  change: (e: PromptChangeInput) => Promise<PromptChangeResult>
}
const composer = ($: { prompt: unknown }) => $.prompt as Composer

/** The engine beneath: a box that applies splices, a model that answers REPLY, a clock and a store. */
function world(on: Engine, reply: string | ((prompt: string, system: string) => Promise<string>) = REPLY,
  options: { git?: (args: string) => string | undefined; env?: Record<string, string>; submitted?: { text: string; origin: string }[]
    /** The model call failing: its result in place of a reply, or a throw or a promise that never settles. */
    failure?: ModelFailure } = {}) {
  const clock = mock.clock(on, { now: 1000 })
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const writes: string[] = []
  const root = '/project'
  const model = { name: 'largest' }
  const identity = { id: 'a-private-session-id' }
  const home = '/test-home'
  mock.env(on, { HOME: home, ...options.env })
  on('session.root', () => ({ value: root }))
  on('session.model', () => ({ value: model.name }))
  on('session.turns', () => ({ value: 0 }))
  on('session.id', () => ({ value: identity.id }))
  // Windows hands hooks its own form of a path (C:\\test-home\\…): the fake disk keys every path in one form.
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()].filter((path) => path.slice(0, path.lastIndexOf('/')) === norm(e.path).replace(/\/+$/, ''))
      .map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.stat', (_, e) => {
    if (!files.has(norm(e.path))) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: files.get(norm(e.path))!.length, mtimeMs: writes.length, isLink: false } }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    writes.push(norm(e.path))
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
  // Tests stand for a person who already answered the first-run questions, unless they set `onboarded` themselves.
  on('store.get', (_, e) => ({
    value: e.key === 'settings' ? { onboarded: 'done', ...(store.get('settings') as object ?? {}) } : store.get(e.key),
  }))
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
    const failure = await options.failure?.(e)
    if (failure) return { value: failure }
    const text = typeof reply === 'string' ? reply : await reply(e.prompt, e.system ?? '')
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    Object.assign(box, { text, cursor: e.start + e.inputText.length })
    return { ...box }
  })
  on('prompt.submit', (_, e) => {
    options.submitted?.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('prompt.change', (_, e) => {
    Object.assign(box, { text: e.text, cursor: e.cursor })
    return { text: e.text }
  })
  // No repository unless a test gives one: git answers as outside a work tree.
  on('process.run', (_, e) => {
    const out = options.git?.(e.argv.join(' '))
    return { value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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

const CLEANUP = "Remove the old test databases. Don't ask."
const PROJECT_DECISIONS = '/project/.margincue/decisions.json'
const cli = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

const WIDE = { ...BAND, surface: 'terminal' as const, props: { ...BAND.props, maxRows: 18, bodyColumns: 100 } }

test('the card reads a draft, shows typed controls, and sends its whole plan with what the person set', async ($, on) => {
  const { clock, calls } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  expect(calls[0]).toContain(`Draft:\n<<<\n${DRAFT}.\n>>>`)
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /You want a CSV export/ })).toBeDefined()
  expect((await ui.find({ key: 'card-c1-0' }))?.props.label).toBe('● the filtered rows')
  expect((await ui.find({ key: 'card-c1-1' }))?.props.label).toBe('○ all rows')
  // The number row is a slider, one button per step; its value is written beside it.
  expect(await ui.find({ type: 'Text', text: /^500 rows$/ })).toBeDefined()
  expect((await ui.find({ key: 'card-c3-4' }))?.props.label).toContain('●')
  // alt+↓ (the swap chord) changes the focused row; alt+↑ moves to the next.
  await ui.press({ key: 'card-cycle' })
  expect((await ui.find({ key: 'card-c1-1' }))?.props.label).toBe('● all rows')
  await ui.press({ key: 'card-next' })
  await ui.press({ key: 'card-next' })
  await ui.press({ key: 'card-cycle' })
  expect(await ui.find({ type: 'Text', text: /^710 rows$/ })).toBeDefined()
  await ui.unmount()
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toContain(`${DRAFT}.\n\nDecisions:\n- Export all rows.\n- Write 710 rows per batch.${OPEN_CHOICES}`)
  expect(sent.text).toContain(RUN_QUESTION)
})

test('the read setting persists and the band shortcut reads the draft in either mode', async ($, on) => {
  const { clock, calls, store } = world(on, replies())
  store.set('settings', { sketch: false })
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  await start()
  expect((await command('status')).text).toContain('read auto')
  await composer($).edit(edit('', DRAFT))
  const auto = await $.ui.mount(WIDE)
  expect((await auto.find({ type: 'Button', key: 'card-read' }))?.props.hotkey).toBe('c')
  expect(calls.length).toBe(0)
  await auto.press({ key: 'card-read' })
  await clock.settle()
  expect(calls.length).toBe(1)
  await auto.unmount()

  await command('read key')
  expect(store.get('settings')).toMatchObject({ read: 'key' })
  await start()
  await composer($).edit(edit(DRAFT, '.'))
  await clock.advance(1000)
  expect(calls.length).toBe(1)
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /ctrl\+x tab, c to read/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'card-read' }))?.props.hotkey).toBe('c')
  await ui.press({ key: 'card-read' })
  await clock.settle()
  expect(calls[1]).toContain(`<<<\n${DRAFT}.\n>>>`)
  expect(await ui.find({ type: 'Text', text: /ctrl\+x tab, c to read/ })).toBeUndefined()
  await ui.press({ key: 'card-read' })
  await clock.settle()
  expect(calls.length).toBe(2)
  await ui.unmount()

  await command('read auto')
  expect(store.get('settings')).toMatchObject({ read: 'auto' })
})

test('the chapter controls work on the draft and the log records counts only', async ($, on) => {
  const { calls, files, store } = world(on, replies())
  store.set('settings', { read: 'key', sketch: false })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  const path = '/project/chapters-log.jsonl'
  const draft = 'Design an A/B test for the private launch.'
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await command('profile product')
  await command('depth essentials')
  await command(`log ${path}`)
  await composer($).edit(edit('', draft))
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /§ / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Experiments, rollout, and decisions/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'chapter-toggle' }))?.props.hotkey).toBe('b')
  await ui.press({ key: 'chapter-toggle' })
  expect((await ui.find({ type: 'Text', text: /Theory\./ }))?.props).toMatchObject({ dimColor: true })
  await command('depth research')
  expect(await ui.find({ type: 'Text', text: /Theory\./ })).toBeDefined()
  await ui.press({ key: 'chapter-toggle' })
  expect(await ui.find({ type: 'Text', text: /Theory\./ })).toBeUndefined()
  await command('chapters off')
  expect(store.get('settings')).toMatchObject({ chapters: false })
  expect(await ui.find({ type: 'Button', key: 'chapter-toggle' })).toBeUndefined()
  await command('chapters on')
  expect(await ui.find({ type: 'Button', key: 'chapter-toggle' })).toBeDefined()
  await ui.press({ key: 'chapter-drop' })
  expect(await ui.find({ type: 'Button', key: 'chapter-toggle' })).toBeUndefined()
  expect(calls.length).toBe(0)
  await ui.unmount()
  await command('log off')
  const contents = files.get(path)!
  expect(contents).not.toContain(draft)
  expect(contents).not.toContain('Experiments, rollout, and decisions')
  const events = contents.trim().split('\n').map((line) => JSON.parse(line).event).filter((event) => event.startsWith('chapter-'))
  expect(events).toEqual(['chapter-shown', 'chapter-expanded'])
})

test('a click on a chip or a step sets its row; x drops a row and a newer reading leaves it out', async ($, on) => {
  const { clock, calls } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  await ui.press({ key: 'card-c2-1' })
  expect((await ui.find({ key: 'card-c2-1' }))?.props.label).toBe('● from the terminal')
  await ui.press({ key: 'card-c3-0' })
  expect(await ui.find({ type: 'Text', text: /^100 rows$/ })).toBeDefined()
  await ui.press({ key: 'card-drop' })
  expect(await ui.find({ key: 'card-c3-0' })).toBeUndefined()
  await composer($).edit(edit(`${DRAFT}.`, ' Keep it simple.'))
  await clock.advance(1000)
  expect(calls.some((call) => call.includes('Dismissed by the user (never raise again): batch_size'))).toBe(true)
  expect(calls.some((call) => call.includes('- Run it from the terminal.'))).toBe(true)
  expect(await ui.find({ key: 'card-c3-0' })).toBeUndefined()
  expect((await ui.find({ key: 'card-c2-1' }))?.props.label).toBe('● from the terminal')
  await ui.unmount()
})

test('a fresh store sends an untouched card as open questions, with its preview', async ($, on) => {
  const { clock, store } = world(on, replies())
  expect(store.has('settings')).toBe(false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text?.startsWith(`${DRAFT}.${OPEN_CHOICES}`)).toBe(true)
  expect(sent.text?.endsWith(`${EXPORT_QUESTION}${RUN_QUESTION}${BATCH_QUESTION}\n\n${TARGET}`)).toBe(true)
  expect(sent.text).not.toContain('\n\nDecisions:')
})

test('an unmarked stored all migrates to open and an explicit all survives a restart', async ($, on) => {
  const { clock, store } = world(on, replies())
  store.set('settings', { send: 'all', sketch: false })
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  await start()
  expect((await command('send')).text).toBe('MarginCue send is open.')
  await command('send all')
  expect(store.get('settings')).toMatchObject({ send: 'all', sendExplicit: true })
  await start()
  expect((await command('send')).text).toBe('MarginCue send is all.')
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const sent = await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Export the filtered rows.\n- Run it in the browser.\n- Write 500 rows per batch.`)
})

test('the keep-all hotkey sets every shown value and Enter sends the decisions', async ($, on) => {
  const { clock, store } = world(on, replies())
  store.set('settings', { sketch: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  await ui.press({ key: 'card-c1-1' })
  expect((await ui.find({ key: 'card-keep' }))?.props.hotkey).toBe('k')
  await ui.press({ key: 'card-keep' })
  expect(await ui.find({ type: 'Text', text: /^3 set$/ })).toBeDefined()
  const sent = await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Export all rows.\n- Run it in the browser.\n- Write 500 rows per batch.`)
  await ui.unmount()
})

for (const columns of [60, 80, 120]) {
  test(`the review hotkey runs the review at ${columns} columns`, async ($, on) => {
    const { clock, calls, panes } = world(on, replies())
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await composer($).edit(edit(DRAFT, '.'))
    await clock.settle()
    const ui = await $.ui.mount({ ...WIDE, props: { ...WIDE.props, bodyColumns: columns } })
    const before = calls.length
    expect((await ui.find({ key: 'review' }))?.props.hotkey).toBe('r')
    await ui.press({ key: 'review' })
    await clock.settle()
    expect(calls.length).toBe(before + 1)
    expect(calls.at(-1)).toContain(`Draft:\n<<<\n${DRAFT}.\n>>>`)
    expect(panes).toContainEqual(expect.objectContaining({ id: 'margincue-review' }))
    await ui.unmount()
  })
}

test('send picked is saved, labels open rows, and sends a preview only for the outgoing picks', async ($, on) => {
  const { clock, calls, store } = world(on, replies())
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  const type = async () => {
    await composer($).edit(edit(DRAFT, '.'))
    await clock.settle()
  }
  const submit = () => $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })

  await start()
  expect((await command('send')).text).toBe('MarginCue send is open.')
  await type()
  const ui = await $.ui.mount(WIDE)
  await command('send picked')
  expect(store.get('settings')).toMatchObject({ send: 'picked' })
  expect(await ui.find({ type: 'Text', text: /^3 left to agent$/ })).toBeDefined()
  await ui.press({ key: 'card-c1-1' })
  const picked = `${DRAFT}.\n\nDecisions:\n- Export all rows.`
  expect((await submit()).text).toBe(picked)
  await ui.unmount()

  await start()
  expect((await command('send')).text).toBe('MarginCue send is picked.')
  await type()
  const restored = await $.ui.mount(WIDE)
  await restored.press({ key: 'card-c1-1' })
  await clock.advance(1000)
  expect(calls.at(-1)).toContain('Choices:\n- Export all rows.')
  expect(calls.at(-1)).not.toContain('Run it in the browser.')
  expect((await submit()).text).toBe(`${picked}\n\n${TARGET}`)
  await restored.unmount()
  await command('send all')
  expect(store.get('settings')).toMatchObject({ send: 'all' })
})

test('send open is saved, labels open rows, and asks the agent about the rows left alone', async ($, on) => {
  const { clock, store } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  expect((await command('send nope')).text).toBe('Use /margincue send all|picked|open.')
  await command('send open')
  expect(store.get('settings')).toMatchObject({ send: 'open' })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /^3 left to agent$/ })).toBeDefined()
  await ui.press({ key: 'card-c1-1' })
  const sent = await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  // The pick travels as a decision; the rows left alone travel as questions, never as the reading's guesses.
  expect(sent.text?.startsWith(`${DRAFT}.\n\nDecisions:\n- Export all rows.\n\nOpen choices (`)).toBe(true)
  expect(sent.text).toContain('\n- Run it … (from the terminal / in the browser)?')
  expect(sent.text).toContain(BATCH_QUESTION)
  expect(sent.text).not.toContain('Run it in the browser.')
  await ui.unmount()
  await command('send all')
})

test('the clear that precedes a submit does not lose the decisions', async ($, on) => {
  const { clock } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  await ui.press({ key: 'card-cycle' })
  await clock.settle()
  await ui.unmount()
  // Enter: the engine empties the box, then raises prompt.submit.
  await composer($).change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text?.startsWith(`${DRAFT}.\n\nDecisions:\n- Export all rows.${OPEN_CHOICES}`)).toBe(true)
  expect(sent.text).toContain(RUN_QUESTION)
  expect(sent.text).toContain(BATCH_QUESTION)
})

test('the band lays out at the terminal; an app draws no draft card', async ($, on) => {
  const { clock } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /You want a CSV export/ })).toBeDefined()
  await ui.press({ key: 'card-c1-1' })
  expect((await ui.find({ key: 'card-c1-1' }))?.props.label).toBe('● all rows')
  await ui.press({ key: 'card-c1-0' })
  await ui.unmount()
  // The desktop app's Code tab, VS Code and the phone ask a draft's choices in their own panel at Enter: no card
  // is drawn above their box for it.
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const app = await $.ui.mount({ ...WIDE, surface })
    expect(await app.find({ key: 'card-c1-0' })).toBeUndefined()
    await app.unmount()
  }
})

const COMPOSE = {
  model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [],
  outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [],
}

test('the choice-marking instruction goes to interactive sessions only, never to a scripted run', async ($, on) => {
  world(on, replies())
  on('prompt.compose', () => ({ sections: [] }))
  const marks = async () => (await $.prompt.compose(COMPOSE)).sections.some((section) => section.id === 'margincue:blanks')
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  expect(await marks()).toBe(false)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  expect(await marks()).toBe(true)
})

test('a session the desktop app or VS Code drives through the SDK gains a person when its client attaches', async ($, on) => {
  const indexed: string[] = []
  const { clock } = world(on, replies(), { git: (args) => {
    indexed.push(args)
    return undefined
  } })
  on('prompt.compose', () => ({ sections: [] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  const marks = async () => (await $.prompt.compose(COMPOSE)).sections.some((section) => section.id === 'margincue:blanks')
  // The SDK starts the session with no screen: until a client attaches it is a script, left alone.
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await clock.advance(2000)
  expect(await marks()).toBe(false)
  expect(indexed.length).toBe(0)
  // The desktop app connects: the project is indexed (for the names on the card) and the agent marks its choices.
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  expect(indexed.some((args) => args.includes('ls-files'))).toBe(true)
  expect(await marks()).toBe(true)
})

/** The engine's question panel as a person answers it: `answer` gives the reply to each question, or null to close it. */
type PanelSpec = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }
function panel(on: Engine, answer: (question: PanelSpec) => string | null) {
  const asked: PanelSpec[] = []
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { deny: `no ${e.tool} here` }
    const questions = e.questions as unknown as PanelSpec[]
    asked.push(...questions)
    const reply = answer(questions[0]!)
    return reply === null ? { deny: 'The user closed the question.' } : { result: { questions, answers: { [questions[0]!.question]: reply } } }
  })
  return asked
}
const replyTo = (answers: Record<string, string>) => (question: PanelSpec) => answers[question.question] ?? null

test('in the desktop app the draft is unseen while typed: its open choices come at Enter, in Claude\'s own question panel', async ($, on) => {
  const { clock } = world(on, replies())
  const asked = panel(on, replyTo({ 'Rows: export …?': 'all rows', 'Run it …?': 'from the terminal' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'sdk' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  // Two answered; the third question was closed, which stops the questions: what is set goes.
  const sent = (await pending).text
  expect(sent?.startsWith(`${DRAFT}.\n\nDecisions:\n- Export all rows.\n- Run it from the terminal.${OPEN_CHOICES}`)).toBe(true)
  expect(sent?.endsWith(BATCH_QUESTION)).toBe(true)
  expect(asked.map((question) => question.header)).toEqual(['Rows', 'Runs in', 'Batch'])
  // The app shows the question alone: the label leads it, unless the question already opens on it.
  expect(asked.map((question) => question.question)).toEqual(['Rows: export …?', 'Run it …?', 'Batch: write … per batch?'])
  // What Claude would assume is said so.
  expect(asked[0]!.options.map((option) => option.label)).toEqual(['the filtered rows (assumed)', 'all rows', 'the selected rows'])
  // The panel preselects its first option: what Claude would assume comes first. A range offers the assumed step,
  // its ends and one between.
  expect(asked[2]!.options.map((option) => option.label)).toEqual(['500 rows (assumed)', '100 rows', '1900 rows', '5000 rows'])
})

/** Claude's dialog in the desktop app, held open until the test answers it (null closes it unanswered). */
function heldPanel(on: Engine) {
  const asked: PanelSpec[] = []
  let reply: (answer: string | null) => void = () => {}
  const answered = new Promise<string | null>((resolve) => {
    reply = resolve
  })
  on('tool.call', async (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { deny: `no ${e.tool} here` }
    const questions = e.questions as unknown as PanelSpec[]
    asked.push(...questions)
    const answer = await answered
    return answer === null ? { deny: 'The user closed the question.' } : { result: { questions, answers: { [questions[0]!.question]: answer } } }
  })
  return { asked, answer: (answer: string | null) => reply(answer) }
}
const DIALOG = { plugin: 'margincue', component: 'AskUserQuestion', requestId: 'dialog', surface: 'desktop' } as const
/** A pick in the menu of one of the card's chips. */
async function pick(ui: { select: (target: MountSelectTarget) => Promise<unknown> }, row: string, option: number | string) {
  await ui.select({ key: `card-${row}`, value: String(option) })
}
type ChipProps = { label?: string; value?: string; options?: { label?: string }[] }

/** A desktop session as the app starts one, with a prompt sent at Enter and its dialog open. */
async function desktopAtEnter($: Parameters<TestBody>[0], on: Engine, card = CARD, options: { failure?: ModelFailure; logPath?: string } = {}) {
  const { clock, files } = world(on, replies(card), { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, failure: options.failure })
  const gate = heldPanel(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  if (options.logPath) await $.command.run({ ...cli, command: 'margincue', args: `log ${options.logPath}` })
  await clock.settle()
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...DIALOG, props: { tool: 'AskUserQuestion', questions: gate.asked } })
  return { clock, files, gate, pending, ui }
}

test('in the desktop app MarginCue draws its own card above Claude\'s dialog; Go ahead sends its plan', async ($, on) => {
  const { gate, pending, ui } = await desktopAtEnter($, on)
  // Claude's dialog is one question under the card: send, or send as written.
  expect(gate.asked.map((question) => [question.question, question.options.map((option) => option.label)])).toEqual([
    ['Which prompt should Claude use?', ['Go ahead with this plan', 'Use my prompt as written']],
  ])
  // The card: how the prompt reads, then one line a choice, its name and what Claude would assume; a click opens
  // the app's own menu there.
  expect(await ui.find({ type: 'Text', text: /^You want a CSV export/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 choices Claude would make · leaves suggested defaults to Claude/ })).toBeDefined()
  const chip = async (row: string) => (await ui.find({ key: `card-${row}` }))?.props as ChipProps
  expect([(await chip('c1')).label, (await chip('c1')).value]).toEqual(['Rows', '0'])
  expect((await chip('c1')).options?.map((option) => option.label)).toEqual(['the filtered rows', 'all rows', 'the selected rows'])
  expect((await chip('c2')).label).toBe('Runs in')
  await pick(ui, 'c1', 1)
  expect((await chip('c1')).value).toBe('1')
  expect(await ui.find({ type: 'Text', text: /3 choices Claude would make, 1 yours/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\u2713 yours$/ })).toBeDefined()
  // A range offers every step in its menu.
  expect((await chip('c3')).options?.length).toBe(10)
  await ui.press({ key: 'card-keep' })
  expect(await ui.find({ type: 'Text', text: /3 choices Claude would make, 3 yours/ })).toBeDefined()
  gate.answer('Go ahead with this plan')
  expect((await pending).text).toBe(`${DRAFT}.\n\nDecisions:\n- Export all rows.\n- Run it in the browser.\n- Write 500 rows per batch.`)
  await ui.unmount()
})

test('the app card marks an untouched purge and sends the row as a question', async ($, on) => {
  const card = [
    'read | You want a team retention setting.', 'kind | change',
    'row | purge | retention | one | After {}, the agent will permanently delete the team in a scheduled job | 30 days | 7 days',
  ].join('\n')
  const { gate, pending, ui } = await desktopAtEnter($, on, card)
  expect(await ui.find({ type: 'Text', text: 'left to agent' })).toBeDefined()
  gate.answer('Go ahead with this plan')
  const sent = (await pending).text
  expect(sent).toContain(`${DRAFT}.\n\nOpen choices (`)
  expect(sent).toContain('\n- After …, the agent will permanently delete the team in a scheduled job (7 days / 30 days)?')
  await ui.unmount()
})

test('the card keeps within the 48 rows the app allows there: the preview joins it once drawn, whole, and only if it fits', async ($, on) => {
  const { clock, gate, pending, ui } = await desktopAtEnter($, on)
  await clock.advance(5000)
  expect(await ui.find({ key: 'card-c1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Preview · Export dialog/ })).toBeDefined()
  gate.answer(null)
  await pending
  await ui.unmount()
})

test('a desktop sketch that times out while the dialog is open draws its preview on one retry', async ($, on) => {
  const logPath = '/project/test-log.jsonl'
  const timeouts: (number | undefined)[] = []
  let timeOut = () => {}
  const first = new Promise<ModelCompleteResult>((resolve) => { timeOut = () => resolve(FAILURES['timed out']) })
  const { clock, files, gate, pending, ui } = await desktopAtEnter($, on, CARD, {
    logPath,
    failure: (request) => {
      if (!request.system?.includes('Draw what the finished result')) return
      timeouts.push(request.timeoutMs)
      if (timeouts.length === 1) return first
    },
  })
  expect(timeouts).toEqual([20000])
  expect(await ui.find({ key: 'card-c1' })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  timeOut()
  await clock.settle()
  expect(timeouts).toEqual([20000, 20000])
  expect(await ui.find({ type: 'Text', text: /Preview · Export dialog/ })).toBeDefined()
  gate.answer(null)
  await pending
  await ui.unmount()
  await $.command.run({ ...cli, command: 'margincue', args: 'log off' })
  expect(files.get(logPath)).toMatch(/"event":"sketch-retry"[^\n]*"reason":"aborted"/)
})

test('a desktop reading without a kind still draws a preview for a build request', async ($, on) => {
  const logPath = '/project/test-log.jsonl'
  const { clock, files, gate, pending, ui } = await desktopAtEnter($, on, CARD.replace('kind | build\n', ''), { logPath })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /Preview · Export dialog/ })).toBeDefined()
  gate.answer(null)
  await pending
  await ui.unmount()
  await $.command.run({ ...cli, command: 'margincue', args: 'log off' })
  expect(files.get(logPath)).toMatch(/"event":"card-kind-derived"[^\n]*"kind":"build"/)
})

test('a preview the size of a page sketch fits in the card, and the app takes the card', async ($, on) => {
  const page = ['title | Reports page', ...Array.from({ length: 12 }, (_, i) => `│ ${String(i).padEnd(2)} ${'─'.repeat(38)} │`)].join('\n')
  const { clock } = world(on, replies(CARD, page), { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })
  const gate = heldPanel(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(6000)
  const ui = await $.ui.mount({ ...DIALOG, props: { tool: 'AskUserQuestion', questions: gate.asked } })
  expect(await ui.find({ type: 'Text', text: /Preview · Reports page/ })).toBeDefined()
  await ui.drawn()
  gate.answer(null)
  await pending
  await ui.unmount()
})

test('a wide sketch is drawn as a picture scaled to the card: it never wraps, and the app takes the card', async ($, on) => {
  const wide = ['title | Weekly report', ...Array.from({ length: 10 }, (_, i) => `\u2502 row ${i} ${'\u00b7'.repeat(70)} \u2502`)].join('\n')
  const { clock } = world(on, replies(CARD, wide), { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })
  const gate = heldPanel(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(6000)
  const ui = await $.ui.mount({ ...DIALOG, props: { tool: 'AskUserQuestion', questions: gate.asked } })
  const picture = await ui.find({ type: 'Svg' })
  expect(picture).toBeDefined()
  expect(String(picture?.props.source)).toContain('viewBox')
  expect(String(picture?.props.alt)).toContain('Weekly report')
  await ui.drawn()
  gate.answer(null)
  await pending
  await ui.unmount()
})

test('a pick on the card redraws the preview with the new choice', async ($, on) => {
  const drawn: string[] = []
  const reply = async (prompt: string, system: unknown) => {
    const text = typeof system === 'string' ? system : JSON.stringify(system)
    if (text.includes('Draw what the finished result')) {
      drawn.push(prompt)
      return SKETCH
    }
    return text.includes('how the agent will read it') ? CARD : REPLY
  }
  const { clock } = world(on, reply, { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })
  const gate = heldPanel(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...DIALOG, props: { tool: 'AskUserQuestion', questions: gate.asked } })
  const first = drawn.length
  expect(first).toBeGreaterThan(0)
  await pick(ui, 'c1', 1)
  await clock.advance(2000)
  // The picture follows the card: it is drawn again for what the person picked.
  expect(drawn.length).toBe(first + 1)
  expect(drawn.at(-1)).toContain('Export all rows')
  gate.answer(null)
  await pending
  await ui.unmount()
})

test('a pick-any choice is one chip too: its menu ticks what is set, and a pick toggles it', async ($, on) => {
  const card = [
    'read | You want a weekly activity report for team owners.',
    'kind | build',
    'row | covers | covers | many | Include {} in the report | sign-ins | invitations | billing events',
  ].join('\n')
  const { gate, pending, ui } = await desktopAtEnter($, on, card)
  const labels = async () => ((await ui.find({ key: 'card-c1' }))?.props as ChipProps).options?.map((option) => option.label)
  expect(await labels()).toEqual(['sign-ins +2', '\u2713 sign-ins', '\u2713 invitations', '\u2713 billing events'])
  // Each entry names the state it leads to: a pick that arrives twice still lands once.
  await pick(ui, 'c1', 'drop-2')
  await pick(ui, 'c1', 'drop-2')
  expect(await labels()).toEqual(['sign-ins +1', '\u2713 sign-ins', '\u2713 invitations', '\u25cb billing events'])
  // The first entry shows what is set and changes nothing.
  await pick(ui, 'c1', 'set')
  gate.answer('Go ahead with this plan')
  expect((await pending).text).toBe('Build an export tool for the dashboard.\n\nDecisions:\n- Include sign-ins and invitations in the report.')
  await ui.unmount()
})

test('what the person types under "Other" in Claude\'s dialog is added to the prompt, ahead of its Decisions', async ($, on) => {
  const { gate, pending, ui } = await desktopAtEnter($, on)
  await pick(ui, 'c1', 1)
  gate.answer('Only owners of paid teams get the CSV.')
  const sent = (await pending).text
  expect(sent?.startsWith(`${DRAFT}.\n\nOnly owners of paid teams get the CSV.\n\nDecisions:\n- Export all rows.${OPEN_CHOICES}`)).toBe(true)
  expect(sent?.endsWith(RUN_QUESTION + BATCH_QUESTION)).toBe(true)
  await ui.unmount()
})

test('Send as written drops what was picked on the card; Skip or closing the dialog sends what is set', async ($, on) => {
  const raw = await desktopAtEnter($, on)
  await pick(raw.ui, 'c1', 1)
  raw.gate.answer('Use my prompt as written')
  expect((await raw.pending).text).toBe(`${DRAFT}.`)
  await raw.ui.unmount()
})

test('Skip, like closing the dialog, sends the prompt as written: the picks go only on a yes', async ($, on) => {
  const { gate, pending, ui } = await desktopAtEnter($, on)
  await pick(ui, 'c1', 1)
  gate.answer('[No preference]')
  expect((await pending).text).toBe(`${DRAFT}.`)
  await ui.unmount()
})

test('typed text in brackets under Other is the person\'s words, not a skip', async ($, on) => {
  const { gate, pending, ui } = await desktopAtEnter($, on)
  gate.answer('[include archived teams]')
  const sent = (await pending).text
  expect(sent?.startsWith(`${DRAFT}.\n\n[include archived teams]${OPEN_CHOICES}`)).toBe(true)
  expect(sent?.endsWith(`${EXPORT_QUESTION}${RUN_QUESTION}${BATCH_QUESTION}\n\n${TARGET}`)).toBe(true)
  await ui.unmount()
})

test('a name the code lacks reads unmatched on the card until the person picks its match', async ($, on) => {
  const files = ['src/dashboard/index.ts', 'src/dashboard/export.ts', 'src/city/canvas.ts']
  const { clock } = world(on, replies(), {
    env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    git: (args) => args.includes('ls-files') ? files.join('\n')
      : args.includes('(class|interface') ? 'src/dashboard/index.ts:1:export function Dashboard\nsrc/dashboard/export.ts:3:export class ExportTool'
      : args.includes('grep') ? "src/city/canvas.ts:9:'South of Market'\nsrc/city/canvas.ts:12:'Maya'"
      : '',
  })
  const gate = heldPanel(on)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await clock.settle()
  const draft = 'Add a CSV button to the Dashboard so Maya can export the Old Market orders'
  const pending = $.prompt.submit({ text: `${draft}.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...DIALOG, props: { tool: 'AskUserQuestion', questions: gate.asked } })
  expect(await ui.find({ type: 'Text', text: /^No match for \u201cOld Market\u201d in your code$/ })).toBeDefined()
  const match = (await ui.find({ key: 'card-c1' }))?.props as ChipProps
  expect(match.value).toBe('none')
  expect(match.options?.[0]?.label).toBe('Choose a match\u2026')
  // The candidates travel as an open question.
  gate.answer('Go ahead with this plan')
  const sent = (await pending).text
  expect(sent).toContain('\n- "Old Market" is … (new, to be added / South of Market)?')
  expect(sent).not.toContain('Decisions:')
  await ui.unmount()
})

test('in key mode an unseen desktop draft goes through without a reading or a dialog', async ($, on) => {
  const file = 'src/city/canvas.ts'
  const { clock, calls, store } = world(on, replies(), {
    env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    git: (args) => args.includes('ls-files') ? file : args.includes('grep') ? `${file}:9:'South of Market'` : '',
  })
  store.set('settings', { read: 'key' })
  const gate = heldPanel(on)
  gate.answer('Go ahead with this plan')
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await clock.settle()
  const text = 'Fix the Old Market label in `src/city/canvas.ts`.'
  const sent = await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  expect(calls.length).toBe(0)
  expect(gate.asked.length).toBe(0)
  expect(sent.text).toBe(`${text}\n\nDecisions:\n- Where things are: src/city/canvas.ts (${file}).`)
})

test('Claude\'s own questions are drawn as Claude asked them: the card only joins MarginCue\'s', async ($, on) => {
  const { gate, pending, ui } = await desktopAtEnter($, on)
  const other = await $.ui.mount({ ...DIALOG, requestId: 'claude', props: { tool: 'AskUserQuestion', questions: [
    { question: 'Which database should I use?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] },
  ] } })
  expect(await other.find({ key: 'card-c1' })).toBeUndefined()
  expect(await ui.find({ key: 'card-c1' })).toBeDefined()
  gate.answer(null)
  expect((await pending).text).toBe(`${DRAFT}.`)
  await other.unmount()
  await ui.unmount()
})

/** A session an app drives through the SDK without naming itself: its open choices come one question at a time. */
async function attachedApp($: Parameters<TestBody>[0], on: Engine, card = CARD) {
  const { clock } = world(on, replies(card))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  return clock
}

test('one question at a time: a pick-any answer comes comma-joined, and labels with commas in them are still read right', async ($, on) => {
  const card = [
    'read | You want a weekly activity report for team owners.',
    'kind | build',
    'row | covers | covers | many | Include {} in the report | sign-ins, invitations and changes | billing events | role changes',
  ].join('\n')
  const asked = panel(on, (question) => question.options.map((option) => option.label).filter((label) => !label.startsWith('billing')).join(', '))
  const clock = await attachedApp($, on, card)
  const pending = $.prompt.submit({ text: 'Build a weekly activity report for team owners.', origin: { kind: 'sdk' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  expect(asked[0]!.multiSelect).toBe(true)
  const sent = (await pending).text
  expect(sent).toContain('sign-ins, invitations and changes')
  expect(sent).toContain('role changes')
  expect(sent).not.toContain('billing events')
  expect(sent).not.toContain('none of these')
})

test('one question at a time: what the person types under "Other" goes as that choice\'s Decision, in their words', async ($, on) => {
  panel(on, replyTo({ 'Rows: export …?': 'only the rows changed since the last export, newest first' }))
  const clock = await attachedApp($, on)
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'sdk' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  const sent = (await pending).text
  expect(sent?.startsWith(`${DRAFT}.\n\nDecisions:\n- Export only the rows changed since the last export, newest first.${OPEN_CHOICES}`)).toBe(true)
  expect(sent?.endsWith(RUN_QUESTION + BATCH_QUESTION)).toBe(true)
})

test('one question at a time: Skip leaves a question to Claude, and the next question still comes', async ($, on) => {
  const asked = panel(on, replyTo({ 'Rows: export …?': '[No preference]', 'Run it …?': 'from the terminal' }))
  const clock = await attachedApp($, on)
  const pending = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'sdk' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  const sent = (await pending).text
  expect(sent?.startsWith(`${DRAFT}.\n\nDecisions:\n- Run it from the terminal.${OPEN_CHOICES}`)).toBe(true)
  expect(sent?.endsWith(EXPORT_QUESTION + BATCH_QUESTION)).toBe(true)
  expect(asked.length).toBe(3)
})

test('a script\'s prompt through the SDK, with no app attached, goes through untouched and unheld', async ($, on) => {
  const { clock } = world(on, replies())
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'sdk' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.`)
})

test('the desktop app says so in the engine entrypoint: its prompts get the card at Enter without any attach', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const { gate, pending, ui } = await desktopAtEnter($, on)
  expect((await $.prompt.compose(COMPOSE)).sections.some((section) => section.id === 'margincue:blanks')).toBe(true)
  expect(gate.asked.length).toBe(1)
  gate.answer('Go ahead with this plan')
  expect((await pending).text?.startsWith(`${DRAFT}.${OPEN_CHOICES}`)).toBe(true)
  await ui.unmount()
})

test('language defaults to English and auto persists across sessions', async ($, on) => {
  const frenchDraft = 'Crée un tableau de bord pour le club de foot'
  const english = 'read | You want a dashboard for the football club.\nkind | build\nrow | access | access | one | Open it to {} | club members | anyone'
  const french = "read | Vous voulez un tableau de bord pour le club.\nkind | build\nrow | access | accès | one | Ouvert {} | aux membres | à tous"
  const { clock, store } = world(on, async (prompt, system) => {
    const text = typeof system === 'string' ? system : JSON.stringify(system)
    if (!text.includes('how the agent will read it')) return 'NONE'
    return text.includes("in the draft's language") ? french : english
  })
  const start = () => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  const type = async () => {
    await composer($).edit(edit(frenchDraft, '.'))
    await clock.settle()
  }

  await start()
  expect((await command('status')).text).toContain('language en')
  await type()
  const first = await $.ui.mount(WIDE)
  expect(await first.find({ type: 'Text', text: /You want a dashboard/ })).toBeDefined()
  await command('language auto')
  expect(store.get('settings')).toMatchObject({ language: 'auto' })
  await first.unmount()

  await start()
  expect((await command('status')).text).toContain('language auto')
  await type()
  const auto = await $.ui.mount(WIDE)
  expect(await auto.find({ type: 'Text', text: /Vous voulez un tableau de bord/ })).toBeDefined()
  expect((await auto.find({ key: 'card-c1-0' }))?.props.label).toBe('● aux membres')
  await command('language en')
  expect(store.get('settings')).toMatchObject({ language: 'en' })
  await auto.unmount()
})

test('quiet keeps the card to one line and the alt keys still work', async ($, on) => {
  const { clock, calls, store } = world(on, replies())
  store.set('settings', { mode: 'quiet' })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /3 left to agent/ })).toBeDefined()
  expect(await ui.find({ key: 'card-c1-0' })).toBeUndefined()
  await ui.press({ key: 'card-cycle' })
  expect(await ui.find({ type: 'Text', text: /2 left to agent/ })).toBeDefined()
  await ui.unmount()

  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  expect((await command('card off')).text).toContain('off')
  const before = calls.length
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit('Build a tool to help our club keep score', '.'))
  await clock.settle()
  expect(calls.length).toBe(before)
  expect((await command('status')).text).toContain('card off')
})

test('grounding links names to the code, asks what a missing one means, and says where things are', async ($, on) => {
  const files = ['src/dashboard/index.ts', 'src/dashboard/export.ts', 'src/city/canvas.ts', 'tools/runlog/analyze.mjs', 'tools/runlog/qa.mjs']
  const { clock, calls } = world(on, replies(), {
    git: (args) => args.includes('ls-files') ? files.join('\n')
      : args.includes('(class|interface') ? 'src/dashboard/index.ts:1:export function Dashboard\nsrc/dashboard/export.ts:3:export class ExportTool'
      : args.includes('grep') ? "src/city/canvas.ts:9:'South of Market'\nsrc/city/canvas.ts:12:'Maya'"
      : '',
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const draft = 'Add a CSV button to the Dashboard so Maya can export the Old Market orders through `ExportTool`'
  const typed = await composer($).edit(edit(draft, '.'))
  const at = draft.indexOf('Old Market')
  expect(typed.decorations).toContainEqual({ start: at, end: at + 10, underline: true, color: 'warning' })
  expect(typed.decorations).toContainEqual({ start: draft.indexOf('Maya'), end: draft.indexOf('Maya') + 4, underline: true, color: 'suggestion' })
  await clock.settle()
  expect(calls[0]).toContain('In the code: Dashboard (src/dashboard/index.ts); Maya (src/city/canvas.ts)')
  expect(calls[0]).toContain('Not found in the code, asked about separately (no row for these): "Old Market"')
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /in code/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Old Market$/ })).toBeDefined()
  const repo = await ui.find({ key: 'card-c1-0' })
  expect(repo?.props.label).toBe('○ South of Market')
  await ui.press({ key: 'card-c1-0' })
  await ui.unmount()
  const sent = await $.prompt.submit({ ...cli, text: `${draft}.`, wait: false })
  // Only what the draft wrote as code says where things are; Dashboard and Maya stay links on screen.
  expect(sent.text?.startsWith(`${draft}.\n\nDecisions:\n- "Old Market" is South of Market (src/city/canvas.ts).\n` +
    `- Where things are: ExportTool (src/dashboard/export.ts).${OPEN_CHOICES}`)).toBe(true)
  expect(sent.text?.endsWith(EXPORT_QUESTION + RUN_QUESTION + BATCH_QUESTION)).toBe(true)
  expect((await $.command.run({ ...cli, command: 'margincue', args: 'status' })).text).toContain('Project index: ready')
})

test('the sketch shows what done looks like and travels with the prompt unless left out', async ($, on) => {
  const { clock, calls, store } = world(on, replies())
  store.set('settings', { send: 'all', sendExplicit: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  expect(calls.length).toBe(2)
  expect(calls[1]).toContain('Choices:\n- Export the filtered rows.')
  const ui = await $.ui.mount(WIDE)
  expect((await ui.find({ key: 'sketch-title' }))?.props.label).toBe('Export dialog')
  expect(await ui.find({ type: 'Text', text: /Download CSV/ })).toBeDefined()
  expect((await ui.find({ key: 'sketch-pin' }))?.props.label).toBe('✓ goes with the prompt')
  await ui.press({ key: 'sketch-pin' })
  expect((await ui.find({ key: 'sketch-pin' }))?.props.label).toBe('attach to prompt')
  await ui.press({ key: 'sketch-pin' })
  await ui.unmount()
  const sent = await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Export the filtered rows.\n- Run it in the browser.\n- Write 500 rows per batch.\n\n${TARGET}`)
})

test('choices the agent marks become switches during the turn, then a receipt and a follow-up', async ($, on) => {
  const { clock, box } = world(on, replies())
  const session = mock.session(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  const placed: { id: string }[] = []
  on('ui.place', (_, e) => {
    placed.push(e)
    return { value: { isPlaced: true as const, requestId: e.id } }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const text = `${DRAFT}.`
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const sent = await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: sent.text ?? text, turnId: 'submitted' })
  const reply = 'Each run goes to ⟦run log: one JSONL file per run | one SQLite database⟧ and a stay over ' +
    '⟦stuck after: 45 s | 30 s | 60 s⟧ is flagged.'
  const message = await $.ui.mount({
    plugin: 'margincue', component: 'AssistantMessage', requestId: 'reply-1', surface: 'terminal',
    props: { text: reply, isFirstOfReply: true },
  })
  expect(await message.find({ type: 'Text', text: /2 choices made for you/ })).toBeDefined()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const shown = await $.ui.mount({ plugin: 'margincue', component: 'AssistantMessage', requestId: `reply-${surface}`, surface, props: { text: reply, isFirstOfReply: true } })
    expect(await shown.find({ type: 'Text', text: /2 choices made for you/ })).toBeDefined()
    await shown.unmount()
  }
  await clock.settle()
  const band = await $.ui.mount({ ...WIDE, props: { ...WIDE.props, isWorking: true } })
  expect(await band.find({ type: 'Text', text: /The agent made 2 choices for you/ })).toBeDefined()
  expect((await band.find({ key: 'card-c4-0' }))?.props.label).toBe('● one JSONL file per run')
  // A bare digit in the empty composer switches the focused choice at once.
  expect((await composer($).edit(edit('', '2'))).text).toBe('')
  expect(session.appended()).toMatchObject([{ message: { type: 'user', content: [{ type: 'text',
    text: 'Amendment to my last prompt: for run log, use one SQLite database instead of one JSONL file per run.' }] } }])
  // alt+↓ waits for the last press before it sends.
  await band.press({ key: 'card-next' })
  await band.press({ key: 'card-cycle' })
  expect(session.appended().length).toBe(1)
  await clock.advance(1600)
  expect(session.appended().at(-1)).toMatchObject({ message: { content: [{ text: 'Amendment to my last prompt: for stuck after, use 30 s instead of 45 s.' }] } })
  await $.turn.complete({ turnId: 'submitted', reason: 'answer', answer: reply, durationMs: 1000, isAborted: false })
  await clock.settle()
  expect(placed).toMatchObject([{ id: 'receipt-1' }])
  const receipt = await $.ui.mount({ plugin: 'margincue', component: 'Placed', requestId: 'receipt-1', surface: 'terminal', props: { id: 'receipt-1', plugin: 'margincue' } })
  expect(await receipt.find({ type: 'Text', text: /the agent chose 2/ })).toBeDefined()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const elsewhere = await $.ui.mount({ plugin: 'margincue', component: 'Placed', requestId: `receipt-${surface}`, surface, props: { id: 'receipt-1', plugin: 'margincue' } })
    expect(await elsewhere.find({ type: 'Text', text: /the agent chose 2/ })).toBeDefined()
    await elsewhere.unmount()
  }
  expect(await receipt.find({ type: 'Text', text: /was 45 s/ })).toBeDefined()
  // After the turn, switching a choice writes the follow-up prompt.
  expect(await band.find({ type: 'Text', text: /Switching one writes the follow-up/ })).toBeDefined()
  await band.press({ key: 'card-cycle' })
  await clock.settle()
  expect(box.text).toBe('Change run log: one JSONL file per run instead of one SQLite database. Keep everything else as it is.')
  await band.unmount()
  await receipt.unmount()
  await message.unmount()
})

test('the receipt opens the focused choice’s diff only when asked', async ($, on) => {
  const commands: string[] = []
  const toasts: string[] = []
  const { clock, calls, files, panes } = world(on, '[]', { env: { TERM_PROGRAM: 'cursor' }, git: (argv) => {
    commands.push(argv)
    if (argv === 'mktemp -d') return '/receipt-diff\n'
    if (argv.startsWith('cursor --diff ')) return ''
    return undefined
  } })
  mock.session(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true, requestId: e.id } }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.focus', { plugin: '*' }, () => ({}))
  on('tool.run', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: '/project/report.jsonl',
    content: 'report format = jsonl\n', originalFile: null, structuredPatch: [], userModified: false } }))

  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: DRAFT, turnId: 'edits' })
  const answer = 'I chose ⟦orientation: horizontal | vertical⟧ and ⟦export format: JSONL | CSV⟧.'
  await $.session.append({ door: 'response', uuid: 'marked', origin: { kind: 'model', model: 'current' },
    message: { type: 'assistant', content: [{ type: 'text', text: answer }] } })
  await $.tool.run({ tool: 'Write', tool_use_id: 'write-report', file_path: '/project/report.jsonl', content: 'report format = jsonl\n' })
  await $.turn.complete({ turnId: 'edits', reason: 'answer', answer, durationMs: 1000, isAborted: false })
  await clock.settle()

  const receipt = await $.ui.mount({ plugin: 'margincue', component: 'Placed', requestId: 'receipt-1', surface: 'terminal',
    props: { id: 'receipt-1', plugin: 'margincue' } })
  expect(await receipt.find({ type: 'Text', text: /e opens related edits/ })).toBeDefined()
  expect(await receipt.find({ key: 'receipt-diff-0' })).toBeDefined()
  expect(await receipt.find({ key: 'receipt-diff-1' })).toBeDefined()
  await receipt.press({ key: 'receipt-review' })
  expect(panes.at(-1)).toMatchObject({ id: 'margincue-receipt', focus: true })
  expect(commands).not.toContain('mktemp -d')
  expect(calls).toHaveLength(0)

  const pane = await $.ui.mount({ plugin: 'margincue', component: 'Pane', requestId: 'margincue-receipt', surface: 'terminal',
    props: { title: 'MarginCue receipt', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 8 }, view: {} } })
  expect((await pane.find({ key: 'receipt-open-diff' }))?.props.hotkey).toBe('e')
  await $.ui.focus({ component: 'Pane', requestId: 'margincue-receipt', plugin: 'margincue', element: 'receipt-choice-1', origin: { kind: 'person' } })
  await pane.press({ key: 'receipt-open-diff' })
  await clock.settle()
  expect(calls).toHaveLength(0)
  expect(commands.filter((line) => line.startsWith('cursor '))).toEqual([
    'cursor --diff /receipt-diff/before/report.jsonl /receipt-diff/after/report.jsonl',
  ])
  expect(files.get('/receipt-diff/before/report.jsonl')).toBe('')
  expect(files.get('/receipt-diff/after/report.jsonl')).toBe('report format = jsonl\n')
  await receipt.press({ key: 'receipt-diff-0' })
  await clock.settle()
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0]!)).toMatchObject({ choice: 'orientation horizontal',
    hunks: [{ path: 'report.jsonl', changes: '+report format = jsonl' }] })
  expect(toasts).toContain('No related edits found for this choice.')
  await pane.unmount()
  await receipt.unmount()
})

function textFrame(node: RenderNode): string {
  if (typeof node === 'string') return node
  const children = ('children' in node ? node.children ?? [] : []).map(textFrame)
  if (node.type === 'Button') return `[${children.join('') || node.props.label}]`
  if (node.type !== 'Box') return children.join('')
  return node.props?.flexDirection === 'row' ? children.join(' '.repeat(Number(node.props.columnGap ?? 0)))
    : children.join('\n'.repeat(1 + Number(node.props?.rowGap ?? 0)))
}

test('the terminal receipt folds low choices and session choices can switch an older turn', async ($, on) => {
  const { clock, box, calls, panes } = world(on, '[]')
  mock.session(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true, requestId: e.id } }))
  on('tool.run', { tool: 'Write' }, () => ({ result: { type: 'update', filePath: '/project/tsconfig.json',
    content: '{"compilerOptions":{}}\n', originalFile: '{}\n', structuredPatch: [], userModified: false } }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  expect((await command('choices')).text).toBe('No agent choices to review.')
  const layout = '⟦layout: compact | roomy⟧'
  const first = `${layout}. In tsconfig.json use ⟦build settings: compiler default | strict settings⟧.`
  const answers = [
    `${first} ⟦delivery: email customers | draft an email⟧. ⟦heading: Results | Report⟧. ⟦color: blue | gray⟧.`,
    '⟦rollout: run a schema migration | add a compatibility layer⟧.',
    `${layout}. ⟦order: newest first | oldest first⟧.`,
  ]
  for (const [i, answer] of answers.entries()) {
    const turnId = `audit-${i}`
    await $.turn.start({ text: DRAFT, turnId })
    if (i === 0) {
      await $.session.append({ door: 'response', uuid: 'build-settings', origin: { kind: 'model', model: 'current' },
        message: { type: 'assistant', content: [{ type: 'text', text: first }] } })
      await $.tool.run({ tool: 'Write', tool_use_id: 'build-config', file_path: '/project/tsconfig.json', content: '{"compilerOptions":{}}\n' })
    }
    await $.turn.complete({ turnId, reason: 'answer', answer, durationMs: 1000, isAborted: false })
    await clock.settle()
  }
  const receipt = await $.ui.mount({ plugin: 'margincue', component: 'Placed', requestId: 'receipt-1', surface: 'terminal',
    props: { id: 'receipt-1', plugin: 'margincue' } })
  expect(textFrame(await receipt.drawn())).toBe([
    '   MarginCue   you set 0 · the agent chose 5',
    '               1 high · 1 mid · 3 low',
    '         high  delivery  email customers   [diff]  [→ draft an email]',
    '          mid  build settings  compiler default   [diff]  [→ strict settings]',
    '               [Show 3 low choices]',
    '               [Review choices] · e opens related edits',
    '               [Session choices]',
  ].join('\n'))
  expect(await receipt.find({ key: 'agent-0-1' })).toBeUndefined()
  await receipt.press({ key: 'receipt-low' })
  expect(await receipt.find({ key: 'agent-0-1' })).toBeDefined()
  await receipt.press({ key: 'agent-0-1' })
  expect(box.text).toBe('Revisit turn 1. Change layout: roomy instead of compact. Keep everything else as it is.')
  await receipt.press({ key: 'receipt-low' })
  expect(await receipt.find({ key: 'agent-0-1' })).toBeUndefined()

  await receipt.press({ key: 'receipt-session' })
  expect(panes.at(-1)).toMatchObject({ id: 'margincue-choices', focus: true })
  const paneCount = panes.length
  expect((await command('choices')).text).toBe('')
  expect(panes).toHaveLength(paneCount + 1)
  expect(panes.at(-1)).toMatchObject({ id: 'margincue-choices', focus: true })
  const pane = await $.ui.mount({ plugin: 'margincue', component: 'Pane', requestId: 'margincue-choices', surface: 'terminal',
    props: { title: 'MarginCue session choices', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 18 }, view: {} } })
  expect(textFrame(await pane.drawn())).toBe([
    'HIGH · 2',
    'Turn 2 · rollout: run a schema migration',
    '[→ add a compatibility layer]',
    'Turn 1 · delivery: email customers',
    '[→ draft an email]  [diff]',
    '',
    'MID · 1',
    'Turn 1 · build settings: compiler default',
    '[→ strict settings]  [diff]',
    '',
    'LOW · 5',
    'Turn 3 · layout: compact',
    '[→ roomy]',
    'Turn 3 · order: newest first',
    '[→ oldest first]',
    'Turn 1 · layout: compact',
    '[→ roomy]  [diff]',
    'Turn 1 · heading: Results',
    '[→ Report]  [diff]',
    'Turn 1 · color: blue',
    '[→ gray]  [diff]',
  ].join('\n'))
  box.text = 'My next draft'
  await pane.press({ key: 'switch-1-0-1' })
  expect(box.text).toBe('My next draft')
  box.text = ''
  await pane.press({ key: 'switch-1-0-1' })
  expect(box.text).toBe('Revisit turn 1. Change layout: roomy instead of compact. Keep everything else as it is.')
  expect(calls).toHaveLength(0)
  await pane.unmount()
  await receipt.unmount()
})

const MARKED_EXPORT = [
  '- Export delivery: ⟦delivery: streamed server download endpoint | background job with emailed file | client-side from loaded rows⟧',
  '- Format: ⟦format: CSV | JSON⟧',
  '- Rows: ⟦rows: filtered rows | all rows⟧',
  '- Encoding: ⟦encoding: UTF-8 | UTF-16⟧',
  '- Filename: ⟦filename: report.csv |',
]
const DISPLAYED_EXPORT = '- Export delivery: **streamed server download endpoint**\n- Format: **CSV**\n' +
  '- Rows: **filtered rows**\n- Encoding: **UTF-8**\n- Filename: '

test('growing AssistantMessage props hide partial marks and render four live choices', async ($, on) => {
  const { clock } = world(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AssistantMessage', surface: 'terminal' }, ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text} />
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: DRAFT, turnId: 'export' })
  const message = await $.ui.mount({
    plugin: 'margincue', component: 'AssistantMessage', requestId: 'export-reply', surface: 'terminal',
    props: { text: '', isFirstOfReply: true },
  })
  const answer = MARKED_EXPORT.join('\n')
  let text = ''
  for (const token of answer.match(/⟦|⟧|\s+|[^⟦⟧\s]+/gu)!) {
    text += token
    await message.redraw({ text, isFirstOfReply: true })
    const drawn = (await message.find({ type: 'Markdown' }))?.props.text
    expect(drawn).toBeDefined()
    expect(drawn).not.toMatch(/[⟦⟧]/u)
    expect(drawn).not.toContain('background job with emailed file')
  }
  expect((await message.find({ type: 'Markdown' }))?.props.text).toBe(DISPLAYED_EXPORT)
  expect(await message.find({ type: 'Text', text: /4 choices made for you/ })).toBeDefined()
  await clock.settle()
  const band = await $.ui.mount({ ...WIDE, props: { ...WIDE.props, isWorking: true } })
  expect(await band.find({ type: 'Text', text: /The agent made 4 choices for you/ })).toBeDefined()
  await $.turn.complete({ turnId: 'export', reason: 'answer', answer, durationMs: 1000, isAborted: false })
  await message.redraw({ text: answer, isFirstOfReply: true })
  expect((await message.find({ type: 'Markdown' }))?.props.text).toBe(DISPLAYED_EXPORT)
  await band.unmount()
  await message.unmount()
})

test('MessageDisplay formats terminal batches and registers choices before the transcript row', async ($, on) => {
  const { clock } = world(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.MessageDisplay', (_, e) => ({ displayContent: e.delta }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: DRAFT, turnId: 'export' })

  let index = 0
  const show = async (delta: string, final = false) => (await $.classic.MessageDisplay({
    turn_id: 'export', message_id: 'export-reply', index: index++, delta, final,
  })).displayContent ?? delta
  const code = '⟦literal: example | alternative⟧\n'
  expect(await show('```text\n')).toBe('```text\n')
  expect(await show(code)).toBe(code)
  expect(await show('```\n')).toBe('```\n')

  let visible = ''
  for (const line of MARKED_EXPORT.slice(0, 4)) {
    visible += await show(`${line}\n`)
    expect(visible).not.toMatch(/[⟦⟧]/u)
  }
  await clock.settle()
  const band = await $.ui.mount({ ...WIDE, props: { ...WIDE.props, isWorking: true } })
  expect(await band.find({ type: 'Text', text: /The agent made 4 choices for you/ })).toBeDefined()
  visible += await show(MARKED_EXPORT[4]!, true)
  expect(visible).toBe(`${DISPLAYED_EXPORT}\n\n**◆ 4 choices made for you** · alt↑ alt↓ to switch one`)
  await band.unmount()
})

test('A/B logs a sticky session assignment and reads totals for each arm', async ($, on) => {
  const { clock, calls, files, store, home, identity } = world(on, replies())
  const start = () => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  await start()
  expect((await command('ab on')).text).toContain('new sessions')
  expect(store.get('settings')).toMatchObject({ ab: true, sheet: true })

  identity.id = 'first-trial'
  await start()
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  const status = await command('ab status')
  const arm = status.text?.includes('in the sheet arm') ? 'sheet' : 'control'
  expect(status.text).toContain(`in the ${arm} arm`)
  expect(calls.length).toBe(arm === 'sheet' ? 2 : 0)
  if (arm === 'sheet') await ui.press({ key: 'card-cycle' })
  await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  expect((await command('ab status')).text).toContain('1 prompts sent')
  const [path] = [...files.keys()].filter((file) => file.startsWith(`${home}/.margincue/ab/`))
  const log = files.get(path!)!
  expect(log).not.toContain(identity.id)
  expect(log).not.toContain(DRAFT)
  expect(log).not.toContain('filtered rows')
  const rows = log.trim().split('\n').map((line) => JSON.parse(line))
  expect(rows[0]).toMatchObject({ event: 'session-arm', arm })
  expect(rows.at(-1)).toMatchObject({ event: 'card-submitted', arm, picked: arm === 'sheet' ? 1 : 0 })
  await start()
  expect((await command('ab status')).text).toContain(`${arm}: 1 sessions`)
  expect((await command('ab off')).text).toContain('off')
  expect((await command('ab status')).text).toContain(`${arm}: 1 sessions`)
  await ui.unmount()
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

test('first-touch guard is local, saves the selected project option, and repeats as a mark', async ($, on) => {
  const { clock, calls, files, writes, store } = world(on)
  store.set('settings', { sheet: false })
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

test('on-demand review without chapter notes still offers a persistent checklist pick', async ($, on) => {
  let waitForReply: () => Promise<void>
  const { clock, calls, files, store } = world(on, async () => {
    await waitForReply()
    return 'catalog | Delete | cleanup_reach\n'
  })
  waitForReply = () => clock.sleep(550)
  store.set('settings', { mode: 'quiet', sheet: false })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const draft = 'Delete the obsolete log files and keep the current reports.'
  await composer($).edit(edit(draft.slice(0, -1), '.'))
  const command = await $.command.run({ ...cli, command: 'margincue', args: 'review' })
  expect(command.text).toContain('general')
  expect(calls[0]).toContain('Candidate catalog:')
  expect(calls[0]).toContain('cleanup_reach')
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
  expect(await pane.find({ key: 'cleanup_reach-unused_only' })).toBeDefined()
  await pane.press({ key: 'cleanup_reach-unused_only' })
  expect(JSON.parse(files.get(PROJECT_DECISIONS)!).decisions).toMatchObject([{ slot: 'cleanup_reach', option: 'unused_only' }])
  const sent = await $.prompt.submit({ ...cli, text: draft, wait: false })
  expect(sent.text).toContain('Deletion targets unreferenced matches only.')
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

test('the former auto setting is ignored and the review command works on demand', async ($, on) => {
  const { clock, calls, store } = world(on, async (prompt) => prompt.includes('Review profile: product')
    ? 'Randomize by {} | account | workspace'
    : CARD)
  const command = (args: string) => $.command.run({ ...cli, command: 'margincue', args })
  store.set('settings', { profile: 'product', sketch: false, review: 'auto' })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit('Plan an A/B test for the checkout redesign', '.'))
  await clock.settle()
  expect(calls.length).toBe(1)
  for (const arg of ['auto', 'off']) {
    expect((await command(`review ${arg}`)).text).toContain('Automatic review is unavailable. Use /margincue review')
  }
  expect(calls.length).toBe(1)
  await command('depth essentials')
  expect(Object.hasOwn(store.get('settings') as object, 'review')).toBe(false)
  expect((await command('review product')).text).toContain('Reviewing the draft against product')
  await clock.settle()
  const reviews = calls.filter((prompt) => prompt.includes('Review profile: product'))
  expect(reviews.length).toBe(1)
  expect(reviews[0]).toContain('Level: essentials')
  expect(reviews[0]).not.toContain('Profile chapters')
})

// ---- the reading call failing: offline, rate-limited, signed out, a model the account lacks, too slow ----------

const FAILED = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const FAILURES = {
  offline: { isAnswered: false as const, reason: 'api-error' as const, status: null, error: 'unknown' as const, usage: FAILED },
  'rate-limited': { isAnswered: false as const, reason: 'api-error' as const, status: 429, error: 'rate_limit' as const, usage: FAILED },
  'signed out': { isAnswered: false as const, reason: 'api-error' as const, status: 401, error: 'authentication_failed' as const, usage: FAILED },
  'timed out': { isAnswered: false as const, reason: 'aborted' as const, usage: FAILED },
  'empty': { isAnswered: false as const, reason: 'empty-reply' as const, usage: FAILED },
}

for (const [name, failure] of Object.entries(FAILURES)) {
  test(`a reading that fails (${name}) says so quietly on the card, and Enter sends the prompt as typed`, async ($, on) => {
    const { clock } = world(on, replies(), { failure: () => failure })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await composer($).edit(edit(DRAFT, '.'))
    await clock.settle()
    const ui = await $.ui.mount(WIDE)
    expect(await ui.find({ type: 'Text', text: /no reading this time/ })).toBeDefined()
    await ui.unmount()
    const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
    expect(sent.text).toBe(`${DRAFT}.`)
    expect((await $.command.run({ ...cli, command: 'margincue', args: 'status' })).text).toMatch(/\d+ model calls, \d+ failed/)
  })
}

test('a model call the engine refuses to send (a model the account lacks) leaves the prompt as typed', async ($, on) => {
  const { clock } = world(on, replies(), { failure: () => { throw new Error('model not available') } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /no reading this time/ })).toBeDefined()
  await ui.unmount()
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.`)
})

test('a reading still on its way never holds Enter at the terminal: the prompt goes as typed', async ($, on) => {
  const { clock } = world(on, replies(), { failure: () => new Promise(() => {}) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.advance(2000)
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.`)
})

test('in the desktop app a reading that fails or never comes lets the prompt go as typed', async ($, on) => {
  let calls = 0
  const { clock } = world(on, replies(), {
    env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    failure: () => (++calls === 1 ? FAILURES['rate-limited'] : new Promise(() => {})),
  })
  heldPanel(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  const failed = $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  expect((await failed).text).toBe(`${DRAFT}.`)
  const slow = $.prompt.submit({ text: `${DRAFT} for the admins.`, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(61000)
  expect((await slow).text).toBe(`${DRAFT} for the admins.`)
})

test('/margincue status gives the readings\' median times once a card has been read', async ($, on) => {
  const { clock } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const status = async () => (await $.command.run({ ...cli, command: 'margincue', args: 'status' })).text
  expect(await status()).toContain('median first – · median reply –')
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  expect(await status()).toMatch(/model calls, 0 failed · median first \d+ ms · median reply \d+ ms/)
  // Neither git nor ripgrep found a project here: the status says so rather than "ready".
  expect(await status()).toContain('Project index: none')
})

// ---- the first-run questions: skippable, never in the way of typing ----------------------------------------------

test('the first-run questions come once on an empty prompt; closing them skips them for good and the card still works', async ($, on) => {
  const { clock, store, calls } = world(on, replies())
  on('ui.toast', () => ({ value: undefined }))
  const asked = panel(on, () => null)
  store.set('settings', { onboarded: null })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(asked.map((question) => question.header)).toEqual(['Your work'])
  expect(store.get('settings')).toMatchObject({ onboarded: 'skipped' })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  expect(calls.length).toBeGreaterThan(0)
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toContain(`${DRAFT}.${OPEN_CHOICES}`)
  // The next session does not ask again.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(asked.length).toBe(1)
})

test('someone who starts typing at once is never interrupted by the first-run questions', async ($, on) => {
  const { clock, store } = world(on, replies())
  const asked = panel(on, (question) => question.options[0]!.label)
  store.set('settings', { onboarded: null })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit('Build', ' a'))
  await clock.advance(2000)
  expect(asked.length).toBe(0)
  expect((store.get('settings') as { onboarded?: unknown } | undefined)?.onboarded ?? null).toBe(null)
})

test('Enter on each first-run question takes its first option and finishes the interview', async ($, on) => {
  const { clock, store } = world(on, replies())
  on('ui.toast', () => ({ value: undefined }))
  const asked = panel(on, (question) => question.options[0]!.label)
  store.set('settings', { onboarded: null })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(asked.map((question) => question.header)).toEqual(['Your work', 'Agent use', 'Product', 'You decide'])
  expect(store.get('settings')).toMatchObject({
    onboarded: 'done', user: { work: ['apps'], levels: { general: 'learning', product: 'learning' }, decide: ['scope'] },
  })
})

const TWIN_LAYOUTS = ['app/layout.tsx', 'app/(dashboard)/layout.tsx', 'lib/utils.ts']
const FOOTER = 'Add a footer with the copyright year to `layout.tsx`.'

test('a name the code has in several files reads as a choice of file on the card; the pick goes as a decision', async ($, on) => {
  const { clock } = world(on, replies(), {
    env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    git: (args) => args.includes('ls-files') ? TWIN_LAYOUTS.join('\n') : '',
  })
  const gate = heldPanel(on)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await clock.settle()
  const pending = $.prompt.submit({ text: FOOTER, origin: { kind: 'composer' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...DIALOG, props: { tool: 'AskUserQuestion', questions: gate.asked } })
  expect(await ui.find({ type: 'Text', text: /^“layout\.tsx” is in 2 files$/ })).toBeDefined()
  const chip = async () => (await ui.find({ key: 'card-c1' }))?.props as ChipProps
  expect((await chip()).options?.map((option) => option.label)).toEqual(['Choose a match…', 'app/layout.tsx', 'app/(dashboard)/layout.tsx'])
  await pick(ui, 'c1', 1)
  expect((await chip()).label).toBe('“layout.tsx” is in')
  gate.answer('Go ahead with this plan')
  const sent = (await pending).text
  expect(sent).toContain('\n- "layout.tsx" is the one in app/(dashboard)/layout.tsx.')
  expect(sent).not.toContain('Where things are')
  await ui.unmount()
})

test('one question at a time: a name in several files is asked as which file it means', async ($, on) => {
  const { clock } = world(on, replies(), { git: (args) => args.includes('ls-files') ? TWIN_LAYOUTS.join('\n') : '' })
  const asked = panel(on, (question) => question.header === 'layout.tsx' ? 'app/layout.tsx' : null)
  on('prompt.compose', () => ({ sections: [] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  const pending = $.prompt.submit({ text: FOOTER, origin: { kind: 'sdk' }, wait: false })
  await clock.settle()
  await clock.advance(1000)
  expect(asked[0]?.question).toBe('"layout.tsx" is in 2 files. Which do you mean?')
  expect(asked[0]?.options.map((option) => option.label)).toEqual(['app/layout.tsx', 'app/(dashboard)/layout.tsx'])
  const sent = (await pending).text
  expect(sent?.startsWith(`${FOOTER}\n\nDecisions:\n- "layout.tsx" is the one in app/layout.tsx.${OPEN_CHOICES}`)).toBe(true)
  expect(sent).not.toContain('"layout.tsx" is the one in …')
})

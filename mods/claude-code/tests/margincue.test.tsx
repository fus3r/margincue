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
/** A card reply for DRAFT: two one-of rows and a number row (a slider of ten steps, 500 by default). */
const CARD = [
  'read | You want a CSV export of the dashboard data, built as a separate tool.',
  'kind | build',
  'row | export_rows | rows | one | Export {} | the filtered rows | all rows | the selected rows | @export tool',
  'row | runs_where | runs in | one | Run it {} | in the browser | from the terminal',
  'row | batch_size | batch | num | Write {} per batch | 500 | 100 | 5000 | rows',
].join('\n')
const SKETCH = ['title | Export dialog', '┌ Export ───────────┐', '│ Rows: filtered    │', '│ [ Download CSV ]  │', '└───────────────────┘'].join('\n')

/** The model as MarginCue calls it: a card reading, a sketch, or anything else. */
function replies(card = CARD, sketch = SKETCH, other = REPLY) {
  return async (_prompt: string, system: unknown) => {
    const text = typeof system === 'string' ? system : JSON.stringify(system)
    return text.includes('how the agent will read it') ? card : text.includes('Draw what the finished result') ? sketch : other
  }
}

type Engine = On

/** The composer's events, which the kit raises like any other though its `$` types do not list them. */
type Composer = {
  edit: (e: PromptEditInput) => Promise<PromptEditResult>
  change: (e: PromptChangeInput) => Promise<PromptChangeResult>
}
const composer = ($: { prompt: unknown }) => $.prompt as Composer

/** The engine beneath: a box that applies splices, a model that answers REPLY, a clock and a store. */
function world(on: Engine, reply: string | ((prompt: string, system: string) => Promise<string>) = REPLY,
  options: { git?: (args: string) => string } = {}) {
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

test('the card reads a draft, shows typed controls, and attaches only what the person sets', async ($, on) => {
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
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Export all rows.\n- Write 710 rows per batch.`)
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

test('an untouched card leaves the submitted text alone', async ($, on) => {
  const { clock } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  const sent = await $.prompt.submit({ text: `${DRAFT}.`, origin: { kind: 'composer' }, wait: false })
  expect(sent.text).toBe(`${DRAFT}.`)
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
  expect(sent.text).toBe(`${DRAFT}.\n\nDecisions:\n- Export all rows.`)
})

test('the band lays out on every surface', async ($, on) => {
  const { clock } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  // The desktop app's Code tab, VS Code and the phone draw the same card and take the same presses.
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...WIDE, surface })
    expect(await ui.find({ type: 'Text', text: /You want a CSV export/ })).toBeDefined()
    expect(await ui.find({ key: 'card-c1-0' })).toBeDefined()
    await ui.press({ key: 'card-c1-1' })
    expect((await ui.find({ key: 'card-c1-1' }))?.props.label).toBe('● all rows')
    await ui.press({ key: 'card-c1-0' })
    await ui.unmount()
  }
})

const COMPOSE = {
  model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [],
  outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [],
}

test('the choice-marking instruction goes to interactive sessions only, never to a scripted run', async ($, on) => {
  world(on, replies())
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false })
  expect((await $.prompt.compose(COMPOSE)).sections.some((section) => section.id === 'margincue:blanks')).toBe(false)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  expect((await $.prompt.compose(COMPOSE)).sections.some((section) => section.id === 'margincue:blanks')).toBe(true)
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
  expect(await ui.find({ type: 'Text', text: /3 open/ })).toBeDefined()
  expect(await ui.find({ key: 'card-c1-0' })).toBeUndefined()
  await ui.press({ key: 'card-cycle' })
  expect(await ui.find({ type: 'Text', text: /2 open/ })).toBeDefined()
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
  expect(sent.text).toBe(`${draft}.\n\nDecisions:\n- "Old Market" is South of Market (src/city/canvas.ts).\n` +
    '- Where things are: ExportTool (src/dashboard/export.ts).')
})

test('the sketch shows what done looks like and travels with the prompt once attached', async ($, on) => {
  const { clock, calls } = world(on, replies())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await composer($).edit(edit(DRAFT, '.'))
  await clock.settle()
  expect(calls.length).toBe(2)
  expect(calls[1]).toContain('Choices:\n- Export the filtered rows.')
  const ui = await $.ui.mount(WIDE)
  expect((await ui.find({ key: 'sketch-title' }))?.props.label).toBe('Export dialog')
  expect(await ui.find({ type: 'Text', text: /Download CSV/ })).toBeDefined()
  await ui.press({ key: 'sketch-pin' })
  expect((await ui.find({ key: 'sketch-pin' }))?.props.label).toBe('✓ goes with the prompt')
  await ui.unmount()
  const sent = await $.prompt.submit({ ...cli, text: `${DRAFT}.`, wait: false })
  expect(sent.text).toBe(`${DRAFT}.\n\nTarget output, as sketched (Export dialog):\n\`\`\`text\n${SKETCH.split('\n').slice(1).join('\n')}\n\`\`\``)
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
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text, turnId: 'submitted' })
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


// MarginCue for Codex: the composer's keys and text, the hooks, the session reader, and the
// model client against a fake app-server. Runs on every platform in CI.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './ts-resolve.ts'

const home = mkdtempSync(join(tmpdir(), 'margincue-home-'))
process.env['MARGINCUE_HOME'] = home
delete process.env['MARGINCUE_READER']
// The desktop hook starts a detached reader; by default it is a no-op here, so no test reaches the real Codex.
const noReader = join(home, 'no-reader.mjs')
writeFileSync(noReader, '')
process.env['MARGINCUE_ENTRY'] = noReader

const { parseKeys } = await import('../mods/codex/src/terminal')
const { Draft } = await import('../mods/codex/src/editor')
const { decisionsOf, promptHook, stopHook, receiptLine, READING_FIRST } = await import('../mods/codex/src/hooks')
const { PATHS, sessionSource, turnMessages } = await import('../mods/codex/src/store')
const { CodexModel } = await import('../mods/codex/src/model')
const { composeFollowUp } = await import('../mods/codex/src/widget-message')
const { emptyCard, readRecord, writeRecord } = await import('../mods/codex/src/card-store')
const { CardReader } = await import('../mods/codex/src/card-reader')
const { fillCard } = await import('../mods/codex/src/prefetch')
const versionModule = await import('../mods/codex/src/version')
import type { CardOutput } from '../mods/codex/src/widget-message'
import type { WidgetCard, WidgetRow } from '../mods/codex/src/widget-message'

const here = dirname(fileURLToPath(import.meta.url))
const OPEN = '⟦'
const CLOSE = '⟧'

test('keys: text, Enter and its new-line forms, the card chords, paste across reads, clicks', () => {
  const state = { paste: null as string | null }
  assert.deepEqual(parseKeys('hé', state), [{ kind: 'text', text: 'hé' }])
  assert.deepEqual(parseKeys('\r', state), [{ kind: 'enter', newline: false }])
  for (const newline of ['\n', '\x1b\r', '\x1b[13;2u']) assert.deepEqual(parseKeys(newline, state), [{ kind: 'enter', newline: true }])
  assert.deepEqual(parseKeys('\x1b[1;3A\x1b[1;3B', state).map((k) => k.kind === 'arrow' && [k.dir, k.alt]), [['up', true], ['down', true]])
  assert.deepEqual(parseKeys('\x1b\x1b[B', state), [{ kind: 'arrow', dir: 'down', alt: true, ctrl: false, shift: false }])
  assert.deepEqual(parseKeys('\x1b[1;5A', state), [{ kind: 'arrow', dir: 'up', alt: false, ctrl: true, shift: false }])
  assert.deepEqual(parseKeys('\x1b[200~line one\r\nline', state), [])
  assert.deepEqual(parseKeys(' two\x1b[201~x', state), [{ kind: 'paste', text: 'line one\nline two' }, { kind: 'text', text: 'x' }])
  assert.deepEqual(parseKeys('\x1b[<0;12;3M\x1b[<0;12;3m', state), [{ kind: 'click', x: 11, y: 2 }])
  assert.deepEqual(parseKeys('\x1b[99;5u\x03\x1b', state), [{ kind: 'ctrl', key: 'c' }, { kind: 'ctrl', key: 'c' }, { kind: 'escape' }])
  assert.deepEqual(parseKeys('\x7f\x17\x1b[3~', state).map((k) => k.kind), ['backspace', 'backspace', 'delete'])
})

test('the draft edits like a prompt box and wraps by words, keeping the cursor', () => {
  const draft = new Draft('Build a report')
  draft.insert(' page')
  assert.equal(draft.text, 'Build a report page')
  draft.backspace(true)
  assert.equal(draft.text, 'Build a report ')
  draft.insert('for owners\nwith CSV')
  const layout = draft.layout(12)
  assert.deepEqual(layout.rows.map((row) => draft.text.slice(row.start, row.end)), ['Build a ', 'report for ', 'owners', 'with CSV'])
  assert.deepEqual([layout.cursorRow, layout.cursorCol], [3, 8])
  assert.equal(draft.vertical('up', 12), true)
  assert.equal(draft.layout(12).cursorRow, 2)
  // Home goes to the start of the line as written, as in Claude Code's prompt, not of the wrapped row.
  draft.home()
  assert.equal(draft.cursor, 0)
  assert.deepEqual(draft.killLine(false), { start: 0, end: 'Build a report for owners'.length, text: '' })
  assert.equal(draft.text, '\nwith CSV')
})

function rollout(turn: string, messages: string[], originator = 'codex-tui'): string {
  const file = join(home, `rollout-${turn}.jsonl`)
  const lines = [
    { type: 'session_meta', payload: { originator, source: originator === 'codex-tui' ? 'cli' : 'vscode' } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'earlier', item: { type: 'AgentMessage', content: [{ type: 'Text', text: `${OPEN}old: a | b${CLOSE}` }] } } },
    ...messages.map((text) => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } } })),
  ]
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return file
}

test('the session reader takes one turn\'s messages and tells the desktop app from the CLI', () => {
  const file = rollout('t-1', ['first', 'second'])
  assert.deepEqual(turnMessages(file, 't-1'), ['first', 'second'])
  assert.equal(sessionSource(file), 'cli')
  assert.equal(sessionSource(rollout('t-2', [], 'Codex Desktop')), 'app')
  assert.deepEqual(turnMessages(join(home, 'missing.jsonl'), 't-1'), [])
})

test('the prompt hook notes the turn and asks the agent to mark its choices; the stop hook writes the receipt', () => {
  const prompt = 'Build the report.\n\nDecisions:\n- Export all rows.\n- Write 710 rows per batch.'
  assert.deepEqual(decisionsOf(prompt), ['Export all rows.', 'Write 710 rows per batch.'])
  const transcript = rollout('t-3', [`Weeks start ${OPEN}week starts: Monday | Sunday${CLOSE}.`])
  const out = promptHook({ session_id: 's', turn_id: 't-3', transcript_path: transcript, cwd: '/project', prompt }) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(out.hookSpecificOutput.additionalContext, /Amendment to my last prompt/)
  const record = JSON.parse(readFileSync(PATHS.turn, 'utf8'))
  assert.deepEqual([record.turn, record.endedAt, record.decisions.length, record.source], ['t-3', null, 2, 'cli'])
  const stopped = stopHook({ turn_id: 't-3', transcript_path: transcript, last_assistant_message: `Done; CSV is ${OPEN}CSV built: streamed | in the browser${CLOSE}.` }) as { systemMessage: string }
  // Labels are kept in lower case, as on the Claude Code card.
  assert.equal(stopped.systemMessage, receiptLine(2, ['week starts: Monday', 'csv built: streamed']))
  assert.match(stopped.systemMessage, /you set 2 · the agent chose 2/)
  assert.notEqual(JSON.parse(readFileSync(PATHS.turn, 'utf8')).endedAt, null)
})

test('a message sent into the running turn keeps its decisions, and the receipt shows a choice switched there', () => {
  const prompt = 'Build the report.\n\nDecisions:\n- Export all rows.\n- Write 710 rows per batch.'
  const transcript = rollout('t-20', [`Older entries show ${OPEN}older invitations: recipient unavailable | event label only${CLOSE}; weeks start ${OPEN}week starts: Monday | Sunday${CLOSE}.`])
  promptHook({ session_id: 's', turn_id: 't-20', transcript_path: transcript, cwd: '/project', prompt })
  const started = JSON.parse(readFileSync(PATHS.turn, 'utf8')).startedAt
  const amendment = 'Amendment to my last prompt: for older invitations, use event label only instead of recipient unavailable.'
  appendFileSync(transcript, `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't-20',
    item: { type: 'UserMessage', content: [{ type: 'text', text: amendment }] } } })}\n`)
  promptHook({ session_id: 's', turn_id: 't-20', transcript_path: transcript, cwd: '/project', prompt: amendment })
  const record = JSON.parse(readFileSync(PATHS.turn, 'utf8'))
  assert.deepEqual([record.decisions.length, record.startedAt, record.endedAt], [2, started, null])
  const stopped = stopHook({ session_id: 's', turn_id: 't-20', transcript_path: transcript }) as { systemMessage: string }
  assert.equal(stopped.systemMessage, receiptLine(2, ['older invitations: event label only (switched)', 'week starts: Monday'], 'cli', 1))
  assert.match(stopped.systemMessage, /^MarginCue · you set 2 · the agent chose 2 · you switched 1 — older invitations: event label only \(switched\) · /)
  // A new turn starts afresh.
  promptHook({ session_id: 's', turn_id: 't-21', transcript_path: transcript, cwd: '/project', prompt: 'Now add a chart.' })
  assert.equal(JSON.parse(readFileSync(PATHS.turn, 'utf8')).decisions.length, 0)
  // Under margincue-relay the receipt points to the card under the prompt.
  process.env['MARGINCUE_CARD'] = 'prompt'
  try {
    assert.match(receiptLine(1, ['week starts: Monday']), /— alt\+↓ under the prompt to switch one$/)
  } finally {
    delete process.env['MARGINCUE_CARD']
  }
  assert.match(receiptLine(1, ['week starts: Monday']), /— ctrl\+g to switch one$/)
})

test('MarginCue\'s own readings run through Codex too, and its hooks leave them alone', () => {
  process.env['MARGINCUE_READER'] = '1'
  try {
    assert.equal(promptHook({ turn_id: 'x', transcript_path: 'x', cwd: '/', prompt: 'hi' }), null)
    assert.equal(stopHook({ turn_id: 'x' }), null)
  } finally {
    delete process.env['MARGINCUE_READER']
  }
})

test('readings: the lightest model, the reader prompt as instructions, the reply streamed; a failed turn says so', async () => {
  const fake = [process.execPath, join(here, 'fixtures', 'fake-codex.mjs')]
  const model = new CodexModel(home, fake)
  assert.equal(await model.start(), 'gpt-6-luna')
  const pieces: string[] = []
  const reply = await model.complete('You are MarginCue.', 'Build a weekly activity report', { onDelta: (d) => pieces.push(d) })
  assert.equal(reply.ok, true)
  assert.equal(reply.ok && reply.text, 'read | You want Build a weekly activ.\nkind | build\n')
  assert.equal(pieces.length, 3)
  model.close()
  process.env['FAKE_CODEX_FAIL'] = '1'
  try {
    const failing = new CodexModel(home, fake)
    const outcome = await failing.complete('x', 'y')
    assert.deepEqual([outcome.ok, !outcome.ok && outcome.reason], [false, 'quota'])
    failing.close()
  } finally {
    delete process.env['FAKE_CODEX_FAIL']
  }
  const missing = new CodexModel(home, [join(home, 'no-such-codex')])
  const outcome = await missing.complete('x', 'y')
  assert.equal(outcome.ok, false)
  missing.close()
})

test('an app-server that stops reading fails the reading instead of crashing the card (EPIPE)', async () => {
  process.env['FAKE_CODEX_CLOSE'] = '1'
  try {
    const model = new CodexModel(home, [process.execPath, join(here, 'fixtures', 'fake-codex.mjs')])
    assert.equal(await model.start(), 'gpt-6-luna')
    await new Promise((r) => setTimeout(r, 200))
    const outcome = await model.complete('x', 'y')
    assert.equal(outcome.ok, false)
    assert.match(!outcome.ok ? outcome.reason : '', /EPIPE/)
    model.close()
  } finally {
    delete process.env['FAKE_CODEX_CLOSE']
  }
})

test('the desktop hook gates new tasks on the widget and skips its follow-ups; the CLI keeps the text card', async () => {
  const { writeJson } = await import('../mods/codex/src/store')
  const transcript = rollout('t-9', [], 'Codex Desktop')
  const prompt = 'Build a weekly activity report for team owners from the Audit Log, as a new Reports page with a CSV download.'
  const context = (out: unknown) => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  const input = { session_id: 'app-1', turn_id: 't-9', transcript_path: transcript, cwd: home, prompt }
  const gate = context(promptHook(input))
  const id = /`mcp__margincue__margincue_card` with \{"card": "([\w-]+)"\}/.exec(gate)?.[1]
  assert.ok(id, gate)
  assert.ok(gate.includes(`await tools.mcp__margincue__margincue_card({ card: "${id}" })`))
  assert.doesNotMatch(gate, /verbatim/)
  // The reading started at Enter; this test's reader does nothing, so the card ends as failed.
  const record = readRecord(id)!
  assert.deepEqual([record.prompt, record.cwd], [prompt, home])
  assert.ok(['reading', 'failed'].includes(record.state))
  assert.match(gate, /end this turn immediately, with no message, and wait/)
  assert.match(gate, /only if the MCP tool is unavailable or the call fails/)
  assert.ok(gate.includes(READING_FIRST))

  const cli = context(promptHook({ ...input, transcript_path: rollout('cli-new', []) }))
  assert.ok(cli.includes(READING_FIRST))
  assert.doesNotMatch(cli, /margincue_card/)

  writeJson(PATHS.composed, { text: prompt, at: Date.now() })
  assert.doesNotMatch(context(promptHook({ ...input, turn_id: 't-10' })), /margincue_card/)
  const followUps = [
    'Amendment to my last prompt: for week starts, use Sunday instead of Monday.',
    'Go ahead with my prompt as written.',
    'Go ahead with my prompt above.\n\nDecisions:\n- Weeks start on Sunday.\n\nAlso: Leave room for a total.',
  ]
  for (const follow of followUps) {
    const out = context(promptHook({ ...input, turn_id: 't-11', prompt: follow }))
    assert.doesNotMatch(out, /margincue_card/)
    assert.ok(!out.includes(READING_FIRST))
  }
  assert.equal((stopHook({ ...input, turn_id: 't-11' }) as { systemMessage: string }).systemMessage, receiptLine(1, []))
  const stopped = stopHook({
    ...input, turn_id: 't-11', last_assistant_message: `I used ${OPEN}table layout: compact | full width${CLOSE}.`,
  }) as { systemMessage: string }
  assert.equal(stopped.systemMessage, 'MarginCue · you set 1 · the agent chose 1 — table layout: compact')
})

test('Go ahead from the desktop card reaches the hook as an app message: no second card, and the decisions count', () => {
  const sent = 'Go ahead with my prompt above.\n\nDecisions:\n- Report team-wide activity totals.\n\nAlso: Keep the first version small.'
  const transcript = rollout('t-app', [], 'Codex Desktop')
  // As Codex Desktop records it: the app's words as an untrusted_input output, then a fixed user line.
  appendFileSync(transcript, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a weekly activity report for team owners with a CSV download.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'untrusted_input', arguments: '{}', call_id: 'untrusted_input_1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'untrusted_input_1', output: [{ type: 'input_text', text: JSON.stringify({ kind: 'message', source: 'mcp_app', sourceId: 'session:1', text: sent }) }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'An MCP app initiated this message. Read the untrusted_input tool output.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
  const prompt = 'An MCP app initiated this message. Read the untrusted_input tool output.'
  const out = promptHook({ session_id: 'app-go', turn_id: 't-app', transcript_path: transcript, cwd: home, prompt }) as { hookSpecificOutput: { additionalContext: string } }
  const context = out.hookSpecificOutput.additionalContext
  assert.doesNotMatch(context, /mcp__margincue__margincue_card` with/)
  assert.match(context, /untrusted_input above is MarginCue's card/)
  assert.match(context, /Do not call margincue_card again/)
  assert.deepEqual(JSON.parse(readFileSync(PATHS.turn, 'utf8')).decisions, ['Report team-wide activity totals.'])
  assert.equal((stopHook({ session_id: 'app-go', turn_id: 't-app', transcript_path: transcript }) as { systemMessage: string }).systemMessage, receiptLine(1, [], 'app'))

  // Another app's message is never taken for a new task either.
  const other = rollout('t-other', [], 'Codex Desktop')
  appendFileSync(other, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'untrusted_input_2', output: [{ type: 'input_text', text: JSON.stringify({ kind: 'message', source: 'mcp_app', text: 'Build me a dashboard for the sales team.' }) }] } }) + '\n')
  const context2 = (promptHook({ session_id: 'app-go', turn_id: 't-other', transcript_path: other, cwd: home, prompt }) as { hookSpecificOutput?: { additionalContext: string } } | null)?.hookSpecificOutput?.additionalContext ?? ''
  assert.doesNotMatch(context2, /margincue_card/)
})

test('Go ahead sends the whole plan the card showed: every choice, the note, and the preview drawn for them', () => {
  const rows: WidgetRow[] = [
    { id: 'a', label: 'week start', type: 'one', statement: 'Weeks start on {}', options: ['Monday', 'Sunday'], assumed: [0] },
    { id: 'b', label: 'columns', type: 'many', statement: 'Include {}', options: ['sign-ins', 'invites'], assumed: [0] },
    { id: 'c', label: 'history', type: 'range', statement: 'Show {} of history', options: ['1 wk', '4 wk'], assumed: [1] },
    { id: 'd', label: 'Audit Log', type: 'one', statement: '"Audit Log" is {}', options: ['activityLogs', 'new, to be added'], assumed: [], files: ['activity.ts'] },
  ]
  // Switched choices (an empty pick-any one too) and the ones kept as shown, in the card's order.
  const message = composeFollowUp(rows, { a: [1], b: [], d: [0] }, '  Include a total.\nUse local time.  ')
  assert.deepEqual(message.decisions, ['Weeks start on Sunday.', 'Include none of these.', 'Show 4 wk of history.', '"Audit Log" is activityLogs (activity.ts).'])
  assert.equal(message.text, 'Go ahead with my prompt above.\n\nDecisions:\n- Weeks start on Sunday.\n- Include none of these.\n- Show 4 wk of history.\n- "Audit Log" is activityLogs (activity.ts).\n\nAlso: Include a total. Use local time.')
  assert.deepEqual(decisionsOf(message.text), message.decisions)
  // Nothing switched: the plan as shown still travels; a name the code lacks has no default and stays out.
  const kept = composeFollowUp(rows, {}, '', false, { title: 'Activity report', lines: ['┌ Report ┐', '│ Mon 4  │', '└────────┘'] })
  assert.equal(kept.text, 'Go ahead with my prompt above.\n\nDecisions:\n- Weeks start on Monday.\n- Include sign-ins.\n- Show 4 wk of history.\n\n' +
    'Target output, as sketched (Activity report):\n```text\n┌ Report ┐\n│ Mon 4  │\n└────────┘\n```')
  assert.deepEqual(decisionsOf(kept.text), kept.decisions)
  assert.deepEqual(composeFollowUp(rows, { a: [1] }, 'Ignore this.', true), {
    text: 'Go ahead with my prompt as written.', decisions: [], extra: '',
  })
  assert.equal(composeFollowUp([], {}, '  ').text, 'Go ahead with my prompt as written.')
  assert.equal(composeFollowUp([], {}, 'Use local time.').text, 'Go ahead with my prompt above.\n\nAlso: Use local time.')
})

test('the bundled MCP command resolves from the plugin directory and initializes', async () => {
  const plugin = join(here, '..', 'mods', 'codex')
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'))
  const { mcpServers: { margincue: config } } = JSON.parse(readFileSync(join(plugin, manifest.mcpServers), 'utf8'))
  assert.equal(config.command, 'node')
  assert.ok(config.env_vars.includes('CODEX_APP_RUNTIME_CLI_PATH'))
  const child = spawn(process.execPath, config.args, { cwd: join(plugin, config.cwd) })
  const output: Buffer[] = []
  child.stdout.on('data', (part: Buffer) => output.push(part))
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`)
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  const response = JSON.parse(Buffer.concat(output).toString('utf8'))
  assert.deepEqual(response.result.capabilities, { tools: {}, resources: {} })
  assert.equal(response.result.protocolVersion, '2025-11-25')
})

test('the bundled MCP server uses the Desktop runtime to read a grounded card and draw its current choices', { timeout: 15000 }, async () => {
  const plugin = join(here, '..', 'mods', 'codex')
  const project = mkdtempSync(join(tmpdir(), 'margincue-project-'))
  writeFileSync(join(project, 'activity.ts'), 'export const activityLogs = []\n')
  const fake = join(here, 'fixtures', 'fake-codex.mjs')
  // Node acts as the bundled CLI, loading this file when the reader passes "app-server".
  writeFileSync(join(project, 'app-server'), `void import(${JSON.stringify(pathToFileURL(fake).href)})\n`)
  const child = spawn(process.execPath, ['dist/margincue.mjs', 'mcp'], {
    cwd: plugin,
    env: {
      ...process.env,
      CODEX_HOME: home,
      CODEX_CLI_PATH: '',
      MARGINCUE_CODEX: '',
      CODEX_APP_RUNTIME_CLI_PATH: process.execPath,
      FAKE_CODEX_PROJECT: project,
    },
  })
  const closed = once(child, 'close')
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (data: string) => { errors += data })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]()
  let sequence = 0
  async function call(method: string, params: object = {}) {
    const id = ++sequence
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const next = await lines.next()
    assert.ok(!next.done, errors)
    const response = JSON.parse(next.value)
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.id, id)
    assert.ok(!response.error, JSON.stringify(response.error))
    return response.result
  }
  try {
    assert.equal((await call('initialize', { protocolVersion: '2025-06-18' })).protocolVersion, '2025-06-18')
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    const uri = 'ui://margincue/card.html'
    const list = await call('tools/list')
    assert.deepEqual(list.tools.map((tool: { name: string }) => tool.name), ['margincue_card', 'margincue_read', 'margincue_sketch'])
    assert.deepEqual(list.tools[0]._meta, { ui: { resourceUri: uri }, 'openai/outputTemplate': uri })
    assert.deepEqual([list.tools[1]._meta.ui.visibility, list.tools[2]._meta.ui.visibility], [['app'], ['app']])

    // Without a card id from the hook, the server reads the card itself; either way the card opens at once.
    const prompt = 'Build a weekly report for team owners from the Audit Log page.\nAdd a CSV download.  '
    const result = await call('tools/call', { name: 'margincue_card', arguments: { prompt, cwd: project } })
    assert.equal(result._meta['openai/outputTemplate'], uri)
    assert.match(result.content[0].text, /End your turn now/)
    const opened = result.structuredContent as CardOutput
    assert.deepEqual([opened.prompt, opened.state, opened.reading, opened.rows], [prompt, 'reading', null, []])
    const follow = async (id: string, after = 0) => {
      let out: CardOutput
      do {
        out = (await call('tools/call', { name: 'margincue_read', arguments: { card: id, after } })).structuredContent
        after = out.version!
      } while (out.state === 'reading' || out.sketchState === 'drawing')
      return out
    }
    const card = await follow(opened.id, opened.version)
    assert.equal(card.id, opened.id)
    assert.equal(card.state, 'done')
    assert.equal(card.reading, 'A weekly activity report with CSV export.')
    assert.deepEqual(card.rows.map((row) => row.type), ['one', 'one', 'many', 'range'])
    const week = card.rows.find((row) => row.label === 'week starts')!
    assert.deepEqual([week.options, week.assumed], [['Monday', 'Sunday'], [0]])
    assert.deepEqual(card.missing, [{ phrase: 'Audit Log', candidates: [{ name: 'activityLogs', file: 'activity.ts' }], rowId: card.rows[0]!.id }])
    assert.equal(card.preview, true)
    // The first preview comes with the card, drawn with Codex's own choices.
    assert.equal(card.sketchState, 'done')
    assert.ok(card.sketch!.lines.includes('- Weeks start on Monday.'))

    const sketch = (picks: object) => call('tools/call', { name: 'margincue_sketch', arguments: { cardId: card.id, picks } })
    assert.deepEqual((await sketch({})).structuredContent.sketch, card.sketch)
    const updated = await sketch({ [week.id]: [1] })
    assert.equal(updated.structuredContent.sketch.title, 'Activity report')
    assert.ok(updated.structuredContent.sketch.lines.includes('- Weeks start on Sunday.'))
    assert.equal((await sketch({ [week.id]: [10] })).isError, true)

    const brief = await call('tools/call', { name: 'margincue_card', arguments: { prompt: 'Build an app', cwd: project } })
    assert.ok((await follow(brief.structuredContent.id)).reading)

    // A card the hook started is opened by its id alone.
    writeRecord({
      id: 'hook-card-1', prompt, cwd: project, at: Date.now(), version: 4, state: 'done',
      card: { ...emptyCard('hook-card-1', prompt), reading: 'Read at Enter.' }, sketchState: 'none', sketch: null, names: [],
    })
    const byId = (await call('tools/call', { name: 'margincue_card', arguments: { card: 'hook-card-1' } })).structuredContent
    assert.deepEqual([byId.id, byId.state, byId.reading, byId.version], ['hook-card-1', 'done', 'Read at Enter.', 4])
    assert.equal((await call('tools/call', { name: 'margincue_card', arguments: { card: 'no-such-card' } })).isError, true)
    assert.equal((await call('tools/call', { name: 'margincue_read', arguments: { card: 'no-such-card' } })).isError, true)

    assert.equal((await call('resources/list')).resources[0].uri, uri)
    const [resource] = (await call('resources/read', { uri })).contents
    assert.equal(resource.uri, uri)
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app')
    assert.match(resource.text, /<script>[\s\S]*ui\/initialize[\s\S]*<\/script>/)
    assert.match(resource.text, /Go ahead with my prompt as written/)
    assert.doesNotMatch(resource.text, /<script[^>]+src=|<link[^>]+href=/)
  } finally {
    child.stdin.end()
    const [code] = await closed
    assert.equal(code, 0, errors)
  }
})

test('a desktop card streams in: its reading first, then each choice, then its first preview', { timeout: 15000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'margincue-project-'))
  process.env['FAKE_CODEX_PROJECT'] = project
  process.env['FAKE_CODEX_LINES'] = '1'
  const reader = new CardReader([process.execPath, join(here, 'fixtures', 'fake-codex.mjs')])
  try {
    const seen: CardOutput[] = []
    const source = await reader.read('card-a', 'Build a weekly report with a CSV download.', project, (card) => seen.push(card))
    assert.deepEqual(seen.map((card) => [Boolean(card.reading), card.rows.length]), [[true, 0], [true, 0], [true, 1], [true, 2], [true, 3]])
    assert.equal(source!.card.rows.length, 3)

    const prompt = 'Build a weekly report with a CSV download.'
    writeRecord({ id: 'card-b', prompt, cwd: project, at: Date.now(), version: 1, state: 'reading', card: emptyCard('card-b', prompt), sketchState: 'none', sketch: null, names: [] })
    await fillCard(reader, 'card-b')
    const record = readRecord('card-b')!
    assert.deepEqual([record.state, record.sketchState, record.pid], ['done', 'done', process.pid])
    assert.equal(record.card.reading, 'A weekly activity report with CSV export.')
    assert.ok(record.sketch!.lines.includes('- Weeks start on Monday.'))
  } finally {
    reader.close()
    delete process.env['FAKE_CODEX_PROJECT']
    delete process.env['FAKE_CODEX_LINES']
  }
})

test('the desktop hook starts the reading at Enter, in a reader that outlives the hook', { timeout: 15000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'margincue-project-'))
  writeFileSync(join(project, 'app-server'), `void import(${JSON.stringify(pathToFileURL(join(here, 'fixtures', 'fake-codex.mjs')).href)})\n`)
  const saved = { ...process.env }
  Object.assign(process.env, {
    MARGINCUE_ENTRY: join(here, '..', 'mods', 'codex', 'dist', 'margincue.mjs'),
    MARGINCUE_CODEX: '', CODEX_CLI_PATH: '', CODEX_APP_RUNTIME_CLI_PATH: process.execPath, FAKE_CODEX_PROJECT: project,
  })
  try {
    const prompt = 'Build a weekly report for team owners with a CSV download.'
    const out = promptHook({ session_id: 'app-e2e', turn_id: 't-e2e', transcript_path: rollout('t-e2e', [], 'Codex Desktop'), cwd: project, prompt })
    const id = /"card": "([\w-]+)"/.exec(JSON.stringify(out).replace(/\\"/g, '"'))?.[1]
    assert.ok(id)
    let record = readRecord(id)
    for (const until = Date.now() + 12000; record && (record.state === 'reading' || record.sketchState !== 'done') && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      record = readRecord(id)
    }
    assert.deepEqual([record?.state, record?.sketchState], ['done', 'done'])
    assert.equal(record!.card.reading, 'A weekly activity report with CSV export.')
    assert.equal(record!.card.rows.length, 3)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})

test('a scripted run (codex exec) is left exactly as it would be without MarginCue', () => {
  const transcript = join(home, 'rollout-exec.jsonl')
  writeFileSync(transcript, [
    JSON.stringify({ type: 'session_meta', payload: { originator: 'codex_exec', source: 'exec' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'e-1', item: { type: 'AgentMessage', content: [{ type: 'Text', text: `${OPEN}a: b | c${CLOSE}` }] } } }),
  ].join('\n') + '\n')
  const before = readFileSync(PATHS.turn, 'utf8')
  assert.equal(promptHook({ session_id: 'x', turn_id: 'e-1', transcript_path: transcript, cwd: '/p', prompt: 'Build a report page.' }), null)
  assert.equal(readFileSync(PATHS.turn, 'utf8'), before)
  assert.equal(stopHook({ turn_id: 'e-1', transcript_path: transcript }), null)
})

test('setup stops on a Codex older than it needs, and a shell profile it cannot write costs a message, not a stack trace', { skip: process.platform === 'win32' }, () => {
  const { tooOld } = versionModule
  assert.equal(tooOld('codex-cli 0.150.0'), '0.150.0')
  assert.equal(tooOld('codex-cli 0.171.0'), null)
  assert.equal(tooOld('codex-cli 1.2.0'), null)
  assert.equal(tooOld('something else 0.1.0'), null)
  assert.equal(tooOld('A notice about 0.150.0\ncodex-cli 0.172.0'), null)
  const sandbox = mkdtempSync(join(tmpdir(), 'margincue-setup-'))
  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  // A fake Codex that only knows --version and plugin, and a relay that is already installed: no network.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli ${FAKE_VERSION:-0.172.0}"; fi\nexit 0\n', { mode: 0o755 })
  const bundle = join(here, '..', 'mods', 'codex', 'dist', 'margincue.mjs')
  const setup = (name: string, env: Record<string, string>) => {
    const home = join(sandbox, name)
    mkdirSync(join(home, '.margincue', 'bin'), { recursive: true })
    writeFileSync(join(home, '.margincue', 'bin', 'margincue-relay'), '#!/bin/sh\necho "margincue-relay 0.1.2 protocol 1"\n', { mode: 0o755 })
    const run = spawnSync(process.execPath, [bundle, 'setup'], {
      input: '\ny\n', encoding: 'utf8',
      env: { PATH: `${bin}:${process.env['PATH']}`, HOME: home, USERPROFILE: home, MARGINCUE_HOME: join(home, '.margincue'), SHELL: '/bin/bash', ...env },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /\n\s+at /)
    return { home, out: run.stdout }
  }
  assert.match(setup('old', { FAKE_VERSION: '0.150.0' }).out, /0\.150\.0 is older than 0\.171/)
  // fish with no ~/.config/fish yet: the folder is made.
  const fish = setup('fish', { SHELL: '/usr/bin/fish' })
  assert.match(readFileSync(join(fish.home, '.config', 'fish', 'config.fish'), 'utf8'), /function codex; node .* codex \$argv; end/)
  // zsh reads ZDOTDIR; a profile there that cannot be written gets the line to add by hand.
  const zdot = join(sandbox, 'zdot')
  mkdirSync(zdot)
  writeFileSync(join(zdot, '.zshrc'), '# mine\n', { mode: 0o444 })
  if (process.getuid?.() !== 0) assert.match(setup('zsh', { SHELL: '/bin/zsh', ZDOTDIR: zdot }).out, /Could not write to .*zdot.*\.zshrc/)
})

// MarginCue for Codex: the composer's keys and text, the hooks, the session reader, and the
// model client against a fake app-server. Runs on every platform in CI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './ts-resolve.ts'

const home = mkdtempSync(join(tmpdir(), 'margincue-home-'))
process.env['MARGINCUE_HOME'] = home
delete process.env['MARGINCUE_READER']

const { parseKeys } = await import('../mods/codex/src/terminal')
const { Draft } = await import('../mods/codex/src/editor')
const { decisionsOf, promptHook, stopHook, receiptLine, READING_FIRST } = await import('../mods/codex/src/hooks')
const { PATHS, sessionSource, turnMessages } = await import('../mods/codex/src/store')
const { CodexModel } = await import('../mods/codex/src/model')

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

test('without the composer (the desktop app, or Enter without ctrl+g) a new task opens with the card; with it, not', async () => {
  const { writeJson } = await import('../mods/codex/src/store')
  const transcript = rollout('t-9', [], 'Codex Desktop')
  const prompt = 'Build a weekly activity report for team owners from the Audit Log, as a new Reports page with a CSV download.'
  const context = (out: unknown) => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  assert.ok(context(promptHook({ session_id: 'app-1', turn_id: 't-9', transcript_path: transcript, cwd: '/p', prompt })).includes(READING_FIRST))
  writeJson(PATHS.composed, { text: prompt, at: Date.now() })
  assert.ok(!context(promptHook({ session_id: 'app-1', turn_id: 't-10', transcript_path: transcript, cwd: '/p', prompt })).includes(READING_FIRST))
  const follow = 'Amendment to my last prompt: for week starts, use Sunday instead of Monday.'
  assert.ok(!context(promptHook({ session_id: 'app-1', turn_id: 't-11', transcript_path: transcript, cwd: '/p', prompt: follow })).includes(READING_FIRST))
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

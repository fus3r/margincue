// MarginCue for Codex, the card under the prompt box: what it answers the relay for each draft,
// key and Enter, against an in-process reader. The relay itself (the terminal side) is tested
// in crates/margincue-relay.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import './ts-resolve.ts'

const home = mkdtempSync(join(tmpdir(), 'margincue-band-'))
process.env['MARGINCUE_HOME'] = home
delete process.env['MARGINCUE_READER']

const { Band } = await import('../mods/codex/src/band')
const { interactive } = await import('../mods/codex/src/relay')
const { PATHS } = await import('../mods/codex/src/store')
import type { Down, Reader } from '../mods/codex/src/band'

const PROMPT = 'Add a CSV export to the weekly activity report'
const CARD = [
  'read | A CSV export button on the weekly activity report.',
  'kind | build',
  'row | scope | rows exported | one | Export covers {} | all rows* | the filtered rows',
  '',
].join('\n')

function reader(): Reader {
  return {
    problem: null,
    start: async () => 'gpt-6-luna',
    async complete(system, _prompt, options) {
      const reply = system.includes('Draw what the finished result will look like') ? 'title | Report\n┌ Report ────────┐\n│ [Export CSV] │\n│ 12 rows      │\n└───────────────┘\n' : CARD
      options?.onDelta?.(reply)
      return { ok: true, text: reply, ms: 1 }
    },
    close() {},
  }
}

function harness(cwd = mkdtempSync(join(tmpdir(), 'margincue-project-'))) {
  const out: Down[] = []
  const band = new Band({ cwd, send: (message) => out.push(message), model: reader(), vocabulary: false, turnEveryMs: 20 })
  band.receive({ t: 'hello', protocol: 1, cols: 110, rows: 40, max: 9, full: true })
  const last = <T extends Down['t']>(kind: T) => out.filter((m): m is Extract<Down, { t: T }> => m.t === kind).at(-1)
  const lines = () => (last('band')?.lines ?? []).join('\n').replace(/\x1b\[[0-9;:]*m/g, '')
  const draft = (text: string | null, plain = true) => band.receive({ t: 'draft', text, approx: false, end: true, plain })
  return { band, out, last, lines, draft, cwd }
}

async function until(ready: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('the card follows the draft; once it has read the prompt, Enter takes the choices along', async () => {
  const h = harness()
  assert.match(h.lines(), /MarginCue/)
  h.draft(PROMPT)
  await until(() => h.lines().includes('CSV export button') && h.lines().includes('rows exported'))
  await until(() => h.last('claims')?.enter === true)
  assert.equal(h.last('claims')?.arrows, true)
  // The card keeps its rows while the prompt is written.
  const rows = h.last('band')!.lines.length
  assert.ok(rows > 1 && rows <= 9, `${rows} rows`)

  h.band.receive({ t: 'key', key: 'down' })
  assert.match(h.lines(), /1 set/)
  assert.equal(h.last('claims')?.enter, true)

  // At once after the switch, before the sketch is redrawn for it: the choice alone goes.
  h.band.receive({ t: 'enter', text: PROMPT, approx: false })
  const answer = h.last('enter')!
  assert.equal(answer.do, 'append')
  assert.equal(answer.text, '\n\nDecisions:\n- Export covers the filtered rows.')
  // The prompt hook knows the prompt whose card was seen.
  assert.equal(JSON.parse(readFileSync(PATHS.composed, 'utf8')).text, `${PROMPT}${answer.text}`)

  // What the box shows while the prompt goes is not a new draft.
  const before = h.out.length
  h.draft(`${PROMPT}${answer.text}`)
  assert.ok(!h.out.slice(before).some((m) => m.t === 'band' && m.lines.join('').includes('reads the prompt once you pause')))
  h.draft('')
  assert.match(h.lines(), /sent with 1 decision/)
  assert.equal(h.last('band')!.lines.length, 1)
  assert.deepEqual(h.last('claims'), { t: 'claims', enter: false, arrows: false })
  h.band.close()
})

test('Enter before the card has read the prompt lets it go as written', () => {
  const h = harness()
  h.draft(PROMPT)
  assert.equal(h.last('claims')?.enter ?? false, false)
  h.band.receive({ t: 'enter', text: PROMPT, approx: false })
  assert.deepEqual(h.last('enter'), { t: 'enter', do: 'pass' })
  assert.equal(JSON.parse(readFileSync(PATHS.composed, 'utf8')).text, PROMPT)
  h.band.close()
})

test('a card left as it was goes with the prompt as the plan, with the sketch it drew', async () => {
  const h = harness()
  h.draft(PROMPT)
  await until(() => h.lines().includes('rows exported') && h.lines().includes('[Export CSV]'))
  await until(() => h.last('claims')?.enter === true)
  h.band.receive({ t: 'enter', text: PROMPT, approx: false })
  const answer = h.last('enter')!
  assert.equal(answer.do, 'append')
  assert.match(answer.text ?? '', /^\n\nDecisions:\n- Export covers all rows\./)
  assert.match(answer.text ?? '', /\[Export CSV\]/)
  // The box goes as the card drew it: straight, though the model drew it unevenly.
  const box = (answer.text ?? '').split('\n').filter((line) => /^[┌│└]/.test(line))
  assert.equal(box.length, 4)
  assert.equal(new Set(box.map((line) => [...line].length)).size, 1, box.join('\n'))
  h.band.close()
})

test('a popup hides the box for a moment: the card stays as drawn and claims nothing', async () => {
  const h = harness()
  h.draft(PROMPT)
  await until(() => h.lines().includes('rows exported'))
  h.band.receive({ t: 'key', key: 'down' })
  const drawn = h.last('band')
  h.draft(null)
  assert.equal(h.last('band'), drawn)
  assert.deepEqual(h.last('claims'), { t: 'claims', enter: false, arrows: false })
  h.draft(`${PROMPT} in src/report.ts`)
  await until(() => h.last('claims')?.enter === true)
  h.band.close()
})

test('the agent\'s marked choices become switches whose amendment goes in the box', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'margincue-project-'))
  const transcript = join(cwd, 'rollout.jsonl')
  const text = 'I keep each run in ⟦run log: one JSONL file per run | one SQLite database⟧.'
  writeFileSync(transcript, `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T1',
    item: { type: 'AgentMessage', content: [{ text }] } } })}\n`)
  mkdirSync(join(home, 'codex'), { recursive: true })
  writeFileSync(PATHS.turn, JSON.stringify({ session: 'S', turn: 'T1', transcript, cwd, startedAt: Date.now(), endedAt: null, decisions: [], source: 'cli' }))
  const h = harness(cwd)
  h.draft('')
  await until(() => h.lines().includes('run log'))
  assert.match(h.lines(), /made 1 choice|made 1 choices|choice/)
  h.band.receive({ t: 'key', key: 'down' })
  const first = h.last('write')!
  assert.equal(first.text, 'Amendment to my last prompt: for run log, use one SQLite database instead of one JSONL file per run.')
  assert.equal(first.expect, undefined)
  // The box now holds the amendment: still the switches, and Enter is Codex's own.
  h.draft(first.text)
  assert.match(h.lines(), /run log/)
  assert.equal(h.last('claims')?.enter, false)
  h.band.receive({ t: 'key', key: 'down' })
  const back = h.last('write')!
  assert.equal(back.text, '')
  assert.equal(back.expect, first.text)
  h.band.close()
})

test('a switch sent into the turn stays the person\'s, and the next one amends from it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'margincue-project-'))
  const transcript = join(cwd, 'rollout.jsonl')
  const item = (type: string, text: string) => `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T2',
    item: { type, content: [{ text }] } } })}\n`
  writeFileSync(transcript, item('AgentMessage', 'Runs go in ⟦run log: one JSONL file per run | one SQLite database | one CSV per run⟧.'))
  mkdirSync(join(home, 'codex'), { recursive: true })
  writeFileSync(PATHS.turn, JSON.stringify({ session: 'S', turn: 'T2', transcript, cwd, startedAt: Date.now(), endedAt: null, decisions: [], source: 'cli' }))
  const h = harness(cwd)
  h.draft('')
  await until(() => h.lines().includes('run log'))
  h.band.receive({ t: 'key', key: 'down' })
  const first = h.last('write')!
  assert.equal(first.text, 'Amendment to my last prompt: for run log, use one SQLite database instead of one JSONL file per run.')
  // Enter sends it; Codex has not written it to the transcript yet.
  h.draft(first.text)
  h.draft('')
  h.band.receive({ t: 'key', key: 'down' })
  assert.equal(h.last('write')!.text, 'Amendment to my last prompt: for run log, use one CSV per run instead of one SQLite database.')
  h.band.close()

  // A card started later reads the same from the transcript alone.
  writeFileSync(transcript, item('AgentMessage', 'Runs go in ⟦run log: one JSONL file per run | one SQLite database | one CSV per run⟧.') +
    item('UserMessage', first.text))
  const fresh = harness(cwd)
  fresh.draft('')
  await until(() => fresh.lines().includes('run log'))
  fresh.band.receive({ t: 'key', key: 'down' })
  assert.equal(fresh.last('write')!.text, 'Amendment to my last prompt: for run log, use one CSV per run instead of one SQLite database.')
  fresh.band.close()
})

test('off, and hidden for one prompt', async () => {
  const h = harness()
  h.draft(PROMPT)
  await until(() => h.lines().includes('rows exported'))
  h.band.receive({ t: 'dismiss' })
  assert.match(h.lines(), /hidden for this prompt/)
  h.draft(`${PROMPT}!`)
  await until(() => h.lines().includes('rows exported'))
  h.band.receive({ t: 'toggle', on: false })
  assert.match(h.lines(), /off · ctrl\+\] t/)
  assert.deepEqual(h.last('claims'), { t: 'claims', enter: false, arrows: false })
  h.band.close()
})

test('a card hidden for the prompt (ctrl+] d) lets it go as written, even with a choice switched', async () => {
  const h = harness()
  h.draft(PROMPT)
  await until(() => h.last('claims')?.enter === true)
  h.band.receive({ t: 'key', key: 'down' })
  assert.match(h.lines(), /1 set/)
  h.band.receive({ t: 'dismiss' })
  assert.deepEqual(h.last('claims'), { t: 'claims', enter: false, arrows: false })
  // An Enter the relay asked about before it heard the claims goes as written too.
  h.band.receive({ t: 'enter', text: PROMPT, approx: false })
  assert.deepEqual(h.last('enter'), { t: 'enter', do: 'pass' })
  h.band.close()
})

test('only Codex\'s full-screen commands start under the relay, in the folder Codex opens', () => {
  const cwd = '/work/app'
  assert.equal(interactive([], cwd), cwd)
  assert.equal(interactive(['fix the flaky test'], cwd), cwd)
  assert.equal(interactive(['-m', 'gpt-6.2-sol', '-c', 'x=1', 'fix it'], cwd), cwd)
  assert.equal(interactive(['resume', '--last'], cwd), cwd)
  assert.equal(interactive(['-C', 'sub'], cwd), resolve(cwd, 'sub'))
  assert.equal(interactive(['--cd=sub'], cwd), resolve(cwd, 'sub'))
  for (const args of [['exec', 'hi'], ['e', 'hi'], ['login'], ['--help'], ['-V'], ['-s', 'read-only', 'review'], ['mcp', 'list']]) {
    assert.equal(interactive(args, cwd), null, args.join(' '))
  }
})

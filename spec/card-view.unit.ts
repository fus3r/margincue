import assert from 'node:assert/strict'
import { test } from 'node:test'
import './ts-resolve.ts'
import type { MargincueBand, MargincueCard, MargincueRow } from '../mods/claude-code/types'

const { layoutBandRows, segmentsWidth, cells, tidySketch, DARK, LIGHT, paletteFor } = await import('../mods/claude-code/hooks/band')
const { layoutReceipt, layoutSent, splitSent } = await import('../mods/claude-code/hooks/card-view')
const { parseCard, parseSketch } = await import('../mods/claude-code/core/card')

type Seg = ReturnType<typeof layoutBandRows>[number][number]

const row = (id: string, label: string, options: string[], selected: number[], extra: Partial<MargincueRow> = {}): MargincueRow => ({
  id, key: id, label, type: 'one', statement: `${label} {}`, options, defaults: [0], selected, chosen: false, origin: 'model', ...extra,
})

const SKETCH = [
  '┌ MarginCue ─────────────────────────┐',
  '│ Review: src/render.py      3 open │',
  '├────────────────────────────────────┤',
  '│ L42  Possible null deref in parse() │',
  '│      Guard the result before use.  │',
  '│ L88  Unused import os              │',
  '│ L120 Long line (131 > 100)          │',
  '├────────────────────────────────────┤',
  '│ ↑↓ move · enter open · q close    │',
  '└────────────────────────────────────┘',
]

/** The prompt of the screenshots that showed cut options, with options as long as the parser allows. */
const CARD: MargincueCard = {
  id: 1, stage: 'draft', reading: false, error: false, kind: 'change', language: 'en', collapsed: false,
  read: 'You want a design proposal for a stronger MarginCue UI that stays within what Claude Code and Codex allow, and that you verify live.',
  focus: 'r3',
  mentions: [
    { phrase: 'MarginCue', start: 0, end: 9, status: 'found', files: ['README.md'], near: [] },
    { phrase: 'Old Market', start: 10, end: 20, status: 'missing', files: [], near: [] },
  ],
  rows: [
    row('r1', 'deliver', ['a proposal with mockups', 'a written design only', 'a working redesign of the band renderer'], [2], { chosen: true }),
    row('r2', 'app limits', ['as fixed, from the apps', 'reported, then decided'], [0]),
    row('r3', 'cropped text', ['in this redesign', 'as a separate change'], [0]),
    row('r4', 'verify', ['running live in Claude Code and Codex', 'running the existing render tests', 'a scripted PTY run in a terminal harness'], [0]),
    row('r5', 'build on', ['on the existing renderer', 'as a fresh layout'], [1], { origin: 'lens' }),
    row('r6', 'which one', ['South of Market', 'Old Town'], [], { origin: 'repo', defaults: [] }),
    { ...row('r7', 'batch', ['100 rows', '200 rows', '300 rows', '500 rows', '1000 rows', '5000 rows'], [3]), type: 'range' },
    { ...row('r8', 'checks', ['unit tests', 'live capture', 'screenshots', 'accessibility labels'], [0, 1]), type: 'many', defaults: [0, 1] },
  ],
  sketch: { title: 'MarginCue panel redesign, no cropped text', lines: SKETCH, drawing: false, pinned: false, open: true },
}

const band = (card: MargincueCard): MargincueBand => ({
  enabled: true, phase: 'idle', profile: 'general', hasDraft: true, cues: [], focus: null, latencyMs: null, note: null,
  mode: 'auto', language: 'en', depth: 'research', canReview: true, card,
})

const buttons = (rows: Seg[][]) => rows.flat().filter((s): s is Extract<Seg, { kind: 'button' }> => s.kind === 'button' && !s.hidden)
const plain = (line: Seg[]) => line.map((s) => s.kind === 'text' ? s.text : s.kind === 'progress' ? `* ${s.label}` : s.hidden ? '' : s.face ?? s.label).join('')

test('the card never draws wider than the band, at any width or height', () => {
  for (const columns of [44, 60, 80, 100, 120, 140, 160, 200, 260]) {
    for (const maxRows of [6, 10, 14, 24, 60]) {
      for (const card of [CARD, { ...CARD, stage: 'turn' as const }, { ...CARD, collapsed: true }, { ...CARD, read: null, reading: true }]) {
        const rows = layoutBandRows(band(card), columns, 'ctrl+x tab', maxRows)
        for (const line of rows) assert.ok(segmentsWidth(line) <= columns, `${columns}×${maxRows} ${card.stage}: ${plain(line)}`)
      }
    }
  }
})

test('a label is wrapped onto the row\'s next lines, never cut, in every stage and at every width', () => {
  const long = 'where the sketch should be shown'
  const agentRows = [
    row('a1', 'default chip colour', ['neutral indigo-grey', 'plain grey'], [0], { origin: 'agent' }),
    row('a2', long, ['beside the rows from 140 columns', 'always under the rows'], [0], { origin: 'agent' }),
    row('a3', 'sent prompt', ['decisions listed under it', 'raw Decisions text as before'], [0], { origin: 'agent' }),
    { ...row('a4', 'stuck threshold in one zone', ['30 s', '45 s', '60 s', '90 s'], [1], { origin: 'agent' }), type: 'range' as const },
  ]
  for (const stage of ['draft', 'turn', 'after'] as const) {
    const card: MargincueCard = { ...CARD, stage, rows: agentRows, focus: 'a1', mentions: stage === 'draft' ? CARD.mentions : [],
      sketch: stage === 'draft' ? CARD.sketch : undefined }
    for (const columns of [44, 60, 80, 100, 120, 160, 200]) {
      for (const maxRows of [8, 14, 40]) {
        const rows = layoutBandRows(band(card), columns, 'ctrl+x tab', maxRows)
        for (const line of rows) assert.ok(segmentsWidth(line) <= columns, `${stage} ${columns}×${maxRows}: ${plain(line)}`)
        const text = rows.map(plain).join('\n')
        assert.ok(!/\b(?:default chip co|where the sketch sh)\S*…/.test(text), `${stage} ${columns}: a label was cut\n${text}`)
        if (maxRows === 40) {
          // Every word of every label is on screen, in order.
          for (const label of ['default chip colour', long, 'stuck threshold in one zone']) {
            const words = label.split(' ')
            let at = 0
            for (const word of words) {
              const found = text.indexOf(word, at)
              assert.ok(found >= 0, `${stage} ${columns}: "${word}" of "${label}" is missing\n${text}`)
              at = found
            }
          }
        }
      }
    }
  }
})

test('options are never cut while the terminal has room for them', () => {
  for (const columns of [100, 140, 200]) {
    const chips = buttons(layoutBandRows(band(CARD), columns, 'ctrl+x tab', 60)).filter((b) => /^card-r\d-\d$/.test(b.key))
    for (const chip of chips) assert.ok(!chip.face?.includes('…'), `${columns}: ${chip.face}`)
    // Every option of every chip row is on screen.
    for (const r of CARD.rows.filter((r) => r.type !== 'range')) {
      for (let i = 0; i < r.options.length; i++) assert.ok(chips.some((b) => b.key === `card-${r.id}-${i}`), `${columns}: ${r.id}-${i}`)
    }
  }
})

test('when rows must fold, the value each row reads with stays on screen and the focused row stays whole', () => {
  for (const columns of [44, 60, 80]) {
    for (const maxRows of [8, 12]) {
      const rows = layoutBandRows(band(CARD), columns, 'ctrl+x tab', maxRows)
      const keys = new Set(buttons(rows).map((b) => b.key))
      const focused = CARD.rows.find((r) => r.id === CARD.focus)!
      focused.options.forEach((_, i) => assert.ok(keys.has(`card-${focused.id}-${i}`), `${columns}×${maxRows} focus ${i}`))
      for (const r of CARD.rows) {
        const shown = [...keys].some((key) => key.startsWith(`card-${r.id}-`))
        if (!shown) continue // a row left out whole is counted in "+N more rows"
        for (const i of r.selected) assert.ok(keys.has(`card-${r.id}-${i}`), `${columns}×${maxRows} ${r.id} selected ${i}`)
      }
      assert.ok(rows.length <= maxRows, `${columns}×${maxRows}: ${rows.length} rows`)
    }
  }
})

test('chips keep their place when the selection moves, and colour says who set the value', () => {
  const at = (card: MargincueCard) => layoutBandRows(band(card), 160, 'ctrl+x tab', 60)
  const before = at(CARD)
  const moved = at({ ...CARD, rows: CARD.rows.map((r) => r.id === 'r2' ? { ...r, selected: [1], chosen: true } : r) })
  const line = (rows: Seg[][]) => plain(rows.find((l) => l.some((s) => s.kind === 'button' && s.key === 'card-r2-0'))!)
  assert.equal(line(before), line(moved))
  const chip = (rows: Seg[][], key: string) => buttons(rows).find((b) => b.key === key)!
  assert.deepEqual(chip(before, 'card-r2-0').style, DARK.suggested)
  assert.deepEqual(chip(moved, 'card-r2-1').style, DARK.yours)
  assert.equal(chip(moved, 'card-r2-0').style, undefined)
  const turn = at({ ...CARD, stage: 'turn', rows: [row('a1', 'log input', ['a folder', 'one file'], [0], { origin: 'agent' })], focus: 'a1' })
  assert.deepEqual(chip(turn, 'card-a1-0').style, DARK.agent)
  const switched = at({ ...CARD, stage: 'turn', rows: [row('a1', 'log input', ['a folder', 'one file'], [1], { origin: 'agent', chosen: true })], focus: 'a1' })
  assert.deepEqual(chip(switched, 'card-a1-1').style, DARK.yours)
  assert.ok(switched.some((l) => plain(l).includes('was a folder')))
  assert.equal(paletteFor('light-daltonized'), LIGHT)
  assert.equal(paletteFor('dark'), DARK)
  assert.equal(paletteFor(undefined), DARK)
})

test('the sketch stands beside the rows on a wide terminal and keeps its frame closed when cut', () => {
  const wide = layoutBandRows(band(CARD), 200, 'ctrl+x tab', 60).map(plain)
  const tops = wide.filter((l) => l.includes('┌ MarginCue'))
  assert.equal(tops.length, 1)
  const left = wide.find((l) => l.includes('┌ MarginCue'))!.indexOf('┌')
  const framed = wide.filter((l) => /[│├└]/.test(l.slice(left, left + 1)))
  assert.equal(framed.length, SKETCH.length - 1)
  assert.ok(framed.every((l) => l.indexOf('│') === left || /[├└]/.test(l[left]!)))
  // Stacked under the rows, with too few rows left: first lines, a fold inside the frame, the bottom edge.
  const short = layoutBandRows(band(CARD), 100, 'ctrl+x tab', 21).map(plain)
  assert.ok(short.length <= 21)
  const bottom = short.findIndex((l) => l.includes('└'))
  assert.ok(bottom > 0, short.join('\n'))
  assert.match(short[bottom - 1]!, /│ ⋯ \d+ more lines/)
  // No room at all: the caption alone says how many lines are folded.
  const tiny = layoutBandRows(band(CARD), 100, 'ctrl+x tab', 12).map(plain)
  assert.ok(tiny.some((l) => /10 lines, folded/.test(l)), tiny.join('\n'))
})

test('a sketch frame is put straight; lines outside it are left alone', () => {
  const tidy = tidySketch(SKETCH)
  const widths = new Set(tidy.map(cells))
  assert.equal(widths.size, 1)
  assert.ok(tidy.every((l) => /[│┐┤┘]$/.test(l)))
  assert.match(tidy[0]!, /^┌ MarginCue ─+┐$/)
  const loose = ['$ runlog week', 'bugs: 3   runs: 41']
  assert.deepEqual(tidySketch(loose), loose)
})

test('the prompt as sent lists what MarginCue attached, and nothing when it attached nothing', () => {
  const sent = 'Build the export.\n\nDecisions:\n- Export all rows.\n- Where things are: Dashboard (src/dashboard/index.ts)\n\n' +
    'Target output, as sketched (Export dialog):\n```text\n┌ Export ┐\n│ CSV    │\n└────────┘\n```'
  const parts = splitSent(sent)!
  assert.equal(parts.body, 'Build the export.')
  assert.deepEqual(parts.decisions, ['Export all rows.'])
  assert.deepEqual(parts.refs, ['Dashboard (src/dashboard/index.ts)'])
  assert.deepEqual(parts.sketch, { title: 'Export dialog', lines: 3 })
  const lines = layoutSent(parts, 80).map(plain)
  assert.match(lines[0]!, /went with this prompt: 1 decision, where things are in the code and the sketch/)
  assert.ok(lines.some((l) => l.includes('✓ Export all rows.')))
  assert.equal(splitSent('Just a question about the export?'), null)
})

test('the receipt fits its width and says what was switched', () => {
  const receipt = { id: 1, yours: ['Write the report to a markdown file.'],
    agent: [{ label: 'run log', value: 'one SQLite database', was: 'one JSONL file per run', options: ['one JSONL file per run', 'one SQLite database', 'a CSV per run'] }] }
  for (const columns of [50, 80, 160]) {
    const lines = layoutReceipt(receipt, columns)
    for (const line of lines) assert.ok(segmentsWidth(line) <= Math.max(columns, 40), plain(line))
  }
  const lines = layoutReceipt(receipt, 160).map(plain)
  assert.match(lines[0]!, /you set 1 · the agent chose 1/)
  assert.ok(lines.some((l) => l.includes('was one JSONL file per run')))
  assert.ok(buttons(layoutReceipt(receipt, 160)).some((b) => b.key === 'agent-0-2'))
})

test('an option the model cut short is left out rather than sent cut', () => {
  const card = parseCard([
    'read | You want a redesign.',
    'row | verify | verify | one | Verify it by {} | running live in Claude Code and… | running the tests | a scripted PTY run in... | a review',
  ].join('\n'))
  assert.deepEqual(card.rows[0]?.options, ['running the tests', 'a review'])
})

test('a sketch longer than the limit keeps the line that closes its frame', () => {
  const rows = Array.from({ length: 16 }, (_, i) => `│ row ${i}`.padEnd(20) + '│')
  const sketch = parseSketch(['title | Long page', '┌──────────────────┐', ...rows, '└──────────────────┘'].join('\n'))!
  assert.equal(sketch.lines.length, 14)
  assert.match(sketch.lines.at(-1)!, /^└─+┘$/)
})

test('a sketch line the model left open is closed with the rest of its frame', () => {
  const tidy = tidySketch(['┌──────────┐', '│ Reports  │', '│ Team owners  [Download CSV]', '└──────────┘'])
  assert.deepEqual(tidy.map((line) => line.at(-1)), ['┐', '│', '│', '┘'])
  assert.equal(new Set(tidy.map((line) => [...line].length)).size, 1)
})

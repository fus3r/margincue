import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import './ts-resolve.ts'
import type { MargincueBand, MargincueCard, MargincueRow } from '../mods/claude-code/types'

const { layoutBandRows, segmentsWidth, cells, tidySketch, DARK, LIGHT, paletteFor } = await import('../mods/claude-code/hooks/band')
const { layoutCard, layoutReceipt, layoutSent, splitSent } = await import('../mods/claude-code/hooks/card-view')
const { parseCard, parseSketch } = await import('../mods/claude-code/core/card')
const { scoreChoice } = await import('../mods/claude-code/core/review-first')
const { createCore } = await import('../mods/claude-code/core/index')
const { ASSETS } = await import('../mods/claude-code/hooks/assets')
const { drawLine } = await import('../mods/codex/src/terminal')

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
// Claude Code's plain Button prints the hotkey before the face or label.
const chapterPlain = (line: Seg[]) => plain(line.map((s) => s.kind === 'button' && s.action.type === 'chapter' && s.hotkey
  ? { ...s, face: `${s.hotkey}: ${s.face ?? s.label}` } : s))

test('every level of every chapter fits the terminal widths and can be read in full', () => {
  const base: MargincueCard = { ...CARD, read: null, focus: null, rows: [], mentions: [], sketch: undefined }
  for (const width of [60, 76, 78, 80, 120]) {
    for (const { title, notes } of ASSETS.chapters!) {
      for (const note of Object.values(notes)) {
        const choice = note.split('\n')[2]!.slice('Choice. '.length)
        const render = (expanded: boolean, page = 0) => layoutCard(
          { ...base, chapter: { title, choice, notes: note, expanded, page } }, width, 8, { chords: true, extra: [] })
        const collapsed = render(false)
        assert.equal(collapsed.length, 3)
        assert.match(chapterPlain(collapsed[1]!), /§ /)
        assert.ok(plain(collapsed[2]!).length > 0)
        assert.ok(collapsed.every((line) => segmentsWidth(line) <= width))
        const body: string[] = []
        for (let page = 0; ; page++) {
          const expanded = render(true, page)
          assert.ok(expanded.length <= 8 && expanded.every((line) => segmentsWidth(line) <= width))
          assert.match(chapterPlain(expanded[2]!), /b: collapse · z: drop/)
          body.push(...expanded.slice(3).map((line) => plain(line).trim()))
          const paging = buttons(expanded).find((button) => button.key === 'chapter-next')?.label
          if (!paging || paging.endsWith(`/${page + 1}`)) break
          assert.ok(page < 4)
        }
        assert.equal(body.join(' '), note.replace(/\s+/g, ' '), `${width}: ${title}`)
      }
    }
  }
})

const ML_TITLE = 'Neural networks and training comparisons'
const ML_CHOICE = 'Separate a controlled comparison from a best-result claim at a fixed budget.'
const ML_CARD: MargincueCard = {
  ...CARD, read: 'A paired learning-rate sweep.', mentions: [], focus: 'seeds',
  rows: [
    row('seeds', 'seeds', ['paired seeds', 'independent seeds'], [0], { origin: 'lens' }),
    row('budget', 'budget', ['fixed GPU-hours', 'fixed trial count'], [0], { origin: 'lens' }),
    row('metric', 'metric', ['validation loss', 'held-out accuracy'], [0], { origin: 'lens' }),
    row('checkpoint', 'checkpoint', ['best validation step', 'last step'], [0], { origin: 'lens' }),
  ],
  sketch: { title: 'Sweep report', lines: [
    '┌ Sweep report ────────────┐',
    '│ Rate     Validation loss │',
    '│ 0.001    0.23            │',
    '└──────────────────────────┘',
  ], drawing: false, pinned: false, open: true },
}

function mlChapter() {
  const core = createCore(ASSETS)
  core.handle({ type: 'config', enabled: true, mode: 'auto', profile: 'general', sheet: true, read: 'key',
    prefer: ['ml-research'], depths: { 'ml-research': 'research' } })
  core.handle({ type: 'draft', now: 100, origin: 'type',
    text: 'Compare learning rates for a neural network using paired training seeds and a fixed compute budget.' })
  assert.equal(core.currentView().card?.chapter?.title, ML_TITLE)
  return core
}

const chapterPreview = (lines: string[]) => lines.filter((line) => /preview|Sweep report|Validation loss|0\.001|└─|more lines/.test(line))

for (const columns of [60, 76, 78, 80, 120]) {
  for (const maxRows of [10, 14, 24, 36, 38, 50]) {
    test(`an expert chapter keeps its reading and pages within ${columns} columns and ${maxRows} rows`, () => {
      const core = mlChapter()
      const chapter = core.currentView().card!.chapter!
      const render = () => layoutBandRows(band({ ...ML_CARD, chapter: core.currentView().card?.chapter }), columns, 'ctrl+x tab', maxRows)
      const check = (lines: Seg[][]) => {
        assert.ok(lines.length <= maxRows)
        assert.ok(lines.every((line) => segmentsWidth(line) <= columns))
        const text = lines.map(chapterPlain)
        assert.doesNotMatch(text.join('\n'), /[bnz]: [bnz]\b/)
        return text
      }
      const control = (lines: Seg[][], hotkey: string) => {
        const matches = lines.flat().filter((s) => s.kind === 'button' && s.action.type === 'chapter' && s.hotkey === hotkey)
        assert.equal(matches.length, 1, hotkey)
        const button = matches[0]
        assert.ok(button?.kind === 'button' && button.action.type === 'chapter')
        return { ...button, action: button.action }
      }
      const collapsed = render()
      const before = check(collapsed)
      const title = before.findIndex((line) => line.includes(`§ ${chapter.title}`))
      assert.ok(title > 0)
      const width = columns - 4
      assert.equal(before[title + 1], `    ${ML_CHOICE.length <= width ? ML_CHOICE : `${ML_CHOICE.slice(0, width - 1).trimEnd()}…`}`)
      const toggle = control(collapsed, 'b')
      assert.equal(toggle.hidden, undefined)
      assert.equal(Boolean(control(collapsed, 'z').hidden), columns === 60)
      const hint = before[title]!.slice(`  § ${chapter.title}`.length).trim()
      assert.equal(hint, columns === 60 ? 'b: expand' : columns === 76 ? 'b: expand · z: drop' : 'ctrl+x tab, b: expand · z: drop')
      assert.equal(before.filter((line) => line.includes('◆')).length, 4)
      core.handle(toggle.action)

      assert.ok(chapterPreview(before).length)
      const first = render()
      const firstText = check(first)
      const chapterTitle = firstText.findIndex((line) => line.includes(`§ ${chapter.title}`))
      assert.ok(chapterTitle > 0)
      const pages = Number(/n: next 1\/(\d+)/.exec(firstText[chapterTitle + 1]!)?.[1] ?? 1)
      if (maxRows >= 14) assert.match(chapterPreview(before).join('\n'), /Validation loss/)
      const noteLines: string[] = []
      for (let page = 1; page <= pages; page++) {
        const expanded = render()
        assert.deepEqual(expanded, render())
        const lines = check(expanded)
        assert.match(lines.slice(0, chapterTitle).join('\n'), /MarginCue.*A paired/)
        assert.ok(lines[chapterTitle]?.includes(`§ ${chapter.title}`))
        assert.equal(lines[chapterTitle + 1], `    ctrl+x tab, b: collapse · z: drop${pages > 1 ? ` · n: next ${page}/${pages}` : ''}`)
        assert.equal(lines.filter((line) => line.includes('◆')).length, 4)
        const preview = chapterPreview(lines)
        assert.equal(preview.length, 1)
        assert.match(preview[0]!, /preview\s+Sweep report/)
        if (columns > 60) assert.match(preview[0]!, /4 lines, folded/)
        const notes = expanded.slice(chapterTitle + 2).filter(([s]) => s?.kind === 'text' && s.style?.dim && /^ {4}\S/.test(s.text))
        assert.ok(notes.length >= 1 && notes.length <= 6)
        noteLines.push(...notes.map((line) => plain(line).trim()))
        if (pages > 1) core.handle(control(expanded, 'n').action)
      }
      assert.equal(noteLines.join(' '), core.currentView().card?.chapter?.notes.replace(/\n/g, ' '))
      assert.deepEqual(render(), first)
      core.handle(control(first, 'b').action)
      assert.deepEqual(render(), collapsed)
      if (columns > 60) core.handle(toggle.action)
      core.handle(control(render(), 'z').action)
      assert.equal(core.currentView().card?.chapter, undefined)
      const dismissed = check(render())
      assert.doesNotMatch(dismissed.join('\n'), /§|n: next/)
      if (maxRows >= 14) assert.deepEqual(chapterPreview(dismissed), chapterPreview(before))
    })
  }
}

test('a chapter sharing its title row with the expanded hint keeps paging visible before dismiss', () => {
  const core = mlChapter()
  core.handle({ type: 'chapter', action: 'toggle' })
  const card = { ...ML_CARD, chapter: core.currentView().card?.chapter }
  for (const columns of [60, 76, 78, 80, 86, 120]) {
    const rows = layoutBandRows(band(card), columns, 'ctrl+x tab', 3)
    const hint = chapterPlain(rows[1]!).slice(`  § ${ML_TITLE}`.length).trim()
    if (columns === 60) assert.equal(hint, 'b: collapse')
    else if (columns <= 80) assert.match(hint, /^b: collapse · n: next 1\/\d+$/)
    else if (columns === 86) assert.match(hint, /^b: collapse · z: drop · n: next 1\/\d+$/)
    else assert.match(hint, /^ctrl\+x tab, b: collapse · z: drop · n: next 1\/\d+$/)
  }
})

test('French chapter hints use the same fallback order', () => {
  const core = mlChapter()
  const render = (columns: number, maxRows: number) => layoutBandRows(
    band({ ...ML_CARD, language: 'fr', chapter: core.currentView().card?.chapter }), columns, 'ctrl+x tab', maxRows,
  ).map(chapterPlain).find((line) => line.includes(`§ ${ML_TITLE}`))!.slice(`  § ${ML_TITLE}`.length).trim()
  assert.equal(render(60, 38), 'b: ouvrir')
  assert.equal(render(76, 38), 'b: ouvrir · z: masquer')
  assert.equal(render(120, 38), 'ctrl+x tab, b: ouvrir · z: masquer')
  core.handle({ type: 'chapter', action: 'toggle' })
  assert.equal(render(60, 3), 'b: replier')
  assert.match(render(76, 3), /^b: replier · n: suite 1\/\d+$/)
  assert.match(render(120, 3), /^ctrl\+x tab, b: replier · z: masquer · n: suite 1\/\d+$/)
})

test('the expanded chapter gives the reading and title priority over standing cues at a tiny row budget', () => {
  const core = mlChapter()
  core.handle({ type: 'chapter', action: 'toggle' })
  const card = { ...ML_CARD, chapter: core.currentView().card?.chapter }
  const rows = layoutBandRows({ ...band(card), reviewPending: true }, 80, 'ctrl+x tab', 2)
  assert.equal(rows.length, 2)
  assert.match(plain(rows[0]!), /MarginCue.*A paired/)
  assert.match(plain(rows[1]!), /§ Neural networks/)
})

test('a wrapped decision label cannot increase the expanded band past its row budget', () => {
  const core = mlChapter()
  core.handle({ type: 'chapter', action: 'toggle' })
  const card = { ...ML_CARD, chapter: core.currentView().card?.chapter,
    rows: ML_CARD.rows.map((r) => r.id === ML_CARD.focus ? { ...r, label: 'random seeds for repeated independent training runs' } : r) }
  const rows = layoutBandRows(band(card), 60, 'ctrl+x tab', 10)
  assert.ok(rows.length <= 10, rows.map(plain).join('\n'))
  assert.match(rows.map(plain).join('\n'), /◆ random seeds/)
})

test('the Codex composer draws each chapter key once', () => {
  const core = mlChapter()
  const render = () => layoutCard({ ...ML_CARD, chapter: core.currentView().card?.chapter }, 80, 24,
    { chords: true, extra: [], chapterKeys: 'tab' })
    .map((line, y) => drawLine(line, 80, y, []).replace(/\x1b\[[0-9;:]*m/g, '')).join('\n')
  assert.match(render(), /§ Neural networks and training comparisons .*tab, b: expand · z: drop/)
  core.handle({ type: 'chapter', action: 'toggle' })
  assert.match(render(), /tab, b: collapse · z: drop · n: next 1\/\d+/)
})

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

test('card shortcuts stay mounted even when their labels are dropped', () => {
  for (const columns of [60, 80, 120]) {
    const card = { ...CARD, pickedOnly: true as const }
    const rows = layoutBandRows(band(card), columns, 'ctrl+x tab', 6)
    for (const key of ['r', 'd', 'k', 'x', 's', 'p', '1']) {
      const bound = rows.flat().filter((s) => s.kind === 'button' && s.hotkey === key)
      assert.equal(bound.length, 1, `${columns}: ${key}`)
    }
    assert.equal(buttons(rows).some((button) => button.hotkey === 'r'), columns === 120)
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

test('the 60, 80 and 120 column receipts preserve v0.4.31 off, show all flagged rows on, and match off with zero flags', () => {
  const agent = [
    { label: 'layout', value: 'compact', options: ['compact', 'roomy'] },
    { label: 'cache', value: 'in memory', options: ['in memory', 'Redis'] },
    { label: 'delivery', value: 'email customers', options: ['email customers', 'draft an email'] },
  ].map((choice, i) => ({ ...choice, review: scoreChoice(choice, { prompt: 'Use Redis.' },
    i === 2 ? undefined : { kind: 'named', edits: [{ path: 'src/layout.ts' }] }) }))
  const receipt = { id: 7, yours: ['Keep the layout.'], agent }
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  for (const [columns, baseline] of [
    [60, 'c6ca64cd5d7e367ae53f575b68d557db2f6b21f137ff83669991fd92ff09eb1f'],
    [80, '920fa64dc281a167a9f10c4c5b7a173c4b8969e476bc3f3c6df538c8c8e81bcd'],
    [120, '920fa64dc281a167a9f10c4c5b7a173c4b8969e476bc3f3c6df538c8c8e81bcd'],
  ] as const) {
    const zero = { ...receipt, agent: agent.map(({ review: _review, ...item }, i) => {
      const choice = i === 2 ? { ...item, value: 'draft an email' } : item
      return { ...choice, review: scoreChoice(choice, { prompt: 'Prepare the report.' },
        { kind: 'named', edits: [{ path: 'src/layout.ts' }] }) }
    }) }
    const off = layoutReceipt(receipt, columns, undefined, true, { sessionChoices: true })
    const on = layoutReceipt(receipt, columns, undefined, true, { audit: true, sessionChoices: true })
    assert.equal(hash(off), baseline)
    assert.ok(zero.agent.every((item) => !item.review.flagged))
    assert.deepEqual(layoutReceipt(zero, columns, undefined, true, { audit: true, sessionChoices: true }),
      layoutReceipt(zero, columns, undefined, true, { sessionChoices: true }))
    for (const line of [...off, ...on]) assert.ok(segmentsWidth(line) <= columns, plain(line))
    const rendered = on.map(plain).join('\n')
    assert.match(rendered, /2 to review first/)
    assert.match(rendered, /Review first[\s\S]+delivery[\s\S]+hard to undo · agent's word[\s\S]+cache[\s\S]+your prompt said "Redis" · matched edit[\s\S]+layout/)
    assert.deepEqual(buttons(on).filter((button) => button.action.type === 'receiptPick').map((button) => button.key),
      ['agent-2-1', 'agent-1-1', 'agent-0-1'])
    assert.ok(buttons(on).some((button) => button.key === 'receipt-session'))
  }
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

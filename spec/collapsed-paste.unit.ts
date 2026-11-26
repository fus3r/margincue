import assert from 'node:assert/strict'
import { test } from 'node:test'
import './ts-resolve.ts'

const { CollapsedPaste } = await import('../mods/claude-code/hooks/collapsed-paste')

const SINGLE = '[Pasted text #1]'
const MULTILINE = '[Pasted text #24 +9 lines]'

test('complete placeholders are tracked only in text the engine wrote', () => {
  for (const text of [SINGLE, MULTILINE, '[Pasted text #3 +1 line]']) {
    const box = new CollapsedPaste()
    box.update(text, text.length, { start: 0, end: 0, text })
    assert.equal(box.pending, false)
    box.clear()
    box.update(text, text.length, undefined, true)
    assert.equal(box.pending, true)
  }
  const box = new CollapsedPaste()
  const text = 'Explain what [Pasted text means here.'
  box.update(text, text.length, undefined, true)
  assert.equal(box.pending, false)
})

test('a typed lookalike beside a real placeholder stays distinct when the real paste is removed', () => {
  const box = new CollapsedPaste()
  box.update(SINGLE, SINGLE.length, { start: 0, end: 0, text: SINGLE })
  // The engine puts the paste just before the identical typed text. The caret is after the paste.
  box.update(SINGLE + SINGLE, SINGLE.length, undefined, true)
  assert.equal(box.pending, true)
  box.update(SINGLE, 0, { start: 0, end: SINGLE.length, text: '' })
  assert.equal(box.pending, false)
})

test('cursor moves and adjacent edits keep each paste span until that span is removed', () => {
  const box = new CollapsedPaste()
  box.update(SINGLE, SINGLE.length, undefined, true)
  box.update(SINGLE + MULTILINE, SINGLE.length + MULTILINE.length, undefined, true)
  box.update(box.text, 2, { start: 2, end: 2, text: '' })
  const prefix = 'Use '
  box.update(prefix + box.text, prefix.length, { start: 0, end: 0, text: prefix })
  box.update(prefix + SINGLE, prefix.length + SINGLE.length, { start: prefix.length + SINGLE.length, end: box.text.length, text: '' })
  assert.equal(box.pending, true)
  box.update(prefix, prefix.length, { start: prefix.length, end: box.text.length, text: '' })
  assert.equal(box.pending, false)
})

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { kickoffSignal, startsSomethingNew } from '../mods/claude-code/core/kickoff.ts';

const vectors = JSON.parse(readFileSync(new URL('./kickoff-vectors.json', import.meta.url), 'utf8')) as
  [string, ReturnType<typeof kickoffSignal>][];

test('kick-off signal and default trigger on invented drafts', () => {
  for (const [draft, signal] of vectors) {
    assert.equal(kickoffSignal(draft), signal, draft);
    assert.equal(startsSomethingNew(draft, { firstOfSession: false }), signal === 'creation', draft);
    assert.equal(startsSomethingNew(draft, { firstOfSession: true }), signal !== 'ordinary', draft);
  }
});

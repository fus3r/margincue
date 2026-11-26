import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { EditedFile, Hunk } from '../mods/claude-code/hooks/turn-edits.ts'
import './ts-resolve.ts'

const { capturedChoiceEdits, editedFiles, finishEdits, recordToolEdit, startEdits } = await import('../mods/claude-code/hooks/turn-edits')
const { scoreChoice } = await import('../mods/claude-code/core/review-first')
const { editorSides, readHunks, relatedPatch } = await import('../mods/claude-code/hooks/edit-patch')
const { collectVocabulary, referencedNames } = await import('../mods/claude-code/hooks/repo-index')
const { relateEdits } = await import('../mods/claude-code/hooks/edit-relation')
const { openRelatedFiles } = await import('../mods/claude-code/hooks/edit-opener')
const { layoutReceipt } = await import('../mods/claude-code/hooks/card-view')
const { segmentsWidth } = await import('../mods/claude-code/hooks/segments')

const gitAvailable = !spawnSync('git', ['--version']).error
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const run = async (argv: string[], options: { cwd?: string; timeoutMs?: number } = {}) => {
  const env = options.cwd ? { ...process.env, GIT_CEILING_DIRECTORIES: dirname(options.cwd) } : process.env
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', env })
  if (r.error) throw r.error
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1, isStdoutTruncated: false }
}
const io = { process: { run }, fs: {
  read: async (path: string) => readFileSync(path, 'utf8'),
  write: async (path: string, text: string) => put(path, text),
  stat: async (path: string) => {
    const stat = statSync(path)
    return { kind: stat.isFile() ? 'file' : 'dir', size: stat.size, mtimeMs: stat.mtimeMs, realPath: realpathSync(path), isLink: false }
  },
} } as never

function temp(t: { after: (fn: () => void) => void }): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'margincue-edits-')))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function gitIn(cwd: string) {
  return async (...args: string[]) => {
    const result = await run(['git', ...args], { cwd })
    assert.equal(result.exitCode, 0, result.stderr)
    return result.stdout
  }
}

test('Git capture keeps pre-existing changes out and includes new, deleted and previously untracked files', { skip: !gitAvailable }, async (t) => {
  const cwd = temp(t)
  const git = gitIn(cwd)
  await git('init', '-q')
  await git('config', 'core.autocrlf', 'false')
  put(join(cwd, 'src', 'export.ts'), 'format = raw\n')
  put(join(cwd, 'delete me.txt'), 'remove me\n')
  put(join(cwd, 'owner.txt'), 'original\n')
  put(join(cwd, '.gitignore'), 'ignored.txt\n')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Base')
  put(join(cwd, 'src', 'export.ts'), 'format = owner-staged\n')
  await git('add', 'src/export.ts')
  put(join(cwd, 'src', 'export.ts'), 'format = owner-working\n')
  put(join(cwd, 'owner.txt'), 'owner kept this change\n')
  put(join(cwd, 'existing.md'), 'before\n')
  put(join(cwd, 'owner.dat'), 'existing binary\0data')
  const index = readFileSync(join(cwd, '.git', 'index'))
  const refs = await git('show-ref')
  const capture = startEdits(io, cwd)
  await capture.before

  put(join(cwd, 'src', 'export.ts'), 'format = jsonl\n')
  put(join(cwd, 'existing.md'), 'after\n')
  put(join(cwd, 'new file.txt'), 'new\n')
  put(join(cwd, 'ignored.txt'), 'ignored\n')
  rmSync(join(cwd, 'delete me.txt'))
  const turn = finishEdits(io, capture)
  await turn.after
  put(join(cwd, 'src', 'export.ts'), 'later turn\n')

  const impact = await capturedChoiceEdits(io, turn)
  assert.deepEqual(impact.filter(({ deleted }) => deleted).map(({ path }) => path), ['delete me.txt'])
  assert.ok(!impact.some(({ path }) => path === 'owner.txt'))
  const edits = await editedFiles(io, turn)
  assert.deepEqual(Object.fromEntries(edits.map(({ path, before, after }) => [path, [before?.text ?? null, after?.text ?? null]])), {
    'src/export.ts': ['format = owner-working\n', 'format = jsonl\n'],
    'delete me.txt': ['remove me\n', null],
    'existing.md': ['before\n', 'after\n'],
    'new file.txt': [null, 'new\n'],
  })
  const diffDir = temp(t)
  await Promise.all(edits.map((file) => readHunks(io, diffDir, file)))
  assert.ok(edits.every((file) => file.hunks.length === 1))
  const patch = relatedPatch(edits.map((file) => ({ file })))
  assert.match(patch, /--- "a\/delete me\.txt"\n\+\+\+ \/dev\/null/)
  assert.match(patch, /--- \/dev\/null\n\+\+\+ "b\/new file\.txt"/)
  assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index)
  assert.equal(await git('show-ref'), refs)
})

test('captured native edits distinguish an exported interface change from an implementation edit', async (t) => {
  const cwd = temp(t)
  const turn = startEdits(io, cwd)
  for (const [path, originalFile, content] of [
    ['api.ts', 'export interface Result {\n  value: string\n}\n', 'export interface Result {\n  value: number\n}\n'],
    ['parser.ts', 'export function parse(s: string) { return s }', 'export function parse(s: string) { return s.trim() }'],
  ]) recordToolEdit(io, turn, path, ++turn.position, { originalFile, content })
  assert.deepEqual((await capturedChoiceEdits(io, finishEdits(io, turn))).map(({ path, publicInterface }) => [path, publicInterface]),
    [['api.ts', true], ['parser.ts', false]])
})

test('dependency evidence tracks entries, and delivery evidence tracks changed effects', async (t) => {
  const cwd = temp(t)
  const turn = startEdits(io, cwd)
  for (const [path, originalFile, content] of [
    ['packages/typo/package.json', '{"description":"a typo","dependencies":{"a":"1","b":"2"}}',
      '{"description":"fixed","dependencies":{"b":"2","a":"1"}}'],
    ['packages/update/package.json', '{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"2"}}'],
    ['pyproject.toml', '[project]\nname="sample"\ndependencies = [\n "numpy",\n]\n',
      '[project]\nname="sample"\ndependencies = [\n "numpy",\n "pandas",\n]\n'],
    ['requirements.txt', '# Basics\nnumpy==1\n', '# Basics\nnumpy==2\n'],
    ['src/receipt.ts', 'let message = emailTemplate\n', 'let message = emailTemplate\nmailer.send(message)\n'],
    ['src/keep.ts', 'sendEmail(message)\nconst limit = 1\n', 'sendEmail(message)\nconst limit = 2\n'],
  ]) recordToolEdit(io, turn, path, ++turn.position, { originalFile, content })
  const result = await capturedChoiceEdits(io, finishEdits(io, turn))
  assert.deepEqual(result.filter((edit) => edit.dependencies).map(({ path }) => path),
    ['packages/update/package.json', 'pyproject.toml', 'requirements.txt'])
  assert.deepEqual(result.filter((edit) => edit.sendsOutside).map(({ path }) => path), ['src/receipt.ts'])
  assert.equal(result.find(({ path }) => path === 'packages/typo/package.json')?.matched, true)
})

test('captured dependency, shared config, test and docs edits receive their path costs', async (t) => {
  const cwd = temp(t)
  const turn = startEdits(io, cwd)
  const choice = { label: 'cache', value: 'in memory', options: ['in memory', 'Redis'] }
  const requirements = '# Runtime dependencies\nnumpy==1\n'
  const pyproject = '[project]\ndescription = "A smple tool"\ndependencies = ["numpy==1"]\n'
  const cargo = '[package]\ndescription = "A smple tool"\n[dependencies]\nserde = "1"\n'
  const go = 'module example.com/tool\n\ngo 1.24.0\n\nrequire (\n\t// Runtime dependency\n\texample.com/dependency v1.0.0 // indirect\n)\n'
  const cases = [
    ['requirements.txt', requirements, requirements.replace('==1', '==2'), 'changes dependencies', 3],
    ['comments/requirements.txt', requirements, requirements.replace('Runtime', 'Production'), 'local edit', 1],
    ['pyproject.toml', pyproject, pyproject.replace('==1', '==2'), 'changes dependencies', 3],
    ['metadata/pyproject.toml', pyproject, pyproject.replace('smple', 'simple'), 'local edit', 1],
    ['Cargo.toml', cargo, cargo.replace('"1"', '"2"'), 'changes dependencies', 3],
    ['metadata/Cargo.toml', cargo, cargo.replace('smple', 'simple'), 'local edit', 1],
    ['go.mod', go, go.replace('v1.0.0', 'v1.1.0'), 'changes dependencies', 3],
    ['comments/go.mod', go, go.replace('Runtime', 'Production'), 'local edit', 1],
    ['.github/workflows/ci.yml', 'name: Check\n', 'name: Build\n', 'changes shared config', 3],
    ['docker-compose.yml', 'services: {}\n', 'services:\n  app:\n    image: app\n', 'changes shared config', 3],
    ['.env.example', 'CACHE_SIZE=32\n', 'CACHE_SIZE=64\n', 'changes shared config', 3],
    ['tests/cache.test.ts', 'assert.equal(size, 32)\n', 'assert.equal(size, 64)\n', 'local edit', 1],
    ['docs/cache.md', 'Cache size is 32.\n', 'Cache size is 64.\n', 'local edit', 1],
  ] as const
  for (const [path, originalFile, content] of cases) {
    recordToolEdit(io, turn, path, ++turn.position, { originalFile, content })
  }
  const edits = await capturedChoiceEdits(io, finishEdits(io, turn))
  for (const [path, , , reason, cost] of cases) {
    const edit = edits.find((edit) => edit.path === path)
    assert.ok(edit?.matched, path)
    const review = scoreChoice(choice, { prompt: '' }, { kind: 'named', edits: [edit] })
    assert.deepEqual([review.costReason, review.c, review.flagged], [reason, cost, cost === 3], path)
  }
})

test('the which-file index finds actual cross-file uses of declarations in edited files', { skip: !gitAvailable }, async (t) => {
  const cwd = temp(t)
  await gitIn(cwd)('init', '-q')
  put(join(cwd, 'core.ts'), 'function makeReport() { return 1 }\nfunction unusedHelper() { return 2 }\n')
  put(join(cwd, 'consumer.ts'), 'const result = makeReport()\n')
  put(join(cwd, 'duplicate.ts'), 'function unusedHelper() { return 3 }\n')
  const engine = { process: { run }, env: { get: async () => undefined } }
  const vocab = await collectVocabulary(engine, cwd)
  assert.ok(vocab)
  assert.deepEqual([...await referencedNames(engine, cwd, vocab, new Set(['core.ts']))], [['core.ts', 'makeReport']])
})

test('outside Git, successful tool results keep both sides without attributing other files', async (t) => {
  const cwd = temp(t)
  const capture = startEdits(io, cwd)
  assert.equal(await capture.before, null)
  const path = join(cwd, 'saved.ts')
  const patch = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-format = raw', '+format = jsonl'] }
  put(path, 'format = jsonl\n')
  recordToolEdit(io, capture, path, 1, { originalFile: 'format = raw\n', structuredPatch: [patch] })
  recordToolEdit(io, capture, 'new.txt', 2, { type: 'create', originalFile: null, content: 'created\n' })
  recordToolEdit(io, capture, 'preview.txt', 3, { staged: true, originalFile: null, content: 'preview only' })
  put(join(cwd, 'elsewhere.txt'), 'unobserved\n')
  const files = await editedFiles(io, finishEdits(io, capture))
  assert.deepEqual(files.map((file) => file.path), ['new.txt', 'saved.ts'])
  const changed = files[1]!
  assert.equal(changed.before?.text, 'format = raw\n')
  assert.equal(changed.after?.text, 'format = jsonl\n')
  await readHunks(io, '/unused', changed)
  assert.deepEqual(changed.hunks, [patch])
})

const hunk = (line: number, removed: string, added: string): Hunk => ({
  oldStart: line, oldLines: 1, newStart: line, newLines: 1, lines: [`-${removed}`, `+${added}`],
})
const edited = (path: string, hunks: Hunk[], before = 'raw\n', after = 'jsonl\n'): EditedFile => ({
  path, before: { text: before, mode: '100644' }, after: { text: after, mode: '100644' }, hunks, tools: [],
})
const noReading = async (): Promise<never> => assert.fail('unexpected reading')

test('line-ending-only writes stay out of the receipt', async (t) => {
  const cwd = temp(t)
  const capture = startEdits(io, cwd)
  assert.equal(await capture.before, null)
  recordToolEdit(io, capture, 'settings.txt', 1, { originalFile: 'old\n', content: 'old\r\n' })
  assert.deepEqual(await editedFiles(io, finishEdits(io, capture)), [])
})

test('native CRLF patch lines match nearby selected changes', async (t) => {
  const cwd = temp(t)
  const capture = startEdits(io, cwd)
  assert.equal(await capture.before, null)
  const native = hunk(1, 'oldFlag\r', 'newFlag\r')
  recordToolEdit(io, capture, 'settings.txt', 3, {
    originalFile: 'oldFlag\n', content: 'newFlag\r\n', structuredPatch: [native],
  })
  const [file] = await editedFiles(io, finishEdits(io, capture))
  await readHunks(io, temp(t), file!)
  const choice = { label: 'controls', value: 'compact', mark: { position: 1, words: '', choice: 'compact' } }
  const related = await relateEdits([file!], choice, async ({ hunks }) => {
    assert.deepEqual(hunks, [{ id: 1, path: 'settings.txt', before: 1, after: 1, changes: '-oldFlag\n+newFlag' }])
    return [1]
  })
  assert.deepEqual(related[0]?.hunks, [hunk(1, 'oldFlag', 'newFlag')])
})

test('a choice links all matching hunks across files and excludes other edits in the same file', async () => {
  const first = hunk(2, 'format: csv', 'format: jsonl')
  const second = hunk(20, 'example.csv', 'example.jsonl')
  const third = hunk(8, 'using csv', 'using jsonl')
  const exportFile = edited('src/export.ts', [first, hunk(12, 'limit: 10', 'limit: 20'), second])
  const docs = edited('README.md', [third])
  let calls = 0
  assert.deepEqual(await relateEdits([exportFile, docs], { label: 'export format', value: 'JSONL' }, async () => { calls++; return [] }), [
    { file: exportFile, hunks: [first, second] }, { file: docs, hunks: [third] },
  ])
  assert.equal(calls, 0)
})

test('a named file is linked when the choice has no clean hunk', async () => {
  const file = edited('config/settings.ts', [hunk(2, 'a: 1', 'a: 2'), hunk(12, 'b: 3', 'b: 4')])
  const unrelated = edited('tests/settings.ts', [hunk(2, 'c: 5', 'c: 6')])
  assert.deepEqual(await relateEdits([file, unrelated], { label: 'Retry policy in `config/settings.ts`' }, noReading), [{ file, hunks: undefined }])
})

test('an unrelated choice returns no edits and the reading sees only path and line metadata', async () => {
  const file = edited('settings.ts', [hunk(2, 'originalLimit', 'higherLimit')])
  let calls = 0
  assert.deepEqual(await relateEdits([file], { label: 'chart orientation', value: 'horizontal' }, async ({ hunks }) => {
    calls++
    assert.deepEqual(hunks, [{ id: 1, path: 'settings.ts', before: 2, after: 2 }])
    return []
  }), [])
  assert.equal(calls, 1)
  assert.deepEqual(await relateEdits([], { label: 'chart orientation' }, noReading), [])
})

test('the optional reading sees only changed lines in the nearby hunks and returns related IDs', async () => {
  const nearby = { ...hunk(3, 'oldFlag', 'newFlag'), lines: [' secret context', '-oldFlag', '+newFlag'] }
  const later = hunk(13, 'oldKey', 'newKey')
  const file = edited('settings.ts', [nearby, later])
  file.tools = [
    { path: file.path, position: 3, before: file.before, after: Promise.resolve(file.after), hunks: [nearby] },
    { path: file.path, position: 7, before: file.before, after: Promise.resolve(file.after), hunks: [later] },
  ]
  const choice = { label: 'controls', value: 'compact', mark: { position: 1, words: '', choice: 'compact' }, nextMark: 5 }
  const related = await relateEdits([file], choice, async ({ hunks }) => {
    assert.deepEqual(hunks, [{ id: 1, path: 'settings.ts', before: 3, after: 3, changes: '-oldFlag\n+newFlag' }])
    return [1, 2, 99]
  })
  assert.deepEqual(related, [{ file, hunks: [nearby] }])
})

test('an oversized reading falls back to files without sending code', async () => {
  const patch = hunk(1, 'before', 'x'.repeat(7000))
  const file = edited('settings.ts', [patch])
  file.tools = [{ path: file.path, position: 3, before: file.before, after: Promise.resolve(file.after), hunks: [patch] }]
  const choice = { label: 'controls', value: 'compact', mark: { position: 1, words: '', choice: 'compact' } }
  assert.deepEqual(await relateEdits([file], choice, noReading), [{ file, hunks: undefined }])
})

test('terminal receipts link user choices and marked choices at narrow and wide widths', () => {
  const receipt = { id: 1, yours: ['Keep the format in src/export.ts.'],
    agent: [{ label: 'export format', value: 'JSONL', options: ['JSONL', 'CSV'], tier: 'mid' as const }] }
  for (const columns of [38, 100]) {
    const rows = layoutReceipt(receipt, columns, undefined, true)
    assert.ok(rows.every((row) => segmentsWidth(row) <= columns))
    assert.deepEqual(rows.flat().filter((item) => item.kind === 'button' && item.action.type === 'receiptDiff')
      .map((item) => item.action), [{ type: 'receiptDiff', receipt: 1, choice: 0 }, { type: 'receiptDiff', receipt: 1, choice: 1 }])
    assert.ok(rows.flat().some((item) => item.kind === 'text' && item.text.includes('e opens related edits')))
  }
})

function opener(environment: Record<string, string>, works: (argv: string[]) => boolean = () => true) {
  const calls: string[][] = []
  const files = new Map<string, string>()
  return { calls, files, io: {
    env: { get: async (key: string) => environment[key] },
    fs: { write: async (path: string, text: string) => { files.set(path, text) } },
    process: { run: async (argv: string[]) => { calls.push(argv); return { exitCode: works(argv) ? 0 : 127 } } },
  } as never }
}

for (const [terminal, exe, integration, path] of [
  ['vscode', 'code', ''], ['cursor', 'cursor', ''], ['windsurf', 'windsurf', ''], ['vscode-insiders', 'code-insiders', ''],
  ['vscode', 'cursor', '/Applications/Cursor.app/extensions/git/dist/askpass-main.js'],
  ['vscode', 'windsurf', '/Applications/Windsurf.app/extensions/git/dist/askpass-main.js'],
  ['vscode', 'cursor', '', '/usr/bin:/Applications/Cursor.app/Contents/Resources/app/bin'],
] as const) {
  test(`${terminal} terminal opens each related file with ${exe} --diff${path ? ' using its CLI directory' : ''}`, async () => {
    const { calls, files, io } = opener({ TERM_PROGRAM: terminal, VSCODE_GIT_ASKPASS_MAIN: integration, PATH: path ?? '' })
    const one = edited('src/path with spaces.ts', [hunk(1, 'raw', 'jsonl'), hunk(2, 'old', 'new')], 'raw\nold\n', 'jsonl\nnew\n')
    const two = edited('README.md', [hunk(1, 'raw', 'jsonl')])
    assert.equal(await openRelatedFiles(io, '/private tmp', [{ file: one, hunks: [one.hunks[0]!] }, { file: two }]), undefined)
    assert.deepEqual(calls, [
      [exe, '--diff', '/private tmp/before/src/path with spaces.ts', '/private tmp/after/src/path with spaces.ts'],
      [exe, '--diff', '/private tmp/before/README.md', '/private tmp/after/README.md'],
    ])
    assert.equal(files.get('/private tmp/before/src/path with spaces.ts'), 'raw\nold\n')
    assert.equal(files.get('/private tmp/after/src/path with spaces.ts'), 'jsonl\nold\n')
  })
}

test('the diff fallback rebases selected hunks and passes one path to VISUAL', { skip: !gitAvailable }, async (t) => {
  const cwd = temp(t)
  const label = 'src/file name.txt'
  const before = Array.from({ length: 16 }, (_, i) => `line ${i + 1}\n`).join('')
  put(join(cwd, label), before)
  const first = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-line 1', '+first', '+inserted'] }
  const second = { ...hunk(16, 'line 16', 'last'), newStart: 17, lines: ['-line 16', '+last', '\\ No newline at end of file'] }
  const file = edited(label, [first, second], before, 'first\ninserted\n' + before.slice(7).replace('line 16\n', 'last'))
  const related = [{ file, hunks: [second] }]
  const { calls, files, io } = opener({ TERM_PROGRAM: 'Apple_Terminal', VISUAL: '"/opt/editor with space" --reuse' })
  const dir = temp(t)
  assert.equal(await openRelatedFiles(io, dir, related), undefined)
  const path = `${dir}/related-edits.diff`
  assert.deepEqual(calls, [['/opt/editor with space', '--reuse', path]])
  const patch = files.get(path)!
  assert.match(patch, /@@ -16,1 \+16,1 @@/)
  assert.doesNotMatch(patch, /inserted/)
  put(path, patch)
  const result = await run(['git', '-c', 'core.autocrlf=false', 'apply', '--unidiff-zero', path], { cwd })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(readFileSync(join(cwd, label), 'utf8'), editorSides(related[0]!)?.after)
})

test('selected hunks against an LF snapshot preserve the working file’s CRLF and LF endings', { skip: !gitAvailable }, async (t) => {
  const dir = temp(t)
  const before = Array.from({ length: 16 }, (_, i) => `line ${i + 1}\n`).join('')
  const working = before.replaceAll('\n', '\r\n').replace('line 9\r\n', 'line 9\n')
  const after = working.replace('line 1', 'unrelated\r\ninserted').replace('line 16', 'jsonl')
  const file = edited('settings.txt', [], before, after)
  await readHunks(io, dir, file)
  assert.equal(file.hunks.length, 2)
  const related = await relateEdits([file], { label: 'export format', value: 'JSONL' }, noReading)
  assert.deepEqual(related[0]?.hunks, [file.hunks[1]])
  const expected = working.replace('line 16', 'jsonl')
  assert.equal(editorSides(related[0]!)?.after, expected)
  const patch = relatedPatch(related)
  assert.match(patch, /-line 16\n\+jsonl\r\n/)
  assert.doesNotMatch(patch, /unrelated|inserted/)
})

test('an autocrlf checkout opens a focused diff and applies its fallback to the CRLF worktree', { skip: !gitAvailable }, async (t) => {
  const cwd = temp(t)
  const git = gitIn(cwd)
  const path = join(cwd, 'settings.txt')
  const lfPath = join(cwd, 'lf.txt')
  const fixedLfPath = join(cwd, 'fixed-lf.txt')
  const before = Array.from({ length: 16 }, (_, i) => `line ${i + 1}\n`).join('')
  const working = before.replaceAll('\n', '\r\n')
  await git('init', '-q')
  await git('config', 'core.autocrlf', 'true')
  put(path, working)
  put(lfPath, working)
  put(fixedLfPath, before)
  put(join(cwd, '.gitattributes'), 'fixed-lf.txt text eol=lf\n')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Base')
  assert.equal(await git('show', 'HEAD:settings.txt'), before)
  rmSync(path)
  await git('checkout', '--', 'settings.txt')
  assert.equal(readFileSync(path, 'utf8'), working)
  const config = readFileSync(join(cwd, '.git', 'config'))
  const capture = startEdits(io, cwd)
  await capture.before

  const after = working.replace('line 1', 'unrelated').replace('line 16', 'jsonl')
  put(path, after)
  put(lfPath, before.replace('line 16', 'jsonl'))
  put(fixedLfPath, working.replace('line 16', 'jsonl'))
  const files = await editedFiles(io, finishEdits(io, capture))
  const dir = temp(t)
  await Promise.all(files.map((file) => readHunks(io, dir, file)))
  assert.deepEqual(files.map(({ path, hunks }) => [path, hunks.length]), [['fixed-lf.txt', 1], ['lf.txt', 1], ['settings.txt', 2]])
  const related = await relateEdits(files, { label: 'export format', value: 'JSONL' }, noReading)
  const display = opener({ TERM_PROGRAM: 'vscode' })
  await openRelatedFiles(display.io, dir, related)
  const expected = working.replace('line 16', 'jsonl')
  assert.equal(display.files.get(`${dir}/after/settings.txt`), expected)
  assert.equal(display.files.get(`${dir}/after/lf.txt`), before.replace('line 16', 'jsonl'))
  assert.equal(display.files.get(`${dir}/before/fixed-lf.txt`), before)
  assert.equal(display.files.get(`${dir}/after/fixed-lf.txt`), expected)

  const fallback = opener({ VISUAL: 'editor' })
  await openRelatedFiles(fallback.io, dir, related.filter(({ file }) => file.path !== 'lf.txt'))
  const patch = `${dir}/related-edits.diff`
  put(patch, fallback.files.get(patch)!)
  assert.equal(readFileSync(path, 'utf8'), after)
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config)
  await git('checkout', '--', 'settings.txt', 'fixed-lf.txt')
  await git('apply', patch)
  assert.equal(readFileSync(path, 'utf8'), expected)
  assert.equal(readFileSync(fixedLfPath, 'utf8'), before.replace('line 16\n', 'jsonl\r\n'))
})

test('a file committed during the turn keeps its captured working-tree endings', { skip: !gitAvailable }, async (t) => {
  const cwd = temp(t)
  const git = gitIn(cwd)
  const commit = (message: string) => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message)
  await git('init', '-q')
  await git('config', 'core.autocrlf', 'true')
  const path = join(cwd, 'settings.txt')
  put(path, 'old\r\nline\r\n')
  await git('add', 'settings.txt')
  await commit('Base')
  const capture = startEdits(io, cwd)
  await capture.before

  const after = 'new\r\nline\n'
  put(path, after)
  await git('add', 'settings.txt')
  await commit('Change settings')
  assert.equal(await git('show', 'HEAD:settings.txt'), 'new\nline\n')
  const turn = finishEdits(io, capture)
  await turn.after
  put(path, 'later\r\n')

  const [file] = await editedFiles(io, turn)
  assert.equal(file?.path, 'settings.txt')
  assert.equal(editorSides({ file: file! })?.after, after)
})

test('a missing integrated CLI falls back to EDITOR and returns the patch path if it fails', async () => {
  const { calls, files, io } = opener({ TERM_PROGRAM: 'windsurf', EDITOR: 'custom-editor' }, () => false)
  const file = edited('README.md', [hunk(1, 'raw', 'jsonl')])
  const path = '/temp/related-edits.diff'
  assert.equal(await openRelatedFiles(io, '/temp', [{ file }]), path)
  assert.deepEqual(calls, [['windsurf', '--diff', '/temp/before/README.md', '/temp/after/README.md'], ['custom-editor', path]])
  assert.match(files.get(path)!, /-raw\n\+jsonl/)
})

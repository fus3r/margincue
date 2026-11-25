// The project index against real git and ripgrep processes, so CI checks paths and output on
// macOS, Linux and Windows (ripgrep writes backslashes there; the index must not).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './ts-resolve.ts'

const { collectVocabulary } = await import('../mods/claude-code/hooks/repo-index')

/** The engine's `$.process.run`, as far as the index uses it. */
const $ = {
  process: {
    run: async (argv: string[], options: { cwd: string }) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: options.cwd, encoding: 'utf8', maxBuffer: 32 << 20 })
      if (r.error) throw r.error
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
    },
  },
} as never

const has = (command: string) => !spawnSync(command, ['--version']).error

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'margincue-index-'))
  mkdirSync(join(root, 'src', 'zones'), { recursive: true })
  writeFileSync(join(root, 'src', 'zones', 'market.ts'),
    'export const ZONES = ["South of Market", "Produce Market"]\nexport function stuckTime(run: string) { return run }\n')
  writeFileSync(join(root, 'package.json'), '{\n  "dependencies": {\n    "react": "^19.0.0"\n  }\n}\n')
  return root
}

async function check(root: string) {
  const vocab = (await collectVocabulary($, root))!
  assert.ok(vocab, 'an index')
  assert.ok(vocab.files.includes('src/zones/market.ts'), `forward slashes: ${vocab.files.join(', ')}`)
  const stuck = vocab.entries.find((entry) => entry.name === 'stuckTime')
  assert.equal(vocab.files[stuck?.files[0] ?? -1], 'src/zones/market.ts')
  assert.ok(vocab.entries.some((entry) => entry.name === 'South of Market'), 'a quoted display name')
  assert.ok(vocab.project?.startsWith('margincue-index-'), 'the project name from the folder')
}

test('a git project is indexed with forward-slash paths, new files included', { skip: !has('git') && 'no git' }, async () => {
  const root = project()
  try {
    spawnSync('git', ['init', '-q'], { cwd: root })
    await check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a folder outside git is indexed through ripgrep, with the same paths', { skip: !has('rg') && 'no ripgrep' }, async () => {
  const root = project()
  try {
    await check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the home folder and a drive root are not indexed: nothing walks the whole disk', async () => {
  const home = project()
  try {
    const ran: string[] = []
    const engine = (env: Record<string, string>) => ({
      env: { get: async (name: string) => env[name] },
      process: { run: async (argv: string[]) => {
        ran.push(argv.join(' '))
        return { exitCode: 1, stdout: '', stderr: '' }
      } },
    }) as never
    assert.equal(await collectVocabulary(engine({ HOME: home }), home), null)
    assert.equal(await collectVocabulary(engine({ HOME: home }), `${home}/`), null)
    // Windows has no HOME, only USERPROFILE, and writes its paths with backslashes.
    assert.equal(await collectVocabulary(engine({ USERPROFILE: 'C:\\Users\\Maya' }), 'C:\\Users\\Maya\\'), null)
    assert.equal(await collectVocabulary(engine({ HOME: home }), '/'), null)
    assert.equal(await collectVocabulary(engine({ HOME: home }), 'D:\\'), null)
    assert.deepEqual(ran, [])
    // A project inside the home folder is still indexed.
    await collectVocabulary(engine({ HOME: home }), join(home, 'src'))
    assert.ok(ran.length > 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

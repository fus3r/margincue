// Collects the project's names for grounding: file paths, declared names and
// quoted display names, in three git calls run in the background. Nothing
// here runs on a keystroke; the core indexes the result once.

import { buildVocabulary } from '../core/grounding'
import type { Vocabulary } from '../core/grounding'
import { countLibraries } from '../core/project'

type IndexEngine = {
  env: { get: (name: string) => Promise<string | undefined> }
  process: {
    run: (argv: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number | null; stdout: string }>
  }
}

const SOURCES = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.rs', '*.go', '*.java', '*.kt', '*.swift',
  '*.c', '*.h', '*.cc', '*.cpp', '*.hpp', '*.cs', '*.rb', '*.php', '*.lua', '*.gd', '*.vue', '*.svelte', '*.scala', '*.dart']
const EXCLUDE = [':!**/node_modules/**', ':!**/dist/**', ':!**/build/**', ':!**/vendor/**', ':!**/*.min.js']
const RG_EXCLUDE = ['!**/node_modules/**', '!**/dist/**', '!**/build/**', '!**/vendor/**', '!**/*.min.js', '!**/target/**', '!**/.venv/**']

/** Top-level declarations in most languages (POSIX classes: git grep -E has no \s). */
const DECLARATIONS = [
  '^(export[[:space:]]+)?(default[[:space:]]+)?(declare[[:space:]]+)?(abstract[[:space:]]+)?(async[[:space:]]+)?' +
    '(pub(\\([a-z]+\\))?[[:space:]]+)?(class|interface|type|enum|function|const|let|var|def|fn|struct|trait|func|module|object|protocol)' +
    '[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*',
  '^[[:space:]]*((public|private|internal|protected|static|sealed|abstract|partial|final|open|data)[[:space:]]+)*' +
    '(class|interface|struct|enum|record)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*',
]
/** Quoted names people say out loud: 'South of Market', "Maya", 'Space'. */
const NAMES = '["\'`][A-Z][A-Za-z0-9]+([ -][A-Za-z0-9]+){0,4}["\'`]'
/** What a project imports (Python, notebooks, JavaScript) and declares (requirements, package.json): which field it is in. */
const IMPORTS = ['^(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*', '"(import|from) [A-Za-z_][A-Za-z0-9_]*',
  '(from[[:space:]]+|require\\()[\'"][@A-Za-z0-9_./-]+[\'"]']
const IMPORT_FILES = ['*.py', '*.ipynb', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs']
const DECLARED = ['^[A-Za-z][A-Za-z0-9_.-]*', '^[[:space:]]*"[A-Za-z][A-Za-z0-9_.-]*', '^[[:space:]]*-[[:space:]]+[A-Za-z][A-Za-z0-9_.-]*',
  '"@?[a-z0-9][a-z0-9._/-]*"[[:space:]]*:[[:space:]]*"[~^]?[0-9]']
const DECLARED_FILES = ['requirements*.txt', '*/requirements*.txt', 'pyproject.toml', 'package.json', 'environment.yml']

export async function collectVocabulary($: IndexEngine, root: string): Promise<Vocabulary | null> {
  if (await tooBroad($, root)) return null
  const vocab = await fromGit($, root) ?? await fromRipgrep($, root)
  const project = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return vocab && project ? { ...vocab, project } : vocab
}

/**
 * A session started in the home folder or at a drive's root is not a project: listing and searching it walks the
 * whole disk (every reading after a turn too) and opens folders the system guards. Such a folder gets no index.
 * The home folder comes from the engine (Claude Code), else from the process (Codex).
 */
async function tooBroad($: IndexEngine, root: string): Promise<boolean> {
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const at = norm(root)
  if (/^(?:[a-z]:)?$/.test(at)) return true
  let home: string | undefined
  try {
    home = await $.env.get('HOME') ?? await $.env.get('USERPROFILE')
  } catch {
    // A host can refuse the environment lookup. On Node, the process can supply it.
    const own = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    home = own?.['HOME'] ?? own?.['USERPROFILE']
  }
  return Boolean(home) && norm(home!) === at
}

async function fromGit($: IndexEngine, root: string): Promise<Vocabulary | null> {
  const git = (args: string[]) => $.process.run(['git', '-C', root, ...args], { cwd: root, timeoutMs: 20000 })
  const listed = await git(['ls-files', '--cached', '--others', '--exclude-standard']).catch(() => null)
  if (!listed || listed.exitCode !== 0) return null
  const files = listed.stdout.split(/\r?\n/).filter(Boolean).slice(0, 80000)
  if (!files.length) return null
  const grep = (patterns: string[], most: number) =>
    // --untracked: a file made this session, not yet added, is part of the project too.
    git(['grep', '--untracked', '-I', '-n', '-o', `--max-count=${most}`, '-E', ...patterns.flatMap((p) => ['-e', p]), '--', ...SOURCES, ...EXCLUDE])
      .then((r) => r.stdout).catch(() => '')
  const quiet = (patterns: string[], paths: string[]) =>
    git(['grep', '--untracked', '-h', '-I', '-o', '--max-count=60', '-E', ...patterns.flatMap((p) => ['-e', p]), '--', ...paths, ...EXCLUDE])
      .then((r) => r.stdout).catch(() => '')
  const [declarations, names, imports, declared] = await Promise.all([
    grep(DECLARATIONS, 200), grep([NAMES], 100), quiet(IMPORTS, IMPORT_FILES), quiet(DECLARED, DECLARED_FILES)])
  return { ...buildVocabulary({ files, declarations, names }), libs: countLibraries(`${imports}\n${declared}`) }
}

/** `path:line:match` lines with the path's backslashes made forward slashes, the match left alone. */
function slashed(output: string): string {
  return output.split(/\r?\n/).map((line) => {
    const at = line.search(/:\d+:/)
    return at > 0 ? line.slice(0, at).replace(/\\/g, '/') + line.slice(at) : line
  }).join('\n')
}

/** A folder that is not a git work tree: ripgrep, when installed, honours its .gitignore all the same. */
async function fromRipgrep($: IndexEngine, root: string): Promise<Vocabulary | null> {
  const globs = [...SOURCES.flatMap((glob) => ['-g', glob]), ...RG_EXCLUDE.flatMap((glob) => ['-g', glob])]
  // The '.' matters: with no path, ripgrep searches its stdin whenever that is a pipe, and finds nothing.
  const rg = (args: string[]) => $.process.run(['rg', '--no-require-git', '--no-messages', ...args, '.'], { cwd: root, timeoutMs: 20000 })
  const listed = await rg(['--files', '--max-depth', '12', ...RG_EXCLUDE.flatMap((glob) => ['-g', glob])]).catch(() => null)
  if (!listed || listed.exitCode !== 0) return null
  // On Windows ripgrep writes backslashes; the index speaks forward slashes, as git does everywhere.
  const files = listed.stdout.split(/\r?\n/).filter(Boolean).map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')).slice(0, 80000)
  if (!files.length) return null
  const grep = (patterns: string[], most: number) =>
    // ripgrep skips binary files by itself; its -I would drop the file names.
    rg(['--with-filename', '-n', '-o', '--no-heading', '--max-count', String(most), ...patterns.flatMap((p) => ['-e', p]), ...globs])
      .then((r) => slashed(r.stdout).replace(/^\.\//gm, '')).catch(() => '')
  const quiet = (patterns: string[], paths: string[]) =>
    rg(['--no-filename', '-o', '--max-count', '60', ...patterns.flatMap((p) => ['-e', p]), ...paths.flatMap((glob) => ['-g', glob]),
      ...RG_EXCLUDE.flatMap((glob) => ['-g', glob])]).then((r) => r.stdout).catch(() => '')
  // (--no-filename output has no paths to clean; the others lose the './' that the explicit '.' adds.)
  const [declarations, names, imports, declared] = await Promise.all([
    grep(DECLARATIONS, 200), grep([NAMES], 100), quiet(IMPORTS, IMPORT_FILES), quiet(DECLARED, DECLARED_FILES)])
  return { ...buildVocabulary({ files, declarations, names }), libs: countLibraries(`${imports}\n${declared}`) }
}

/** Search the indexed source files for uses of a name declared in an edited file. */
export async function referencedNames($: IndexEngine, root: string, vocab: Vocabulary, paths: ReadonlySet<string>): Promise<Map<string, string>> {
  const definitions = new Map<string, Set<string>>()
  for (const entry of vocab.entries) {
    if (entry.kind !== 'symbol' || !/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(entry.name)) continue
    const files = entry.files.map((id) => vocab.files[id]!)
    if (files.length === 1 && paths.has(files[0]!)) definitions.set(entry.name, new Set(files))
  }
  if (!definitions.size) return new Map()
  const args = [...definitions.keys()].flatMap((name) => ['-e', name])
  const options = { cwd: root, timeoutMs: 5000 }
  let found = await $.process.run(['git', '-C', root, 'grep', '--untracked', '-I', '-n', '-w', '-F',
    ...args, '--', ...SOURCES, ...EXCLUDE], options).catch(() => null)
  if (!found || found.exitCode === null || found.exitCode > 1) {
    found = await $.process.run(['rg', '--no-require-git', '--with-filename', '-n', '-w', '-F',
      ...args, ...SOURCES.flatMap((glob) => ['-g', glob]), ...RG_EXCLUDE.flatMap((glob) => ['-g', glob]), '.'], options).catch(() => null)
  }
  const indexed = new Set(vocab.files)
  const used = new Set<string>()
  for (const line of slashed(found?.stdout ?? '').split('\n')) {
    const match = /^(?:\.\/)?(.+?):\d+:(.*)$/.exec(line)
    if (!match || !indexed.has(match[1]!) || /^\s*(?:\/\/|\/\*|\*|#|--)/.test(match[2]!)) continue
    const code = match[2]!.replace(/["'`][^"'`]*["'`]/g, '').split(/\s(?:\/\/|#|--)/, 1)[0]!
    for (const word of code.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (definitions.has(word) && !definitions.get(word)!.has(match[1]!)) used.add(word)
    }
  }
  const result = new Map<string, string>()
  for (const [name, files] of definitions) if (used.has(name)) {
    for (const file of files) if (paths.has(file) && !result.has(file)) result.set(file, name)
  }
  return result
}

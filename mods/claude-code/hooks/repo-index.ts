// Collects the project's names for grounding: file paths, declared names and
// quoted display names, in three git calls run in the background. Nothing
// here runs on a keystroke; the core indexes the result once.

import type { EngineInterface } from 'claude-code'
import { buildVocabulary } from '../core/grounding'
import type { Vocabulary } from '../core/grounding'
import { countLibraries } from '../core/project'

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

export async function collectVocabulary($: EngineInterface, root: string): Promise<Vocabulary | null> {
  const vocab = await fromGit($, root) ?? await fromRipgrep($, root)
  const project = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return vocab && project ? { ...vocab, project } : vocab
}

async function fromGit($: EngineInterface, root: string): Promise<Vocabulary | null> {
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
async function fromRipgrep($: EngineInterface, root: string): Promise<Vocabulary | null> {
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

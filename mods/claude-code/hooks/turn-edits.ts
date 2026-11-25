import type { EngineInterface } from 'claude-code'

type CaptureIO = Pick<EngineInterface, 'process' | 'fs'>
type Version = { mode?: string; text?: string; stamp?: string; blob?: true } | null // null is a missing file
type Snapshot = { root: string; head: string | null; saved: Map<string, Version>; headPaths: string[] }
type CheckoutDefaults = { autocrlf?: string; textCrlf: boolean }

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
type ToolEdit = { path: string; position: number; before: Version; after: Promise<Version>; hunks: Hunk[] }
export type ChoiceMark = { position: number; words: string; choice: string }
export type EditCapture = {
  cwd: string; root: Promise<string | null>; before: Promise<Snapshot | null>; tools: ToolEdit[]; marks: Map<string, ChoiceMark>; position: number
}
export type TurnEdits = EditCapture & { after: Promise<Snapshot | null> }
export type EditedFile = {
  path: string; before: Version; after: Version; tools: ToolEdit[]; hunks: Hunk[]
}

const FILE_LIMIT = 4 * 1024 * 1024 // the host's read and write limit
const SNAPSHOT_LIMIT = 8 * 1024 * 1024
function git($: CaptureIO, cwd: string, args: string[]) {
  return $.process.run(['git', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
    { cwd, timeoutMs: 5000 })
}
const parts = (text: string) => text.split('\0').filter(Boolean)
const plainText = (text: unknown): string | undefined =>
  typeof text === 'string' && text.length <= FILE_LIMIT && !text.includes('\0') && !text.includes('\ufffd') ? text : undefined
export const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n')

function safePath(path: string): boolean {
  return path !== '' && !path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
}

/** Resolve a tool's path under the project, keeping Git's slash-separated spelling. */
function relativePath(path: string, cwd: string, root: string): string | undefined {
  const windows = /^[a-z]:/i.test(cwd)
  const slash = (value: string) => windows ? value.replace(/\\/g, '/') : value
  const given = slash(path)
  const absolute = /^(?:[a-z]:)?\//i.test(given) ? given : `${slash(cwd).replace(/\/$/, '')}/${given}`
  const resolved: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '..') resolved.pop()
    else if (part !== '.') resolved.push(part)
  }
  const full = resolved.join('/')
  const prefix = `${slash(root).replace(/\/$/, '')}/`
  const inside = windows ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix)
  const local = full.slice(prefix.length)
  return inside && safePath(local) ? local : undefined
}

async function workingVersion($: CaptureIO, root: string, path: string, mode = '100644', limit = FILE_LIMIT): Promise<Version> {
  const full = `${root}/${path}`
  try {
    const stat = await $.fs.stat(full, { resolve: true })
    const stamp = `${stat.size}:${stat.mtimeMs}`
    if (stat.isLink || stat.kind !== 'file' || stat.size > Math.min(limit, FILE_LIMIT) ||
        !stat.realPath || !relativePath(stat.realPath, root, root)) return { mode, stamp }
    return { mode, stamp, text: plainText(await $.fs.read(full)) }
  } catch (error) {
    return /ENOENT$/.test(error instanceof Error ? error.message : '') ? null : { mode }
  }
}

async function gitRoot($: CaptureIO, cwd: string): Promise<string | null> {
  const found = await git($, cwd, ['rev-parse', '--show-toplevel']).catch(() => null)
  return found?.exitCode === 0 && found.stdout.trim() ? found.stdout.replace(/\r?\n$/, '') : null
}

async function headChanges($: CaptureIO, project: string, before: string | null, after: string | null): Promise<string[]> {
  if (before === after) return []
  const args = before && after ? ['diff', '--name-only', '-z', '--no-renames', before, after, '--']
    : ['ls-tree', '-r', '--name-only', '-z', (before ?? after)!]
  const changed = await git($, project, args).catch(() => null)
  return changed?.exitCode === 0 && !changed.isStdoutTruncated ? parts(changed.stdout) : []
}

/** Save working copies for changed paths. Other tracked files can be read from the saved revision. */
async function gitSnapshot($: CaptureIO, project: string, start?: Promise<Snapshot | null>): Promise<Snapshot | null> {
  try {
    const revision = await git($, project, ['rev-parse', '--verify', 'HEAD'])
    const head = revision.exitCode === 0 ? revision.stdout.trim() : null
    const [changed, untracked] = await Promise.all([
      head ? git($, project, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', head, '--'])
        : git($, project, ['ls-files', '--cached', '-z']),
      git($, project, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    if ([changed, untracked].some((result) => result.exitCode !== 0 || result.isStdoutTruncated)) return null
    const modes = new Map<string, string | undefined>()
    const tracked = parts(changed.stdout)
    if (head) {
      for (let i = 0; i + 1 < tracked.length; i += 2) {
        const mode = /^:\d{6} (\d{6}) /.exec(tracked[i]!)?.[1]
        if (mode) modes.set(tracked[i + 1]!, mode)
      }
    } else {
      for (const path of tracked) modes.set(path, '100644')
    }
    for (const path of parts(untracked.stdout)) modes.set(path, '100644')
    const previous = await start
    const headPaths = previous ? await headChanges($, project, previous.head, head) : []
    // A commit or revert can leave changed files clean at the end of the turn.
    for (const path of [...previous?.saved.keys() ?? [], ...headPaths]) if (!modes.has(path)) modes.set(path, undefined)
    const saved = new Map<string, Version>()
    let budget = SNAPSHOT_LIMIT
    // Small batches let other host work proceed, even with a large untracked directory.
    const files = [...modes].filter(([path]) => safePath(path))
    for (let i = 0; i < files.length; i += 8) {
      const versions = await Promise.all(files.slice(i, i + 8).map(async ([path, mode]) => {
        if (mode === undefined) return [path, budget > 0 ? await cleanWorkingVersion($, project, head, path, budget) : undefined] as const
        const version = mode === '000000' ? null : budget > 0 ? await workingVersion($, project, path, mode, budget) : { mode }
        return [path, version] as const
      }))
      for (const [path, version] of versions) {
        if (version === undefined) continue
        const size = version?.text?.length ?? 0
        if (size > budget && modes.get(path) === undefined) continue
        saved.set(path, size > budget ? { mode: version?.mode, stamp: version?.stamp } : version)
        budget = Math.max(0, budget - size)
      }
    }
    return { root: project, head, saved, headPaths }
  } catch {
    return null
  }
}

export function startEdits($: CaptureIO, cwd: string): EditCapture {
  const root = gitRoot($, cwd)
  return { cwd, root, before: root.then((project) => project ? gitSnapshot($, project) : null), tools: [], marks: new Map(), position: 0 }
}

export function finishEdits($: CaptureIO, turn: EditCapture): TurnEdits {
  return { ...turn, after: turn.root.then((project) => project ? gitSnapshot($, project, turn.before) : null) }
}

/** Observe successful native edits using the result the host already produced. */
export function recordToolEdit($: CaptureIO, turn: EditCapture, path: unknown, position: number, result: unknown): void {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  if (record.staged === true) return
  const file = typeof record.filePath === 'string' ? record.filePath : path
  if (typeof file !== 'string') return
  const original = plainText(record.originalFile)
  const content = plainText(record.content)
  const hunks = Array.isArray(record.structuredPatch) ? record.structuredPatch.filter(isHunk).map((hunk) => ({
    ...hunk, lines: hunk.lines.map((line, i) => hunk.lines[i + 1]?.startsWith('\\') ? line : line.replace(/\r$/, '')),
  })) : []
  const oldVersion = record.type === 'create' ? null : { mode: '100644', text: original }
  // A Write result has both sides already. Edit's display patch can expand tabs, so read the exact bytes as text.
  const local = relativePath(file, turn.cwd, turn.cwd)
  const after = content !== undefined ? Promise.resolve({ mode: '100644', text: content })
    : local ? workingVersion($, turn.cwd, local) : Promise.resolve({})
  turn.tools.push({ path: file, position, before: oldVersion, after, hunks })
}

function isHunk(value: unknown): value is Hunk {
  if (typeof value !== 'object' || !value) return false
  const hunk = value as Hunk
  return [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isSafeInteger) &&
    Array.isArray(hunk.lines) && hunk.lines.every((line) => typeof line === 'string')
}

async function blobVersion($: CaptureIO, root: string, head: string | null, path: string): Promise<Version> {
  if (!head) return null
  const entry = await git($, root, ['ls-tree', '-z', head, '--', path])
  if (entry.exitCode !== 0) return {}
  const [, mode, oid] = /^(\d{6}) blob ([a-f0-9]+)\t/.exec(entry.stdout) ?? []
  if (!mode || !oid) return entry.stdout ? {} : null
  const blob = await git($, root, ['cat-file', 'blob', oid])
  return { mode, text: blob.exitCode === 0 && !blob.isStdoutTruncated ? plainText(blob.stdout) : undefined, blob: true }
}

async function cleanWorkingVersion($: CaptureIO, root: string, head: string | null, path: string, limit: number): Promise<Version | undefined> {
  const blob = await blobVersion($, root, head, path).catch(() => null)
  if (!blob?.mode || blob.text === undefined) return undefined
  const working = await workingVersion($, root, path, blob.mode, limit)
  // The working file can change between Git's status check and the read.
  return working?.text !== undefined && normalizeLineEndings(working.text) === normalizeLineEndings(blob.text) ? working : undefined
}

async function version($: CaptureIO, snapshot: Snapshot, path: string): Promise<Version> {
  return snapshot.saved.has(path) ? snapshot.saved.get(path)! : blobVersion($, snapshot.root, snapshot.head, path)
}

async function checkoutDefaults($: CaptureIO, root: string): Promise<CheckoutDefaults> {
  const [autocrlf, eol] = await Promise.all([
    git($, root, ['config', '--type=bool-or-str', '--get', 'core.autocrlf']).catch(() => null),
    git($, root, ['config', '--get', 'core.eol']).catch(() => null),
  ])
  const lineEnding = eol?.stdout.trim().toLowerCase() || 'native'
  return { autocrlf: autocrlf?.stdout.trim().toLowerCase(), textCrlf: lineEnding === 'crlf' || (lineEnding === 'native' && /^[a-z]:/i.test(root)) }
}

/** Restore the checkout endings for an LF blob using Git's text attributes. */
async function checkoutText($: CaptureIO, root: string, path: string, text: string, defaults: CheckoutDefaults): Promise<string> {
  const result = await git($, root, ['check-attr', '-z', 'text', 'eol', '--', path]).catch(() => null)
  if (result?.exitCode !== 0) return text
  const [, , attr, , , ending] = result.stdout.split('\0')
  if (attr === 'unset' || ending === 'lf') return text
  const crlf = ending === 'crlf' || defaults.autocrlf === 'true' ||
    (defaults.autocrlf !== 'input' && defaults.textCrlf && (attr === 'set' || attr === 'auto'))
  return crlf ? text.replaceAll('\n', '\r\n') : text
}

/** Compare the two boundaries, so pre-existing edits and edits in later turns stay out of the receipt. */
export async function editedFiles($: CaptureIO, turn: TurnEdits): Promise<EditedFile[]> {
  const [before, after] = await Promise.all([turn.before, turn.after])
  const tools = new Map<string, ToolEdit[]>()
  for (const edit of turn.tools) {
    const path = relativePath(edit.path, turn.cwd, before?.root ?? turn.cwd)
    if (path) tools.set(path, [...(tools.get(path) ?? []), edit])
  }
  const paths = new Set([...tools.keys(), ...before?.saved.keys() ?? [], ...after?.saved.keys() ?? [], ...after?.headPaths ?? []])
  let defaults: Promise<CheckoutDefaults> | undefined
  const files: EditedFile[] = []
  const listed = [...paths].filter(safePath).sort()
  for (let i = 0; i < listed.length; i += 8) {
    await Promise.all(listed.slice(i, i + 8).map(async (path) => {
      const observed = tools.get(path)?.sort((a, b) => a.position - b.position) ?? []
      let left: Version = null
      let right: Version = null
      if (before && after) {
        [left, right] = await Promise.all([version($, before, path), version($, after, path)]).catch(() => [{}, {}])
      }
      if (observed.length && (!before || !after || (left === null && right === null))) {
        left = observed[0]!.before
        right = await observed.at(-1)!.after
      }
      if (left === null && right === null) return
      if (left && right && left.mode === right.mode && (left.text !== undefined && right.text !== undefined
        ? normalizeLineEndings(left.text) === normalizeLineEndings(right.text) : left.stamp !== undefined && left.stamp === right.stamp)) return
      if (before && left?.blob && left.text?.includes('\n') && !left.text.includes('\r')) {
        const original = observed[0]?.before?.text
        const text = original !== undefined && normalizeLineEndings(original) === left.text ? original
          : await checkoutText($, before.root, path, left.text, await (defaults ??= checkoutDefaults($, before.root)))
        left = { ...left, text }
      }
      files.push({ path, before: left, after: right, tools: observed, hunks: [] })
    }))
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

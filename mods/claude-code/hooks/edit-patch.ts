import type { EngineInterface } from 'claude-code'
import { normalizeLineEndings } from './turn-edits'
import type { EditedFile, Hunk } from './turn-edits'

type PatchIO = Pick<EngineInterface, 'process' | 'fs'>
export type RelatedFile = { file: EditedFile; hunks?: Hunk[] }

export const sidePath = (dir: string, side: 'before' | 'after', path: string): string => `${dir}/${side}/${path}`
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const sideText = (side: EditedFile['before']): string | undefined => side === null ? '' : side.text
const lineOffset = (start: number, count: number): number => start - (count ? 1 : 0)

function wholeHunk(before: string, after: string): Hunk | undefined {
  if (before === after) return undefined
  const old = linesOf(before)
  const next = linesOf(after)
  const marked = (lines: string[], prefix: string) => lines.flatMap((line) => line.endsWith('\n')
    ? [prefix + line.slice(0, -1)] : [prefix + line, '\\ No newline at end of file'])
  return { oldStart: old.length ? 1 : 0, oldLines: old.length, newStart: next.length ? 1 : 0, newLines: next.length,
    lines: [...marked(old, '-'), ...marked(next, '+')] }
}

export function parseHunks(patch: string): Hunk[] {
  const result: Hunk[] = []
  let hunk: Hunk | undefined
  for (const line of patch.split('\n')) {
    const begin = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (begin) {
      const [, oldStart, oldLines, newStart, newLines] = begin
      hunk = { oldStart: Number(oldStart), oldLines: Number(oldLines ?? 1), newStart: Number(newStart), newLines: Number(newLines ?? 1), lines: [] }
      result.push(hunk)
    } else if (hunk && /^[ +-]|^\\ No newline/.test(line)) hunk.lines.push(line)
  }
  return result
}

/** Match hunk text in LF and take any added lines from their saved side. */
function applyHunks(before: string, hunks: readonly Hunk[], after: string): string | undefined {
  const old = linesOf(before)
  const next = linesOf(after)
  const out: string[] = []
  let at = 0
  for (const hunk of hunks) {
    const start = lineOffset(hunk.oldStart, hunk.oldLines)
    if (start < at || start > old.length) return undefined
    out.push(old.slice(at, start).join(''))
    at = start
    let to = lineOffset(hunk.newStart, hunk.newLines)
    for (const [i, line] of hunk.lines.entries()) {
      const kind = line[0]
      if (kind === '\\') continue
      const content = line.slice(1) + (hunk.lines[i + 1]?.startsWith('\\') ? '' : '\n')
      const source = kind === '+' ? next[to] : old[at++]
      if (source === undefined || normalizeLineEndings(source) !== content) return undefined
      if (kind !== '-') {
        out.push(source)
        to++
      }
    }
  }
  out.push(old.slice(at).join(''))
  return out.join('')
}

export async function readHunks($: PatchIO, dir: string, file: EditedFile): Promise<void> {
  const before = sideText(file.before)
  const after = sideText(file.after)
  if (before === undefined || after === undefined) return
  const leftText = normalizeLineEndings(before)
  const rightText = normalizeLineEndings(after)
  if (leftText === rightText) return
  if (file.before === null || file.after === null) {
    file.hunks = [wholeHunk(leftText, rightText)!]
    return
  }
  const native = file.tools.length === 1 ? file.tools[0]!.hunks : []
  const replayed = native.length ? applyHunks(before, native, after) : undefined
  if (replayed !== undefined && normalizeLineEndings(replayed) === rightText) {
    file.hunks = native
    return
  }
  // Git's text diff works outside a repository too. Both operands are private copies.
  const left = sidePath(`${dir}/compare`, 'before', file.path)
  const right = sidePath(`${dir}/compare`, 'after', file.path)
  try {
    await Promise.all([$.fs.write(left, leftText), $.fs.write(right, rightText)])
    const result = await $.process.run(['git', '-c', 'diff.algorithm=myers', '--no-pager', 'diff', '--no-index',
      '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', left, right], { cwd: dir, timeoutMs: 5000 })
    if (result.exitCode === 1 && !result.isStdoutTruncated) file.hunks = parseHunks(result.stdout)
  } catch {
    // The file remains available when no text diff can be generated.
  }
}

export function editorSides(related: RelatedFile): { before: string; after: string } | undefined {
  const before = sideText(related.file.before)
  const after = sideText(related.file.after)
  if (before === undefined || after === undefined) return undefined
  const selected = related.hunks
  if (!selected || selected.length === related.file.hunks.length) return { before, after }

  // Start from the saved working file, so retained lines keep their exact endings.
  const omitted = related.file.hunks.filter((hunk) => !selected.includes(hunk)).map((hunk) => ({
    oldStart: hunk.newStart, oldLines: hunk.newLines, newStart: hunk.oldStart, newLines: hunk.oldLines,
    lines: hunk.lines.map((line) => line.startsWith('+') ? '-' + line.slice(1) : line.startsWith('-') ? '+' + line.slice(1) : line),
  }))
  const eol = after.match(/\r?\n/)?.[0]
  const text = applyHunks(after, omitted, eol ? before.replace(/\r?\n/g, eol) : before)
  return text === undefined ? undefined : { before, after: text }
}

function patchPath(prefix: string, path: string): string {
  const name = `${prefix}/${path}`
  return /[\s"\\]/.test(name) ? JSON.stringify(name) : name
}

/** A patch whose new-side line numbers account for any hunks left out. */
export function relatedPatch(related: readonly RelatedFile[]): string {
  return related.map(({ file, hunks }) => {
    const a = patchPath('a', file.path)
    const b = patchPath('b', file.path)
    const header = [`diff --git ${a} ${b}`]
    if (file.before === null) header.push(`new file mode ${file.after?.mode ?? '100644'}`)
    else if (file.after === null) header.push(`deleted file mode ${file.before.mode ?? '100644'}`)
    else if (file.before.mode && file.after.mode && file.before.mode !== file.after.mode) {
      header.push(`old mode ${file.before.mode}`, `new mode ${file.after.mode}`)
    }
    const before = sideText(file.before)
    const after = sideText(file.after)
    if (before === undefined || after === undefined) return [...header, `File contents unavailable for ${JSON.stringify(file.path)}`, ''].join('\n')
    const whole = file.hunks.length ? undefined : wholeHunk(normalizeLineEndings(before), normalizeLineEndings(after))
    const selected = hunks ?? (whole ? [whole] : file.hunks)
    if (!selected.length) return [...header, ''].join('\n')
    const old = linesOf(before)
    const next = linesOf(after)
    let delta = 0
    const body = selected.flatMap((hunk) => {
      const newStart = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0) + delta - (hunk.newLines === 0 ? 1 : 0)
      delta += hunk.newLines - hunk.oldLines
      let from = lineOffset(hunk.oldStart, hunk.oldLines)
      let to = lineOffset(hunk.newStart, hunk.newLines)
      const lines = hunk.lines.map((line) => {
        const kind = line[0]
        if (kind === '\\') return line
        const left = kind === '+' ? undefined : old[from++]
        const right = kind === '-' ? undefined : next[to++]
        const text = left ?? right
        return text === undefined ? line : kind + text.replace(/\n$/, '')
      })
      return [`@@ -${hunk.oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`, ...lines]
    })
    return [...header, `--- ${file.before === null ? '/dev/null' : a}`, `+++ ${file.after === null ? '/dev/null' : b}`, ...body, ''].join('\n')
  }).join('')
}

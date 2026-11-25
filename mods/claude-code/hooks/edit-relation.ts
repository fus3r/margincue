import type { ChoiceMark, EditedFile, Hunk } from './turn-edits'
import type { RelatedFile } from './edit-patch'

export type ReceiptChoice = { label: string; value?: string; mark?: ChoiceMark; nextMark?: number }
type Candidate = { id: number; file: EditedFile; hunk: Hunk; nearby: boolean }
type ReadInput = { choice: string; hunks: { id: number; path: string; before: number; after: number; changes?: string }[] }
export type ReadRelation = (input: ReadInput) => Promise<number[]>

const STOP = new Set('add adjust after all and another are before build change code file files from have into keep make one only per set that the their them these this those use used using was were what which will with without write'.split(' '))
const tokens = (text: string): Set<string> => new Set((text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !STOP.has(word)))
const changed = (hunk: Hunk): string[] => hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-'))
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasPath = (text: string, path: string) => new RegExp(`(?:^|[^\\w.-])${escaped(path)}(?=$|[^\\w./-]|\\.(?:\\s|$))`, 'i').test(text)

function namedFiles(files: readonly EditedFile[], words: string): Set<EditedFile> {
  const names = files.map((file) => file.path.split('/').at(-1)!)
  return new Set(files.filter((file, index) => hasPath(words, file.path) ||
    (names.indexOf(names[index]!) === names.lastIndexOf(names[index]!) && hasPath(words, names[index]!))))
}

function nearbyEdits(file: EditedFile, choice: ReceiptChoice) {
  const start = choice.mark?.position
  const end = choice.nextMark ?? Infinity
  return start === undefined ? [] : file.tools.filter((edit) => start < edit.position && edit.position < end)
}

/** Return the edits the wording and edit order support, with one optional reading of ambiguous candidates. */
export async function relateEdits(files: readonly EditedFile[], choice: ReceiptChoice, read: ReadRelation): Promise<RelatedFile[]> {
  if (!files.length) return []
  const statement = [choice.label, choice.value].filter(Boolean).join(' ')
  const context = `${statement} ${choice.mark?.words ?? ''}`
  const named = namedFiles(files, context)
  const terms = tokens(statement.replace(/\S+\.[a-z0-9]{1,8}(?=[\s`),.;]|$)/gi, ' '))
  const values = tokens(choice.value ?? '')
  const symbols = [...context.matchAll(/`([\w$-]+)`/g)].map((match) => match[1]!.toLowerCase())
  const direct = new Set<Candidate>()
  const candidates: Candidate[] = []
  const nearby = new Set<EditedFile>()
  for (const file of files) {
    const edits = nearbyEdits(file, choice)
    if (edits.length) nearby.add(file)
    const toolLines = new Set(edits.flatMap((edit) => edit.hunks.flatMap(changed)))
    for (const hunk of file.hunks) {
      const lines = changed(hunk)
      const candidate = { id: candidates.length + 1, file, hunk,
        nearby: edits.length > 0 && (!toolLines.size || lines.some((line) => toolLines.has(line))) }
      candidates.push(candidate)
      const words = tokens(lines.join('\n'))
      const hits = [...terms].filter((word) => words.has(word))
      if (hits.length >= 2 || hits.some((word) => values.has(word)) ||
          (hits.length > 0 && (named.has(file) || terms.size === 1)) ||
          symbols.some((symbol) => lines.some((line) => new RegExp(`(?:^|[^\\w$-])${escaped(symbol)}(?=$|[^\\w$-])`, 'i').test(line)))) {
        direct.add(candidate)
      }
    }
  }

  // A named file is a useful fallback when no individual hunk can be isolated.
  const selected = new Map<EditedFile, Hunk[] | undefined>([...named].map((file) => [file, undefined]))
  const add = (candidate: Candidate) => selected.set(candidate.file, [...(selected.get(candidate.file) ?? []), candidate.hunk])
  direct.forEach(add)
  const ambiguous = candidates.filter((candidate) => !direct.has(candidate) &&
    (candidate.nearby || (named.has(candidate.file) && selected.get(candidate.file)?.length)))
  const pending = ambiguous.length ? ambiguous : selected.size || nearby.size ? [] : candidates
  if (pending.length) {
    const hunks = pending.slice(0, 25).map(({ id, file, hunk, nearby }) => ({ id, path: file.path,
      before: hunk.oldStart, after: hunk.newStart,
      // Leave code out when only the filenames and ranges make a plausible connection.
      ...(nearby || named.has(file) ? { changes: changed(hunk).join('\n') } : {}),
    }))
    const input = { choice: statement, hunks }
    if (pending.length > 24 || JSON.stringify(input).length > 6000) {
      for (const { file, nearby } of pending) if (nearby || named.has(file)) selected.set(file, undefined)
    } else {
      const ids = new Set(await read(input).catch(() => []))
      for (const candidate of pending) if (ids.has(candidate.id)) add(candidate)
    }
  }
  for (const file of nearby) if (!file.hunks.length) selected.set(file, undefined)
  return files.flatMap((file) => {
    if (!selected.has(file)) return []
    const hunks = selected.get(file)
    return [{ file, hunks: hunks?.sort((a, b) => a.oldStart - b.oldStart) }]
  })
}

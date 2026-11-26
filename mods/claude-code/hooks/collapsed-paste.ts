import { diffSplice, shiftSpan, spliceFits } from '../core/anchor'
import type { Span } from '../core/anchor'
import type { Splice } from '../core/types'

/** Claude exposes the box and the writer, but no paste spans. Track placeholders written outside prompt.edit. */
export class CollapsedPaste {
  text = ''
  private spans: Span[] = []

  get pending(): boolean { return this.spans.length > 0 }

  update(text: string, cursor: number, edit?: Splice, engineWrite = false): void {
    const before = this.text
    if (text === before && (!edit || edit.start === edit.end && !edit.text)) return
    this.text = text
    // For an engine insertion or deletion, use the caret if it identifies the splice. A common-prefix diff
    // alone can put an insertion on the wrong side of identical text next to it.
    const delta = text.length - before.length
    const at = cursor - Math.max(0, delta)
    const fromCaret = { start: at, end: at + Math.max(0, -delta), text: text.slice(at, cursor) }
    const splice = edit && spliceFits(before, text, edit) ? edit
      : delta && spliceFits(before, text, fromCaret) ? fromCaret : diffSplice(before, text)
    this.spans = this.spans.flatMap((span) => shiftSpan(span, splice) ?? [])
    if (!engineWrite) return
    for (const match of splice.text.matchAll(/\[Pasted text #\d+(?: \+\d+ lines?)?\]/g)) {
      const start = splice.start + match.index
      this.spans.push({ start, end: start + match[0].length })
    }
  }

  clear(): void {
    this.text = ''
    this.spans = []
  }
}

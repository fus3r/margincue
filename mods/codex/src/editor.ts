// The composer's text: a string and a cursor, edited the way a prompt box is, and laid
// out in wrapped rows that keep each character's position (for underlines and the cursor).

import type { Splice } from '../../claude-code/core/types'
import { cells } from '../../claude-code/hooks/segments'

export type Row = { start: number; end: number }
export type Layout = { rows: Row[]; cursorRow: number; cursorCol: number }

const WORD = /[\p{L}\p{N}_]/u

export class Draft {
  text: string
  cursor: number
  /** The column the cursor keeps while moving up and down. */
  private goal: number | null = null

  constructor(text = '') {
    this.text = text
    this.cursor = text.length
  }

  /** Replaces [start, end) with `text`, leaving the cursor after it. Returns the splice, or null when nothing changed. */
  replace(start: number, end: number, text: string): Splice | null {
    if (start === end && text === '') return null
    this.text = this.text.slice(0, start) + text + this.text.slice(end)
    this.cursor = start + text.length
    this.goal = null
    return { start, end, text }
  }

  insert(text: string): Splice | null {
    return this.replace(this.cursor, this.cursor, text)
  }

  backspace(word: boolean): Splice | null {
    if (this.cursor === 0) return null
    return this.replace(word ? this.wordStart(this.cursor) : this.prevChar(this.cursor), this.cursor, '')
  }

  deleteForward(): Splice | null {
    if (this.cursor >= this.text.length) return null
    return this.replace(this.cursor, this.nextChar(this.cursor), '')
  }

  /** ctrl+u: to the start of the line. ctrl+k: to its end. */
  killLine(before: boolean): Splice | null {
    const lineStart = this.text.lastIndexOf('\n', this.cursor - 1) + 1
    const lineEnd = this.text.indexOf('\n', this.cursor) < 0 ? this.text.length : this.text.indexOf('\n', this.cursor)
    return before ? this.replace(lineStart, this.cursor, '') : this.replace(this.cursor, lineEnd, '')
  }

  move(dir: 'left' | 'right', word: boolean): void {
    this.goal = null
    if (dir === 'left') this.cursor = word ? this.wordStart(this.cursor) : this.prevChar(this.cursor)
    else this.cursor = word ? this.wordEnd(this.cursor) : this.nextChar(this.cursor)
  }

  home(): void {
    this.goal = null
    this.cursor = this.text.lastIndexOf('\n', this.cursor - 1) + 1
  }

  end(): void {
    this.goal = null
    const next = this.text.indexOf('\n', this.cursor)
    this.cursor = next < 0 ? this.text.length : next
  }

  /** Up or down one wrapped row at `width`; false at the first or last row. */
  vertical(dir: 'up' | 'down', width: number): boolean {
    const { rows, cursorRow, cursorCol } = this.layout(width)
    const target = cursorRow + (dir === 'up' ? -1 : 1)
    if (target < 0 || target >= rows.length) return false
    this.goal ??= cursorCol
    const row = rows[target]!
    let at = row.start
    let col = 0
    while (at < row.end) {
      const next = this.nextChar(at)
      const w = cells(this.text.slice(at, next))
      if (col + w > this.goal) break
      col += w
      at = next
    }
    this.cursor = at
    return true
  }

  /** Wrapped rows of at most `width` cells, breaking after spaces where it can. */
  layout(width: number): Layout {
    const rows: Row[] = []
    const room = Math.max(1, width)
    let lineStart = 0
    while (true) {
      const newline = this.text.indexOf('\n', lineStart)
      const lineEnd = newline < 0 ? this.text.length : newline
      let start = lineStart
      if (start === lineEnd) rows.push({ start, end: lineEnd })
      while (start < lineEnd) {
        let at = start
        let col = 0
        let lastSpace = -1
        while (at < lineEnd) {
          const next = this.nextChar(at)
          const w = cells(this.text.slice(at, next))
          if (col + w > room) break
          if (this.text[at] === ' ') lastSpace = next
          col += w
          at = next
        }
        const end = at < lineEnd && lastSpace > start ? lastSpace : Math.max(at, this.nextChar(start))
        rows.push({ start, end })
        start = end
      }
      if (newline < 0) break
      lineStart = newline + 1
    }
    let cursorRow = rows.length - 1
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!
      const nextStart = rows[r + 1]?.start
      if (this.cursor >= row.start && (this.cursor < row.end || nextStart === undefined || this.cursor < nextStart ||
        (this.cursor === row.end && this.text[row.end] === '\n'))) {
        cursorRow = r
        break
      }
    }
    const row = rows[cursorRow]!
    const cursorCol = cells(this.text.slice(row.start, Math.min(this.cursor, row.end)))
    return { rows, cursorRow, cursorCol }
  }

  private prevChar(at: number): number {
    if (at <= 0) return 0
    const code = this.text.charCodeAt(at - 1)
    return code >= 0xdc00 && code <= 0xdfff && at >= 2 ? at - 2 : at - 1
  }

  private nextChar(at: number): number {
    if (at >= this.text.length) return this.text.length
    const code = this.text.charCodeAt(at)
    return code >= 0xd800 && code <= 0xdbff ? at + 2 : at + 1
  }

  private wordStart(at: number): number {
    let i = at
    while (i > 0 && !WORD.test(this.text[i - 1]!)) i--
    while (i > 0 && WORD.test(this.text[i - 1]!)) i--
    return i
  }

  private wordEnd(at: number): number {
    let i = at
    while (i < this.text.length && !WORD.test(this.text[i]!)) i++
    while (i < this.text.length && WORD.test(this.text[i]!)) i++
    return i
  }
}

// What the band and the card are made of: segments laid out on terminal cells,
// so a layout can be measured and tested without a surface. register.tsx turns
// segments into Text and Button elements.

import { cells } from '../core/frame'

/** A theme key (`success`, `suggestion`, …), which follows the person's theme, or a raw colour. */
export type Color = string

export type Style = {
  dim?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: Color
  /** Background: a chip, a tag. */
  bg?: Color
}

export type Segment =
  | { kind: 'text'; text: string; style?: Style }
  | { kind: 'progress'; label: string }
  | {
      kind: 'button'; key: string; hotkey?: string; chord?: string; label: string; detail?: string
      /** What is drawn in place of the label (a chip with its padding); the label still names the control. */
      face?: string
      /** The face's style. */
      style?: Style
      dim?: boolean; bold?: true; color?: Color; primary?: true; hidden?: true; action: Action
    }

export type Action =
  | { type: 'pick'; cue: string; option: number }
  | { type: 'dismiss'; cue: string }
  | { type: 'acceptAll' }
  | { type: 'focus'; dir: 1 }
  | { type: 'cycle'; cue: string; option: number }
  | { type: 'set'; slot: string; option: string }
  | { type: 'scope'; slot: string }
  | { type: 'why'; slot: string }
  | { type: 'review' }
  | { type: 'depth' }
  | { type: 'amend'; cue: string; option: number }
  | { type: 'cardRead' }
  | { type: 'cardKeep' }
  | { type: 'cardFocus'; dir?: 1 | -1; row?: string }
  | { type: 'cardCycle'; row?: string }
  | { type: 'cardSet'; row: string; option: number }
  | { type: 'cardDismiss'; row: string }
  | Extract<import('../core/types').Event, { type: 'chapter' }>
  | { type: 'sketch'; action: 'toggle' | 'pin' | 'refresh' }
  | { type: 'receiptPick'; receipt: number; item: number; option: number }
  | { type: 'receiptLow'; receipt: number }
  | { type: 'sessionChoices' }
  | { type: 'receiptReview'; receipt: number }
  | { type: 'receiptDiff'; receipt: number; choice: number }
  /** The card shown at Enter (an app that never shows MarginCue the draft): send with what is set, or as written. */

/**
 * Engine keybinding actions whose chords press a band Button from the prompt
 * itself. A mod cannot declare actions of its own; these two are bound in the
 * Global context (alt+up/down, ctrl+up/down) and handled by the engine only
 * while its diff panel is open, so at the prompt they are free.
 */
export const CHORD_SWAP = 'app:diffFileListDown'
export const CHORD_NEXT = 'app:diffFileListUp'
export const CARD_READ_KEY = 'c'
export const CARD_KEEP_KEY = 'k'
export const CHAPTER_KEY = 'b'
export const CHAPTER_DROP_KEY = 'z'
export const CHAPTER_NEXT_KEY = 'n'
export const RECEIPT_DIFF_KEY = 'e'

/**
 * The card's colours. Tags and accents use theme keys, so they follow the
 * person's theme; the chips have no theme key and come in a dark and a light
 * set, chosen from the theme name.
 *
 * Where the terminal has no truecolor, Claude Code rounds each channel to the
 * 256-colour cube (r / 255 × 5, not to the nearest cube colour), so a channel
 * of 0x5f becomes 0x87. The raw colours below are picked to land on the
 * intended cube colour under that rule: 0x4c rounds to the cube's 0x5f and
 * 0x78 to its 0x87; 0, 0xaf, 0xd7 and 0xff stay as they are.
 */
export type Palette = {
  /** The MarginCue tag. */
  tag: Style
  /** The focused row, key names, the names found in the code. */
  accent: Color
  /** Lines of a drawing (the sketch's frame), quieter than its text. */
  frame: Color
  /** A value the person set. */
  yours: Style
  /** The value the agent would take, not set by the person. */
  suggested: Style
  /** A choice the agent made by itself during the turn. */
  agent: Style
  /** A name the code does not have; a guard. */
  attention: Color
  /** Behind the words of the prompt the focused row is about. */
  focus: Color
}

export const DARK: Palette = {
  tag: { bg: 'suggestion', color: 'inverseText', bold: true },
  accent: 'suggestion',
  frame: '#4c4c78',
  yours: { bg: '#004c00', color: '#afffaf', bold: true },
  suggested: { bg: '#4c4c78', color: '#ffffff' },
  agent: { bg: '#004c78', color: '#d7ffff', bold: true },
  attention: 'warning',
  focus: '#3a3a3a',
}

export const LIGHT: Palette = {
  tag: { bg: 'suggestion', color: 'inverseText', bold: true },
  accent: 'suggestion',
  frame: '#7878a8',
  yours: { bg: '#d7ffd7', color: '#004c00', bold: true },
  suggested: { bg: '#d7d7ff', color: '#000000' },
  agent: { bg: '#d7ffff', color: '#004c78', bold: true },
  attention: 'warning',
  focus: '#e4e4e4',
}

/** The palette for a Claude Code theme name (`dark`, `light-daltonized`, …); dark when unknown. */
export function paletteFor(theme: unknown): Palette {
  return typeof theme === 'string' && /^light/i.test(theme) ? LIGHT : DARK
}

export const text = (value: string, style?: Style): Segment => ({ kind: 'text', text: value, ...(style && { style }) })

export function spaced(items: Segment[], gap = ' '): Segment[] {
  return items.flatMap((item, i): Segment[] => i === 0 ? [item] : [{ kind: 'text', text: gap }, item])
}

/** Cuts `text` to at most `max` cells, ending in an ellipsis when cut; keeps a trailing space. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (cells(text) <= max) return text
  const space = max > 1 && text.endsWith(' ') ? ' ' : ''
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) + 1 + space.length > max) break
    out += ch
  }
  return `${out.trimEnd()}…${space}`
}

/** Cells a segment list takes on the terminal. */
export function segmentsWidth(segments: Segment[]): number {
  let n = 0
  for (const s of segments) {
    if (s.kind === 'text') n += cells(s.text)
    else if (s.kind === 'progress') n += cells(s.label) + 2
    else if (s.hidden) continue
    else if (s.face !== undefined) n += cells(s.face)
    else n += (s.primary ? 4 : s.hotkey ? cells(s.hotkey) + 2 : 0) + cells(s.label) + cells(s.detail ?? '')
  }
  return n
}

export { cells } from '../core/frame'

/** Words of `value` in lines: the first at most `first` cells, the others `rest`; the last line ends in an ellipsis when cut. */
export function wrapLines(value: string, first: number, rest: number, most: number): string[] {
  const words = value.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  let i = 0
  for (; i < words.length; i++) {
    const word = words[i]!
    const width = lines.length ? rest : first
    const next = line ? `${line} ${word}` : word
    if (cells(next) <= width) {
      line = next
      continue
    }
    if (line) {
      lines.push(line)
      if (lines.length === most) break
      line = ''
    }
    const room = lines.length ? rest : first
    if (cells(word) > room) {
      lines.push(truncate(word, room))
      if (lines.length === most) { i++; break }
      continue
    }
    line = word
  }
  if (line && lines.length < most) {
    lines.push(line)
    i = words.length
  }
  if (i < words.length && lines.length) {
    const last = lines.length - 1
    lines[last] = truncate(`${lines[last]} …`, last ? rest : first)
  }
  return lines
}

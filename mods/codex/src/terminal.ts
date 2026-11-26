// The composer's terminal: keys in, styled cells out. It draws the same segments the
// Claude Code card is laid out in (hooks/segments.ts), so both hosts show one card.

import type { Action, Color, Segment, Style } from '../../claude-code/hooks/segments'
import { cells } from '../../claude-code/hooks/segments'

export type Key =
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'enter'; newline: boolean }
  | { kind: 'backspace'; word: boolean }
  | { kind: 'delete' }
  | { kind: 'arrow'; dir: 'up' | 'down' | 'left' | 'right'; alt: boolean; ctrl: boolean; shift: boolean }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'tab'; shift: boolean }
  | { kind: 'escape' }
  | { kind: 'ctrl'; key: string }
  | { kind: 'alt'; key: string }
  | { kind: 'click'; x: number; y: number }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = { A: 'up', B: 'down', C: 'right', D: 'left' }

/** Splits raw terminal input into keys. A paste can span reads: `state.paste` carries it over. */
export function parseKeys(data: string, state: { paste: string | null }): Key[] {
  const keys: Key[] = []
  let i = 0
  const flushText = (text: string) => {
    if (!text) return
    const last = keys.at(-1)
    if (last?.kind === 'text') last.text += text
    else keys.push({ kind: 'text', text })
  }
  while (i < data.length) {
    if (state.paste !== null) {
      const end = data.indexOf(PASTE_END, i)
      if (end < 0) {
        state.paste += data.slice(i)
        return keys
      }
      keys.push({ kind: 'paste', text: (state.paste + data.slice(i, end)).replace(/\r\n?/g, '\n') })
      state.paste = null
      i = end + PASTE_END.length
      continue
    }
    if (data.startsWith(PASTE_START, i)) {
      state.paste = ''
      i += PASTE_START.length
      continue
    }
    const ch = data[i]!
    if (ch === '\x1b') {
      const rest = data.slice(i)
      // SGR mouse: ESC [ < b ; x ; y M|m (press only)
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest)
      if (mouse) {
        if (mouse[4] === 'M' && (Number(mouse[1]) & 0b11100011) === 0) keys.push({ kind: 'click', x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 })
        i += mouse[0].length
        continue
      }
      // kitty keyboard protocol: ESC [ code ; mods u
      const kitty = /^\x1b\[(\d+)(?:;(\d+))?u/.exec(rest)
      if (kitty) {
        const code = Number(kitty[1])
        const mods = Number(kitty[2] ?? 1) - 1
        if (code === 13) keys.push({ kind: 'enter', newline: mods !== 0 })
        else if (code === 27) keys.push({ kind: 'escape' })
        else if (code === 9) keys.push({ kind: 'tab', shift: (mods & 1) !== 0 })
        else if (code === 127) keys.push({ kind: 'backspace', word: (mods & 2) !== 0 })
        else if (mods & 4 && code >= 97 && code <= 122) keys.push({ kind: 'ctrl', key: String.fromCharCode(code) })
        else if (mods & 2 && code >= 32) keys.push({ kind: 'alt', key: String.fromCodePoint(code) })
        else if (code >= 32) flushText(String.fromCodePoint(code))
        i += kitty[0].length
        continue
      }
      const csi = /^\x1b\[(?:(\d+)(?:;(\d+))?)?([ABCDHFZ~])/.exec(rest)
      if (csi) {
        const [, first, second, final] = csi
        const mods = Number(second ?? (final !== '~' && first ? first : 1)) - 1
        const flags = { shift: (mods & 1) !== 0, alt: (mods & 2) !== 0, ctrl: (mods & 4) !== 0 }
        if (final && ARROWS[final]) keys.push({ kind: 'arrow', dir: ARROWS[final]!, ...flags })
        else if (final === 'H') keys.push({ kind: 'home' })
        else if (final === 'F') keys.push({ kind: 'end' })
        else if (final === 'Z') keys.push({ kind: 'tab', shift: true })
        else if (final === '~') {
          if (first === '3') keys.push({ kind: 'delete' })
          else if (first === '1' || first === '7') keys.push({ kind: 'home' })
          else if (first === '4' || first === '8') keys.push({ kind: 'end' })
        }
        i += csi[0].length
        continue
      }
      const ss3 = /^\x1bO([ABCDHF])/.exec(rest)
      if (ss3) {
        const final = ss3[1]!
        if (ARROWS[final]) keys.push({ kind: 'arrow', dir: ARROWS[final]!, alt: false, ctrl: false, shift: false })
        else keys.push({ kind: final === 'H' ? 'home' : 'end' })
        i += 3
        continue
      }
      // Legacy alt: ESC then the key (alt+arrows in some terminals: ESC ESC [ A).
      const next = data[i + 1]
      if (next === undefined) {
        keys.push({ kind: 'escape' })
        i++
        continue
      }
      if (next === '\x1b' && /^\x1b\x1b\[[ABCD]/.test(rest)) {
        keys.push({ kind: 'arrow', dir: ARROWS[rest[3]!]!, alt: true, ctrl: false, shift: false })
        i += 4
        continue
      }
      if (next === '\r' || next === '\n') keys.push({ kind: 'enter', newline: true })
      else if (next === '\x7f' || next === '\b') keys.push({ kind: 'backspace', word: true })
      else if (next === '[' || next === 'O') {
        i += 2 // an unknown sequence: skip its introducer
        continue
      } else keys.push({ kind: 'alt', key: next })
      i += 2
      continue
    }
    if (ch === '\r') keys.push({ kind: 'enter', newline: false })
    else if (ch === '\n') keys.push({ kind: 'enter', newline: true })
    else if (ch === '\x7f' || ch === '\b') keys.push({ kind: 'backspace', word: false })
    else if (ch === '\t') keys.push({ kind: 'tab', shift: false })
    else if (ch === '\x17') keys.push({ kind: 'backspace', word: true })
    else if (ch < ' ') keys.push({ kind: 'ctrl', key: String.fromCharCode(ch.charCodeAt(0) + 96) })
    else {
      const code = data.codePointAt(i)!
      flushText(String.fromCodePoint(code))
      i += code > 0xffff ? 2 : 1
      continue
    }
    i++
  }
  return keys
}

// ---- drawing -------------------------------------------------------------------------

/** Claude Code's theme keys, as its dark theme draws them. */
const THEME: Record<string, string> = {
  suggestion: '#b1b9f9', warning: '#ffc107', success: '#4eba65', error: '#ff6b80', inverseText: '#000000',
  text: '#ffffff', secondaryText: '#999999', permission: '#b1b9f9', claude: '#d77757', subtle: '#505050',
}

const truecolor = /truecolor|24bit/i.test(process.env['COLORTERM'] ?? '') || process.env['TERM_PROGRAM'] === 'iTerm.app' ||
  process.env['TERM_PROGRAM'] === 'WezTerm' || process.env['TERM_PROGRAM'] === 'ghostty' || Boolean(process.env['WT_SESSION'])

function rgb(color: Color): [number, number, number] | null {
  const hex = (THEME[color] ?? color).replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

function colorCode(color: Color, background: boolean): string {
  const c = rgb(color)
  if (!c) return ''
  if (truecolor) return `${background ? 48 : 38};2;${c[0]};${c[1]};${c[2]}`
  const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  return `${background ? 48 : 38};5;${16 + 36 * cube(c[0]) + 6 * cube(c[1]) + cube(c[2])}`
}

export function sgr(style: Style | undefined): string {
  if (!style) return ''
  const codes: string[] = []
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.color) codes.push(colorCode(style.color, false))
  if (style.bg) codes.push(colorCode(style.bg, true))
  const list = codes.filter(Boolean)
  return list.length ? `\x1b[${list.join(';')}m` : ''
}

export type Hit = { x0: number; x1: number; y: number; action: Action }

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** One laid-out line as ANSI, cut at `width` cells; pressable cells are reported for mouse clicks. */
export function drawLine(line: Segment[], width: number, y: number, hits: Hit[], frame = 0): string {
  let out = ''
  let x = 0
  for (const segment of line) {
    if (x >= width) break
    let text: string
    let style: Style | undefined
    if (segment.kind === 'text') {
      text = segment.text
      style = segment.style
    } else if (segment.kind === 'progress') {
      text = `${SPINNER[frame % SPINNER.length]} ${segment.label}`
      style = { dim: true }
    } else {
      if (segment.hidden) continue
      text = segment.face ?? segment.label
      if (segment.action.type === 'chapter' && segment.hotkey) text = `${segment.hotkey}: ${text}`
      style = segment.style ?? { ...(segment.bold && { bold: true }), ...(segment.dim && { dim: true }), ...(segment.color && { color: segment.color }) }
      if (segment.detail && !segment.face) text += ` ${segment.detail}`
    }
    const fitted = fit(text, width - x)
    const w = cells(fitted)
    if (segment.kind === 'button' && w > 0) hits.push({ x0: x, x1: x + w, y, action: segment.action })
    const open = sgr(style)
    out += open ? `${open}${fitted}\x1b[0m` : fitted
    x += w
  }
  return out
}

/** `text` cut to `room` cells. */
export function fit(text: string, room: number): string {
  if (room <= 0) return ''
  if (cells(text) <= room) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > room) break
    out += ch
  }
  return out
}

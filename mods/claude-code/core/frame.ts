// Terminal cells and framed sketches. The card's view and the text a prompt carries both use
// them, so the box the person saw is the box the agent gets.

/** Approximate terminal cells: wide CJK and emoji count two. */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    n += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff)) ? 2 : 1
  }
  return n
}

const LEFT = '│┃║├┝┠╟╞┌┍┎┏╔╒╓╭└┕┖┗╚╘╙╰'
const RIGHT = '│┃║┤┥┨╢╡┐┑┒┓╗╕╖╮┘┙┚┛╝╛╜╯'
const SIDE = '│┃║'
const RULE = /[─━═]/

/** A line that opens and closes a frame: `┌──┐`, `│ text │`, `└──┘`. */
export function closesFrame(line: string): boolean {
  const t = [...line.trim()]
  return t.length >= 2 && LEFT.includes(t[0]!) && RIGHT.includes(t.at(-1)!)
}

/**
 * A sketch drawn in a frame, its right edge put straight: a model cannot count
 * cells, so the lines of one box end at different columns. Every framed line
 * is padded to the widest (rules with their own line character, text with
 * spaces, one cell clear of the edge). Lines outside the frame are kept as is.
 */
export function tidySketch(lines: string[]): string[] {
  // A side line the model left open ("│ Team owners  [Download CSV]") still belongs to the frame.
  const closed = (t: string[]) => RIGHT.includes(t.at(-1)!)
  const framed = lines.map((line) => {
    const t = [...line.trim()]
    return t.length >= 2 && LEFT.includes(t[0]!) && (closed(t) || SIDE.includes(t[0]!))
  })
  if (framed.filter(Boolean).length < 2) return lines
  const indent = Math.min(...lines.filter((_, i) => framed[i]).map((line) => line.length - line.trimStart().length))
  const parts = lines.map((line, i) => {
    if (!framed[i]) return null
    const t = [...line.trim()]
    const side = SIDE.includes(t[0]!)
    const shut = closed(t)
    return { left: t[0]!, right: shut ? t.at(-1)! : t[0]!, body: (shut ? t.slice(1, -1) : t.slice(1)).join('').replace(/\s+$/, ''), side }
  })
  const inner = Math.max(...parts.map((part) => part ? cells(part.body) + (part.side ? 1 : 0) : 0))
  return lines.map((line, i) => {
    const part = parts[i]
    if (!part) return line
    const fill = part.side ? ' ' : (RULE.exec(part.body)?.[0] ?? '─')
    return `${' '.repeat(indent)}${part.left}${part.body}${fill.repeat(Math.max(0, inner - cells(part.body)))}${part.right}`
  })
}

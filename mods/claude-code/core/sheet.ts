export const SHEET_MAX_TOKENS = 320
export const SHEET_MAX_QUESTION = 96
export const SHEET_MAX_OPTION = 48

/** A complete sheet reply. Each well-formed line stands on its own. */
export function parseSheet(reply: string): { statement: string; options: string[] }[] {
  const items = []
  for (const line of reply.split(/\r?\n/)) {
    const [statement, ...options] = line.split('|').map((field) => field.trim())
    if (!statement || statement.length > SHEET_MAX_QUESTION ||
      /^(?:```|[-*•]\s|\d+[.)]\s)/.test(statement) || options.length < 2 || options.length > 4 ||
      options.some((option) => !option || option.length > SHEET_MAX_OPTION)) continue
    items.push({ statement: statement.charAt(0).toUpperCase() + statement.slice(1), options })
    if (items.length === 5) break
  }
  return items
}

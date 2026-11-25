/** MarginCue's version, as it introduces itself to Codex, to the desktop app and to its card. */
export const VERSION = '0.4.26'

/** The oldest Codex CLI MarginCue supports (the README's minimum). */
export const MIN_CODEX = '0.171'

/** The version `codex --version` printed, when it is older than MIN_CODEX; null when it is new enough or unreadable. */
export function tooOld(output: string): string | null {
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(output)
  if (!match) return null
  const [major, minor] = [Number(match[1]), Number(match[2])]
  const [minMajor, minMinor] = MIN_CODEX.split('.').map(Number) as [number, number]
  return major < minMajor || (major === minMajor && minor < minMinor) ? `${match[1]}.${match[2]}.${match[3]}` : null
}

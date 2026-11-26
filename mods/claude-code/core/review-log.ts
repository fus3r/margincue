import type { ReceiptView } from './types'

export const REVIEW_LOG_FILE = 'review-first.jsonl'

export async function reviewRootHash(root: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function reviewLogLine(receiptId: string, host: 'claude-code' | 'codex', projectRootHash: string,
  prompt: string, choices: ReceiptView['agent'], time = new Date().toISOString(),
): string {
  const chars = Array.from(prompt)
  const excerpt = chars.length <= 4000 ? prompt : chars.slice(0, 1999).join('') + '\n…\n' + chars.slice(-1998).join('')
  return JSON.stringify({
    receiptId, time, host, projectRootHash, prompt: excerpt,
    choices: choices.flatMap(({ label, value, options, review }) => review ? [{
      label, chosen: value, alternatives: options.filter((option) => option !== value),
      signals: review.signals, costReason: review.costReason, d: review.d, c: review.c, score: review.score,
      pinned: review.pinned, flagged: review.flagged, reason: review.reason, evidence: review.evidence,
      linkKind: review.linkKind, paths: review.paths,
    }] : []),
  })
}

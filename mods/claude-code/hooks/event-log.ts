export type LogIO = {
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
  getSalt(): Promise<unknown>
  setSalt(value: string): Promise<void>
  getSession(): Promise<string>
  after(ms: number, work: () => void | Promise<void>): { cancel: () => void }
  warn(): void
}

async function pseudonym(salt: string, kind: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\0${kind}\0${value}`))
  return Array.from(new Uint8Array(digest).subarray(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Opt-in, local JSONL. Callers pass identifiers and counts from the protocol. */
export class EventLog {
  private path: string | null = null
  private salt = ''
  private session = ''
  private project = ''
  private timer: { cancel: () => void } | null = null
  private lines: string[] = []
  private writer: Promise<void> = Promise.resolve()
  private failed = false

  get active(): boolean { return this.path !== null && !this.failed }

  async start(io: LogIO, target: string | ((session: string) => string), root: string): Promise<string | null> {
    await this.stop(io)
    const saved = await io.getSalt()
    if (typeof saved === 'string' && saved) this.salt = saved
    else {
      this.salt = crypto.randomUUID()
      await io.setSalt(this.salt)
    }
    this.session = await pseudonym(this.salt, 'session', await io.getSession())
    const path = typeof target === 'string' ? target : target(this.session)
    const prior = await io.read(path)
    if (prior && prior.split('\n').some((line) => line.trim() && !isObjectLine(line))) {
      throw new Error('Existing destination is not a JSONL event log')
    }
    await this.setProject(root)
    this.failed = false
    this.path = path
    return prior
  }

  async setProject(root: string): Promise<void> {
    if (this.salt) this.project = await pseudonym(this.salt, 'project', root)
  }

  async resetSession(io: LogIO): Promise<void> {
    if (this.active) {
      this.session = await pseudonym(this.salt, 'session', await io.getSession())
    }
  }

  add(io: LogIO, event: Record<string, unknown>): void {
    if (!this.active) return
    this.lines.push(JSON.stringify({
      timestamp: new Date().toISOString(), session: this.session, project: this.project, ...event,
    }))
    this.timer ??= io.after(100, () => this.flush(io))
  }

  flush(io: LogIO): Promise<void> {
    this.timer?.cancel()
    this.timer = null
    const path = this.path
    if (!path || !this.lines.length) return this.writer
    const batch = this.lines.splice(0).join('\n') + '\n'
    this.writer = this.writer.then(async () => {
      if (this.failed) return
      const existing = await io.read(path)
      const prior = existing ? existing + (existing.endsWith('\n') ? '' : '\n') : ''
      await io.write(path, prior + batch)
    }).catch(() => {
      this.failed = true
      io.warn()
    })
    return this.writer
  }

  async stop(io: LogIO): Promise<void> {
    await this.flush(io)
    this.path = null
  }
}

export type Arm = 'sheet' | 'control'

type TrialEvent = {
  event: string; arm: Arm; empty?: boolean; option?: number | string | null; afterSubmit?: boolean; picked?: number; open?: number
  rows?: number; stage?: string
}

function eventRows(text: string): TrialEvent[] {
  return text.split('\n').filter(isObjectLine).map((line) => JSON.parse(line))
}

export function loggedArm(text: string): Arm | null {
  const arm = eventRows(text).find((row) => row.event === 'session-arm')?.arm
  return arm === 'sheet' || arm === 'control' ? arm : null
}

export function trialCounts(logs: string[]): string[] {
  const rows = logs.flatMap(eventRows)
  return (['sheet', 'control'] as const).map((arm) => {
    const counts = { sessions: 0, requested: 0, replies: 0, empty: 0, shown: 0,
      before: 0, after: 0, dismissed: 0, submitted: 0, picked: 0, open: 0 }
    for (const row of rows) {
      if (row.arm !== arm) continue
      switch (row.event) {
        case 'session-arm': counts.sessions++; break
        case 'sheet-requested': counts.requested++; break
        case 'sheet-reply': counts.replies++; counts.empty += Number(row.empty === true); break
        case 'sheet-shown': counts.shown++; break
        case 'sheet-pick':
          if (typeof row.option === 'number') counts[row.afterSubmit ? 'after' : 'before']++
          break
        case 'sheet-dismissed': counts.dismissed++; break
        case 'sheet-submitted':
          counts.submitted++
          counts.picked += row.picked ?? 0
          counts.open += row.open ?? 0
          break
        // The card replaced the sheet; both are counted so older logs still read.
        case 'card-requested': counts.requested++; break
        case 'card-reply': counts.replies++; counts.empty += Number(row.rows === 0); break
        case 'card-shown': counts.shown++; break
        case 'card-pick': counts[row.stage === 'draft' ? 'before' : 'after']++; break
        case 'card-dismissed': counts.dismissed++; break
        case 'card-submitted':
          counts.submitted++
          counts.picked += row.picked ?? 0
          counts.open += Math.max(0, (row.rows ?? 0) - (row.picked ?? 0))
          break
      }
    }
    return `${arm}: ${counts.sessions} sessions · ${counts.requested} requested · ${counts.replies} replies (${counts.empty} empty) · ` +
      `${counts.shown} shown · ${counts.before} picks before and ${counts.after} after submit · ${counts.dismissed} dismissals · ` +
      `${counts.submitted} prompts sent (${counts.picked} picked, ${counts.open} left open)`
  })
}

function isObjectLine(line: string): boolean {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

// Readings through the person's own Codex login. One `codex app-server` lives as long
// as the composer; each reading is an ephemeral thread (never written to the person's
// history) whose base instructions are MarginCue's reader prompt, at low effort: on the
// lightest model the account offers, or on its default model where a reading must not
// miss (the desktop card reads each prompt once). Hooks, memories and project docs are
// off for it, so nothing of the person's setup runs on MarginCue's own readings.

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { runnable } from './command'
import { VERSION } from './version'

export type Completion = { ok: true; text: string; ms: number } | { ok: false; reason: string; ms: number }

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
type Turn = { threadId: string; text: string; done: (outcome: Completion) => void; started: number; onDelta?: (delta: string) => void }

/** Models in the order MarginCue prefers them for a reading: the lightest first. */
const LIGHT = [/luna/i, /mini/i, /nano/i, /lite/i, /small/i, /flash/i, /terra/i]
const TIMEOUT_MS = 25000

export class CodexModel {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, (message: Message) => void>()
  private turns = new Map<string, Turn>()
  private next = 1
  private ready: Promise<string | null> | null = null
  /** The account's default model, for readings that ask for `strong`. */
  private strongModel: string | null = null
  private failure: string | null = null
  private readonly cwd: string
  /** The Codex command and any leading arguments (tests run a fake app-server through Node). */
  private readonly command: string[]
  private readonly disablePlugins: boolean

  constructor(cwd: string, command: string | string[] = process.env['MARGINCUE_CODEX'] ?? 'codex', disablePlugins = false) {
    this.cwd = cwd
    this.command = Array.isArray(command) ? command : [command]
    this.disablePlugins = disablePlugins
  }

  /** Starts the app-server and picks the model; resolves to the model id, or null when Codex is not usable. */
  start(): Promise<string | null> {
    this.ready ??= this.boot().catch((error: unknown) => {
      this.failure = error instanceof Error ? error.message : String(error)
      return null
    })
    return this.ready
  }

  get problem(): string | null {
    return this.failure
  }

  private async boot(): Promise<string | null> {
    const args = ['app-server', '-c', 'features.hooks=false', '-c', 'features.memories=false', '-c', 'project_doc_max_bytes=0']
    // A widget reading must not start its own copy of the widget server.
    if (this.disablePlugins) args.push('-c', 'features.plugins=false')
    const [program, ...lead] = this.command
    const codex = runnable(program!, [...lead, ...args], this.cwd)
    const child = spawn(codex.command, codex.args, {
      ...codex.options,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MARGINCUE_READER: '1' },
      windowsHide: true,
    })
    this.child = child
    child.stderr.resume()
    // An app-server that stops reading (EPIPE) fails the readings; it never crashes the card.
    child.stdin.on('error', (error) => this.fail(`codex app-server: ${error.message}`))
    child.on('error', (error) => this.fail(`codex could not start: ${error.message}`))
    child.on('exit', () => this.fail('codex app-server exited'))
    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))
    const init = await this.call('initialize', { clientInfo: { name: 'margincue', title: 'MarginCue', version: VERSION }, capabilities: null })
    if (init.error) throw new Error(init.error.message ?? 'initialize failed')
    this.notify('initialized')
    const preferred = process.env.MARGINCUE_CODEX_MODEL
    if (preferred) {
      this.strongModel = preferred
      return preferred
    }
    const listed = await this.call('model/list', {})
    const models = ((listed.result as { data?: { id: string; hidden?: boolean; isDefault?: boolean }[] } | undefined)?.data ?? [])
      .filter((model) => !model.hidden)
    const fallback = models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null
    this.strongModel = fallback
    for (const pattern of LIGHT) {
      const light = models.find((model) => pattern.test(model.id))
      if (light) return light.id
    }
    return fallback
  }

  /**
   * One reading: `system` replaces Codex's own instructions, `prompt` is the only input; `onDelta` hears the text as it
   * streams. `strong` reads on the account's default model instead of its lightest.
   */
  async complete(system: string, prompt: string, options: { signal?: AbortSignal; onDelta?: (delta: string) => void; strong?: boolean } = {}): Promise<Completion> {
    const { signal, onDelta } = options
    const started = Date.now()
    const light = await this.start()
    const model = options.strong ? this.strongModel ?? light : light
    if (!model) return { ok: false, reason: this.failure ?? 'no Codex model', ms: Date.now() - started }
    const thread = await this.call('thread/start', {
      model, cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: system, ephemeral: true,
    })
    const threadId = (thread.result as { thread?: { id?: string } } | undefined)?.thread?.id
    if (!threadId) return { ok: false, reason: thread.error?.message ?? 'no thread', ms: Date.now() - started }
    return new Promise<Completion>((resolve) => {
      let settled = false
      const done = (outcome: Completion) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.turns.delete(threadId)
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        void this.call('turn/interrupt', { threadId }).catch(() => {})
        done({ ok: false, reason: 'timed out', ms: Date.now() - started })
      }, TIMEOUT_MS)
      signal?.addEventListener('abort', () => {
        void this.call('turn/interrupt', { threadId }).catch(() => {})
        done({ ok: false, reason: 'cancelled', ms: Date.now() - started })
      }, { once: true })
      this.turns.set(threadId, { threadId, text: '', done, started, ...(onDelta && { onDelta }) })
      void this.call('turn/start', {
        threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: 'low', summary: 'none',
      }).then((reply) => {
        if (reply.error) done({ ok: false, reason: reply.error.message ?? 'turn failed', ms: Date.now() - started })
      })
    })
  }

  close(): void {
    this.child?.kill()
    this.child = null
  }

  private receive(line: string): void {
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      return
    }
    if (message.id !== undefined && !message.method) {
      const resolve = this.pending.get(message.id)
      this.pending.delete(message.id)
      resolve?.(message)
      return
    }
    // A request from the server (an approval, a question): MarginCue's reader never asks for anything, so decline.
    if (message.id !== undefined && message.method) {
      this.write({ id: message.id, error: { code: -32601, message: 'MarginCue answers no requests' } })
      return
    }
    const params = message.params ?? {}
    const turn = typeof params['threadId'] === 'string' ? this.turns.get(params['threadId']) : undefined
    if (!turn) return
    if (message.method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
      turn.text += params['delta']
      turn.onDelta?.(params['delta'])
    }
    else if (message.method === 'turn/completed') {
      const status = (params['turn'] as { status?: string } | undefined)?.status
      turn.done(status === 'failed' || status === 'interrupted'
        ? { ok: false, reason: `turn ${status}`, ms: Date.now() - turn.started }
        : { ok: true, text: turn.text, ms: Date.now() - turn.started })
    } else if (message.method === 'error' && params['willRetry'] !== true) {
      const error = params['error'] as { message?: string } | undefined
      turn.done({ ok: false, reason: error?.message ?? 'error', ms: Date.now() - turn.started })
    }
  }

  private call(method: string, params: unknown): Promise<Message> {
    if (this.failure && method !== 'initialize') return Promise.resolve({ error: { message: this.failure } })
    const id = this.next++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.write({ id, method, params })
    })
  }

  private notify(method: string): void {
    this.write({ method })
  }

  private write(message: object): void {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private fail(reason: string): void {
    this.failure ??= reason
    for (const resolve of this.pending.values()) resolve({ error: { message: reason } })
    this.pending.clear()
    for (const turn of this.turns.values()) turn.done({ ok: false, reason, ms: Date.now() - turn.started })
  }
}

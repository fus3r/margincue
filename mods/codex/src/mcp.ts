import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { CardReader, validPicks } from './card-reader'
import { isCardId, newCardRecord, readRecord, updateRecord, waitForRecord, writeRecord } from './card-store'
import type { CardRecord } from './card-store'
import { codexCommand, fillCard } from './prefetch'
import { readSettings } from './store'
import { VERSION } from './version'
import type { CardOutput } from './widget-message'

const CARD_URI = 'ui://margincue/card.html'
const CARD_META = { ui: { resourceUri: CARD_URI }, 'openai/outputTemplate': CARD_URI }
const CARD_RESOURCE = { uri: CARD_URI, name: 'MarginCue card', mimeType: 'text/html;profile=mcp-app' }
const APP_ONLY = { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' }
const TOOL_LIST = [
  {
    name: 'margincue_card',
    description: 'Show the MarginCue card for the current prompt, when MarginCue’s prompt hook asks for it. Then end your turn: the user’s choices arrive as their next message.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        card: { type: 'string', description: 'The card id MarginCue’s prompt hook gave.' },
        prompt: { type: 'string', description: 'Only without a card id: the user’s full prompt verbatim.' },
        cwd: { type: 'string', description: 'Only without a card id: the session’s absolute project directory.' },
      },
    },
    annotations: { readOnlyHint: true },
    _meta: CARD_META,
  },
  {
    name: 'margincue_read',
    description: 'Start a reading when the user asks, or follow an open MarginCue card while its reading and first preview arrive.',
    inputSchema: {
      type: 'object', required: ['card'], additionalProperties: false,
      properties: { card: { type: 'string' }, after: { type: 'integer' }, start: { type: 'boolean' } },
    },
    annotations: { readOnlyHint: true },
    _meta: APP_ONLY,
  },
  {
    name: 'margincue_sketch',
    description: 'Draw the preview for an open MarginCue card with its current choices.',
    inputSchema: {
      type: 'object', required: ['cardId', 'picks'], additionalProperties: false,
      properties: {
        cardId: { type: 'string' },
        picks: { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer' } } },
      },
    },
    annotations: { readOnlyHint: true },
    _meta: APP_ONLY,
  },
]
/** How long a widget's follow call waits for something new before answering with what there is. */
const FOLLOW_MS = 8000
const SKETCH_WAIT_MS = 14000

const output = (record: CardRecord): CardOutput => ({
  ...record.card, sketch: record.sketch, version: record.version, state: record.state, sketchState: record.sketchState,
})

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

type Id = string | number | null

class RpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const content = (text: string) => [{ type: 'text', text }]
const toolError = (text: string) => ({ isError: true, content: content(text) })
const sketched = (sketch: CardRecord['sketch']) => ({
  structuredContent: { sketch }, content: content(sketch ? 'Preview drawn.' : 'There is no preview for this prompt.'),
})

async function dispatch(reader: CardReader, method: string, params: Record<string, unknown>): Promise<object> {
  switch (method) {
    case 'initialize': {
      const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(version) ? version : PROTOCOL_VERSIONS[0],
        serverInfo: { name: 'margincue', version: VERSION },
        capabilities: { tools: {}, resources: {} },
      }
    }
    case 'ping': return {}
    case 'tools/list': return { tools: TOOL_LIST }
    case 'resources/list': return { resources: [CARD_RESOURCE] }
    case 'resources/templates/list': return { resourceTemplates: [] }
    case 'resources/read': {
      if (params.uri !== CARD_URI) throw new RpcError(-32002, 'Resource not found')
      const text = readFileSync(new URL('../dist/card.html', import.meta.url), 'utf8')
      return { contents: [{
        ...CARD_RESOURCE, text,
        _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
      }] }
    }
    case 'tools/call': {
      const args = object(params.arguments)
      if (params.name === 'margincue_card') {
        let record = isCardId(args.card) ? readRecord(args.card) : null
        if (!record) {
          if (typeof args.prompt !== 'string' || !args.prompt.trim() || typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) {
            return toolError('MarginCue needs the card id from its prompt hook, or the prompt and its absolute project directory.')
          }
          const settings = readSettings()
          if (settings.mode === 'off') return toolError('MarginCue is off.')
          record = newCardRecord(args.prompt, args.cwd, settings)
          writeRecord(record)
          if (record.state === 'reading') void fillCard(reader, record.id)
        }
        // The first preview after a pick should not wait for Codex to start.
        if (record.state !== 'waiting') reader.warm(record.cwd)
        return {
          structuredContent: output(record), _meta: CARD_META,
          content: content('The MarginCue card is up. End your turn now, without writing anything more. The user’s choices will arrive as their next message.'),
        }
      }
      if (params.name === 'margincue_read') {
        const after = typeof args.after === 'number' ? args.after : 0
        let record = isCardId(args.card) ? readRecord(args.card) : null
        if (record?.state === 'waiting' && args.start === true) {
          if (readSettings().mode === 'off') return toolError('MarginCue is off.')
          record = updateRecord(record.id, (card) => { card.state = 'reading' })
          if (record) void fillCard(reader, record.id)
        } else if (record && record.state !== 'waiting' && args.start !== true) {
          record = await waitForRecord(record.id, after, FOLLOW_MS)
        }
        if (!record) return toolError('This card is no longer available.')
        const status = record.state === 'waiting' ? 'Ready to read.' : record.state === 'reading' ? 'Reading.' : 'Read.'
        return { structuredContent: output(record), content: content(status) }
      }
      if (params.name === 'margincue_sketch') {
        let record = isCardId(args.cardId) ? readRecord(args.cardId) : null
        if (!record || record.state !== 'done') return toolError('This card is no longer available for preview.')
        const picks = validPicks(record.card.rows, args.picks)
        if (!picks) return toolError('Invalid card choices.')
        try {
          if (!Object.keys(picks).length && record.sketchState !== 'none' && record.sketchState !== 'failed') {
            // The first preview is drawn already, or on its way: wait for it rather than draw it twice.
            const until = Date.now() + SKETCH_WAIT_MS
            while (record?.sketchState === 'drawing' && Date.now() < until) record = await waitForRecord(record.id, record.version, until - Date.now())
            if (record?.sketchState === 'done') return sketched(record.sketch)
            if (!record) return toolError('This card is no longer available for preview.')
          }
          return sketched(await reader.sketch(record, picks))
        } catch (error) {
          return toolError(error instanceof Error ? error.message : 'The preview is unavailable.')
        }
      }
      throw new RpcError(-32602, 'Unknown tool')
    }
    default: throw new RpcError(-32601, 'Method not found')
  }
}

/** Stdio uses one JSON-RPC message per line. Reads and previews run independently. */
export async function serveMcp(): Promise<void> {
  const reader = new CardReader(codexCommand())
  const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const fail = (id: Id, code: number, message: string) => send({ id, error: { code, message } })
  const pending = new Set<Promise<unknown>>()
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue
    let request: Record<string, unknown>
    try {
      request = object(JSON.parse(line))
    } catch {
      fail(null, -32700, 'Parse error')
      continue
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (request.id !== undefined && id === null)) {
      fail(id, -32600, 'Invalid request')
      continue
    }
    if (id === null) continue
    const task = dispatch(reader, request.method, object(request.params)).then(
      (result) => send({ id, result }),
      (error: unknown) => fail(id, error instanceof RpcError ? error.code : -32603, error instanceof RpcError ? error.message : 'MarginCue could not complete the request'),
    ).finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all(pending)
  reader.close()
}

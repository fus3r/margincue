// A stand-in for `codex app-server` in tests: it speaks the same newline-delimited JSON-RPC,
// lists two models, and answers each turn with a fixed reply in three streamed pieces.
// FAKE_CODEX_FAIL=1 makes every turn fail.
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let thread = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const { id, method, params } = message
  if (method === 'initialize') return send({ id, result: { userAgent: 'fake' } })
  if (method === 'model/list') {
    return send({ id, result: { data: [{ id: 'gpt-big', isDefault: true }, { id: 'gpt-6-luna', isDefault: false }] } })
  }
  if (method === 'thread/start') {
    thread += 1
    return send({ id, result: { thread: { id: `thread-${thread}` }, model: params.model, echo: params.baseInstructions } })
  }
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
    const threadId = params.threadId
    if (process.env.FAKE_CODEX_FAIL) {
      send({ method: 'error', params: { threadId, turnId: 'turn-1', willRetry: false, error: { message: 'quota' } } })
      return
    }
    const text = `read | You want ${params.input[0].text.slice(0, 20)}.\nkind | build\n`
    for (const piece of [text.slice(0, 7), text.slice(7, 30), text.slice(30)]) {
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'm', delta: piece } })
    }
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } })
    return
  }
  send({ id, result: {} })
})

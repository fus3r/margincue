// A stand-in for `codex app-server` in tests: it speaks the same newline-delimited JSON-RPC,
// lists two models, and answers each turn with a fixed reply in three streamed pieces.
// FAKE_CODEX_FAIL=1 makes every turn fail; FAKE_CODEX_LINES=1 streams the reply a line at a time;
// FAKE_CODEX_CLOSE=1 stops reading (closes stdin, stays alive) once it has listed the models.
import { closeSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let thread = 0
const instructions = new Map()
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const { id, method, params } = message
  if (method === 'initialize') return send({ id, result: { userAgent: 'fake' } })
  if (method === 'model/list') {
    send({ id, result: { data: [{ id: 'gpt-big', isDefault: true }, { id: 'gpt-6-luna', isDefault: false }] } })
    if (process.env.FAKE_CODEX_CLOSE) {
      lines.close()
      process.stdin.destroy()
      closeSync(0)
      setTimeout(() => {}, 3000)
    }
    return
  }
  if (method === 'thread/start') {
    if (process.env.FAKE_CODEX_PROJECT && (params.cwd !== process.env.FAKE_CODEX_PROJECT || !process.argv.includes('features.plugins=false'))) {
      return send({ id, error: { message: 'unexpected reader configuration' } })
    }
    thread += 1
    instructions.set(`thread-${thread}`, params.baseInstructions)
    return send({ id, result: { thread: { id: `thread-${thread}` }, model: params.model, echo: params.baseInstructions } })
  }
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
    const threadId = params.threadId
    if (process.env.FAKE_CODEX_FAIL) {
      send({ method: 'error', params: { threadId, turnId: 'turn-1', willRetry: false, error: { message: 'quota' } } })
      return
    }
    const prompt = params.input[0].text
    let text = process.env.FAKE_CODEX_CARD ?? `read | You want ${prompt.slice(0, 20)}.\nkind | build\n`
    if (process.env.FAKE_CODEX_PROJECT) {
      text = instructions.get(threadId).includes('Draw what the finished result will look like')
        ? ['title | Activity report', 'Weekly activity', ...prompt.split('\n').filter((line) => line.startsWith('- ')), ''].join('\n')
        : prompt.includes('Build a retention report for inactive teams') ? [
            'read | A report on inactive teams.', 'kind | build',
            'row | purge | retention | one | After {}, the agent will permanently delete the team in a scheduled job | 30 days | 7 days',
            'row | week_start | week starts | one | Weeks start on {} | Monday | Sunday',
            '',
          ].join('\n')
        : [
            'read | A weekly activity report with CSV export.', 'kind | build',
            'row | week_start | week starts | one | Weeks start on {} | Monday* | Sunday',
            'row | columns | columns | many | Include {} | sign-ins* | invites',
            'row | history | history | num | Show {} of history | 4 | 1 | 8 | wk',
            '',
          ].join('\n')
    }
    const pieces = process.env.FAKE_CODEX_LINES ? text.split(/(?<=\n)/) : [text.slice(0, 7), text.slice(7, 30), text.slice(30)]
    for (const piece of pieces) {
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'm', delta: piece } })
    }
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } })
    return
  }
  send({ id, result: {} })
})

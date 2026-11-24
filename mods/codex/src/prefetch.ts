import { CardReader } from './card-reader'
import { readRecord, updateRecord } from './card-store'

/** Where the reader finds Codex: the Desktop app's own runtime when the app started us. */
export function codexCommand(): string {
  return process.env['MARGINCUE_CODEX'] || process.env['CODEX_CLI_PATH'] || process.env['CODEX_APP_RUNTIME_CLI_PATH'] || 'codex'
}

/** Reads the card, then draws its first preview, writing each step to its record as it lands. */
export async function fillCard(reader: CardReader, id: string): Promise<void> {
  const start = readRecord(id)
  if (!start || start.state !== 'reading') return
  updateRecord(id, (record) => { record.pid = process.pid })
  const read = () => reader.read(id, start.prompt, start.cwd, (card) => updateRecord(id, (record) => { record.card = card }))
    .catch(() => null)
  let source = await read()
  // Something to build always leaves choices open: a reading of one that lists none slipped, so read it once more.
  if (source && source.kind === 'build' && !source.card.rows.length) source = await read() ?? source
  if (!source?.card.reading && !source?.card.rows.length) {
    updateRecord(id, (record) => {
      if (source) record.card = source.card
      record.state = 'failed'
    })
    return
  }
  const { card, names, today } = source
  updateRecord(id, (record) => {
    Object.assign(record, { card, names, ...(today && { today }), state: 'done', sketchState: card.preview ? 'drawing' : 'none' })
  })
  if (!card.preview) return
  const sketch = await reader.sketch(source, {}).catch(() => undefined)
  updateRecord(id, (record) => {
    record.sketch = sketch ?? null
    record.sketchState = sketch ? 'done' : 'failed'
  })
}

/** `margincue prefetch <id>`: the detached reader the prompt hook starts. */
export async function runPrefetch(id: string): Promise<void> {
  const reader = new CardReader(codexCommand())
  try {
    await fillCard(reader, id)
  } finally {
    reader.close()
  }
}

import { buildSketchPrompt, canSketch, parseSketch } from '../../claude-code/core/card'
import type { ParsedSketch } from '../../claude-code/core/card'
import { createCore } from '../../claude-code/core/index'
import { ASSETS } from '../../claude-code/hooks/assets'
import { tidySketch } from '../../claude-code/hooks/card-view'
import { collectVocabulary } from '../../claude-code/hooks/repo-index'
import { cardConfig } from './card-config'
import { CodexModel } from './model'
import { processEngine, readLearned, readSettings } from './store'
import { cardPlan } from './widget-message'
import type { Selections, WidgetCard } from './widget-message'

/** A reading streams into the card as it comes, so this only bounds a reading that stalls. */
const READ_MS = 15000
const INDEX_MS = 750
const SKETCH_MS = 12000
/** How long an app-server stays up after its last use: a pick soon after the card draws at once. */
const WARM_MS = 3 * 60 * 1000

export type CardSource = { card: WidgetCard; cwd: string; names: string[]; today?: string; kind?: string | null }

export class CardReader {
  private readonly command: string | string[]
  private readonly models = new Map<string, { model: CodexModel; idle: NodeJS.Timeout }>()

  constructor(command: string | string[]) {
    this.command = command
  }

  /** A started app-server for this project, kept up for a few minutes after each use. */
  warm(cwd: string): CodexModel {
    let entry = this.models.get(cwd)
    if (entry?.model.problem) {
      entry.model.close()
      clearTimeout(entry.idle)
      entry = undefined
    }
    const model = entry?.model ?? new CodexModel(cwd, this.command, true)
    if (entry) clearTimeout(entry.idle)
    else void model.start()
    const idle = setTimeout(() => {
      model.close()
      this.models.delete(cwd)
    }, WARM_MS)
    idle.unref()
    this.models.set(cwd, { model, idle })
    return model
  }

  close(): void {
    for (const { model, idle } of this.models.values()) {
      clearTimeout(idle)
      model.close()
    }
    this.models.clear()
  }

  /**
   * Reads the prompt into a card. `onUpdate` hears the card each time the streamed reading completes a line:
   * its reading first, then each choice. Resolves to the finished card with what a preview needs, or null when off.
   */
  async read(seed: WidgetCard, cwd: string, onUpdate?: (card: WidgetCard) => void): Promise<CardSource | null> {
    const settings = readSettings()
    if (settings.mode === 'off') return null
    const started = Date.now()
    const config = cardConfig(settings)
    const model = this.warm(cwd)
    const core = createCore(ASSETS, { readSubmittedPrompt: true })
    const currentCard = () => cardOf(core, seed, config.sketch !== false, config.refs !== false)
    core.handle({ ...config, read: 'key', send: seed.send, sketch: false })
    core.handle({ type: 'learned', picks: readLearned(cwd) })
    const indexBy = started + INDEX_MS
    core.handle({ type: 'vocabulary', vocab: await before(vocabulary(cwd, indexBy), indexBy) })
    core.handle({ type: 'draft', text: seed.prompt, now: Date.now(), origin: 'open' })
    const request = core.handle({ type: 'cardRead', now: Date.now() })
      .find((effect) => effect.type === 'request' && effect.kind === 'card')
    if (request?.type === 'request') {
      const reply = (text: string, done: boolean, ok = true) => core.handle({ type: 'reply', now: Date.now(), req: request.req, text, done, ok })
      // Only whole lines go to the reading, so a deadline never leaves half a choice in it.
      let rest = ''
      let given = false
      let open = true
      const stop = new AbortController()
      // The card is read once per prompt, so it reads on the account's default model: the lightest one
      // sometimes names the open choices in its reading line and then lists none of them.
      const reading = model.complete(request.system.join('\n\n'), request.prompt, {
        signal: stop.signal,
        strong: true,
        onDelta: (delta) => {
          if (!open) return
          rest += delta
          const end = rest.lastIndexOf('\n')
          if (end < 0) return
          reply(rest.slice(0, end + 1), false)
          rest = rest.slice(end + 1)
          given = true
          onUpdate?.(currentCard())
        },
      })
      const outcome = await before(reading, started + READ_MS)
      open = false
      if (!outcome) stop.abort()
      if (outcome?.ok) reply(rest, true)
      else reply('', true, given)
    }

    const card = currentCard()
    const view = core.currentView().card
    const names = (view?.mentions ?? []).filter((mention) => mention.status === 'found').slice(0, 8).map((mention) => mention.match ?? mention.phrase)
    return { card, cwd, names, today: config.today, kind: view?.kind ?? null }
  }

  /** Draws the preview for the card with these choices (none: as Codex would decide them). */
  async sketch(source: CardSource, picks: Selections): Promise<ParsedSketch | null> {
    const { card, cwd, names, today } = source
    const { decisions: choices } = cardPlan(card.rows, picks, card.send)
    const prompt = buildSketchPrompt({ draft: card.prompt, read: card.reading, choices, names, today })
    const system = ASSETS.sketchSystem!.replace('{language}', 'in English')
    // The lightest model often answers that there is nothing to draw; the default one draws.
    const reply = await before(this.warm(cwd).complete(system, prompt, { strong: true }), Date.now() + SKETCH_MS)
    if (!reply?.ok) throw new Error('The preview is unavailable.')
    const sketch = parseSketch(reply.text)
    return sketch && { title: sketch.title, lines: tidySketch(sketch.lines) }
  }
}

function cardOf(core: ReturnType<typeof createCore>, seed: WidgetCard, sketchOn: boolean, refsOn: boolean): WidgetCard {
  const view = core.currentView().card
  const missing = (view?.mentions ?? []).filter((mention) => mention.status === 'missing').map((mention) => {
    const row = view?.rows.find((row) => row.origin === 'repo' && row.statement === `"${mention.phrase}" is {}`)
    return { phrase: mention.phrase, candidates: mention.near, ...(row && { rowId: row.id }) }
  })
  const rows = (view?.rows ?? []).map(({ id, key, origin, learned, label, type, statement, options, selected, openOnSend }) => {
    const mention = missing.find((name) => name.rowId === id)
    return { id, key, origin, ...(learned && { learned }), label, type, statement, options, assumed: selected,
      ...(openOnSend && { openOnSend }),
      ...(mention && { files: mention.candidates.map((candidate) => candidate.file) }) }
  })
  const fileReferences = refsOn ? (view?.mentions ?? []).flatMap((mention) => {
    if (!mention.places?.length) return []
    const row = view?.rows.find((row) => row.origin === 'repo' && row.key.startsWith('file_') && row.start === mention.start)
    return [{ phrase: mention.phrase, files: mention.places, ...(row && { rowId: row.id }) }]
  }) : []
  const preview = sketchOn && Boolean(ASSETS.sketchSystem) && canSketch(view?.kind ?? null)
  const { id, prompt, send } = seed
  return { id, prompt, send, reading: view?.read ?? null, rows, missing, preview, sketch: null,
    ...(fileReferences.length && { fileReferences }) }
}

/** The picks a widget sent, if every one names a row and options it has. */
export function validPicks(rows: WidgetCard['rows'], value: unknown): Selections | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const picks: Selections = {}
  for (const [id, selected] of Object.entries(value)) {
    const row = rows.find((row) => row.id === id)
    if (!row || !Array.isArray(selected) || (row.type !== 'many' && selected.length !== 1) ||
      new Set(selected).size !== selected.length || selected.some((i) => !Number.isInteger(i) || i < 0 || i >= row.options.length)) return null
    picks[id] = selected
  }
  return picks
}

/** Give all index subprocesses the same deadline so they cannot delay the reading. */
async function vocabulary(cwd: string, deadline: number) {
  const run: typeof processEngine.process.run = (argv, options) => {
    const left = deadline - Date.now()
    if (left <= 0) return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' })
    return processEngine.process.run(argv, { ...options, timeoutMs: left })
  }
  return collectVocabulary({ ...processEngine, process: { run } }, cwd).catch(() => null)
}

async function before<T>(work: Promise<T>, deadline: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

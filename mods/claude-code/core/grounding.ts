// Grounding: the names a draft mentions, looked up in the project's own code.
// Pure: the host collects file names, declarations and quoted display names
// once (git ls-files, git grep), and this module indexes and matches them.

export type EntryKind = 'symbol' | 'name' | 'path'
/** `stem`: a path entry that only ever came from a file name (codex.mjs), weak evidence for a capitalised word. */
export type VocabEntry = { name: string; kind: EntryKind; files: number[]; stem?: true }

/** What the host collected, ready to index; `map` is a compact outline of the repo for the model; `project` its folder's name. */
export type Vocabulary = {
  files: string[]
  entries: VocabEntry[]
  map: string
  project?: string
  /** Libraries the project imports or declares, counted by package (see core/project.ts). */
  libs?: Record<string, number>
}

export type Mention = {
  phrase: string
  start: number
  end: number
  status: 'found' | 'missing'
  /** The code's own spelling of the match, and what it is: a declaration, a quoted name or a path. */
  match?: string
  kind?: EntryKind
  /** How the draft wrote it: as code (a path, a file, an identifier, backticks), as a name, or as a plain word. */
  as: 'code' | 'name' | 'word'
  /** Up to two files, definitions first. */
  files: string[]
  /**
   * A name written as code that the code has in several files, when nothing else in the draft says which: the
   * files it may mean (two to four), or none when it is in more files than one question can offer.
   */
  places?: string[]
  /** For a missing name: the closest names the code does have. */
  near: { name: string; file: string }[]
}

export type GroundIndex = {
  vocab: Vocabulary
  byKey: Map<string, number[]>
  byToken: Map<string, number[]>
  /** File paths as listed, and the files under each base name: a path written in a draft is looked up as a path. */
  paths: Set<string>
  byBase: Map<string, number[]>
}

const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'to', 'in', 'on', 'for', 'de', 'la', 'le', 'du', 'des', 'et'])
/** Definitions first when listing where a name lives. */
const WHERE_RANK: Record<EntryKind, number> = { symbol: 0, name: 1, path: 2 }
/** Display names first when suggesting what a missing name might mean. */
const NEAR_RANK: Record<EntryKind, number> = { name: 0, symbol: 1, path: 2 }
/** Capitalised words that start sentences or are common enough to say nothing about the code. */
const COMMON = new Set(`i a an the this that these those it its we you your my our they their he she his her
all any some each every no not none one two three first next then also but and or so if when while after before
yes ok okay please thanks hello hi let lets now here there what which who why how where make build create add fix
use using see seeing note maybe just even only still again very more most much many few other another same such
can could should would will must may might do does did done is are was were be been being have has had get got
monday tuesday wednesday thursday friday saturday sunday january february march april june july august september
october november december english french api cli ui ux url json yaml html css sql pr prs llm ai ml`.split(/\s+/))
/** Lowercase words never linked even when a type of that name exists. */
const VAGUE = new Set(['data', 'thing', 'things', 'stuff', 'item', 'items', 'value', 'values', 'state', 'states',
  'error', 'errors', 'event', 'events', 'result', 'results', 'option', 'options', 'config', 'setting', 'settings',
  'string', 'number', 'object', 'array', 'list', 'type', 'types', 'model', 'models', 'file', 'files', 'part',
  'parts', 'level', 'levels', 'example', 'examples', 'problem', 'problems', 'program', 'feature', 'features',
  'system', 'systems', 'logging', 'analytics', 'logs', 'test', 'tests', 'page', 'pages', 'user', 'users',
  'should', 'would', 'could', 'there', 'their', 'these', 'those', 'where', 'which', 'while', 'about', 'other',
  // Words every codebase has a class for, which say nothing about which one the draft means.
  'session', 'sessions', 'request', 'requests', 'response', 'responses', 'client', 'clients', 'server', 'servers',
  'message', 'messages', 'agent', 'agents', 'prompt', 'prompts', 'token', 'tokens', 'task', 'tasks', 'worker',
  'workers', 'thread', 'threads', 'stream', 'streams', 'handler', 'handlers', 'service', 'services', 'manager',
  'controller', 'component', 'components', 'module', 'modules', 'plugin', 'plugins', 'profile', 'profiles',
  'context', 'record', 'records', 'entry', 'entries', 'index', 'table', 'tables', 'field', 'fields', 'column',
  'columns', 'screen', 'screens', 'window', 'windows', 'panel', 'panels', 'button', 'buttons', 'layout', 'layouts',
  'design', 'render', 'rendering', 'image', 'images', 'video', 'videos', 'report', 'reports', 'review', 'reviews',
  'check', 'checks', 'build', 'builds', 'script', 'scripts', 'command', 'commands', 'process', 'action', 'actions',
  'option', 'store', 'cache', 'queue', 'queues', 'parser', 'reader', 'writer', 'builder', 'runner', 'helper',
  'helpers', 'utils', 'source', 'sources', 'output', 'outputs', 'input', 'inputs', 'decision', 'decisions',
  'question', 'questions', 'answer', 'answers', 'change', 'changes', 'update', 'updates', 'version', 'versions',
  'section', 'sections', 'status', 'flag', 'flags', 'step', 'steps', 'line', 'lines', 'words', 'names', 'paths',
  'modes', 'views', 'label', 'labels', 'title', 'titles', 'color', 'colour', 'colors', 'colours', 'theme', 'themes',
  'width', 'height', 'count', 'total', 'link', 'links', 'nodes', 'point', 'points', 'shape', 'shapes', 'layer', 'layers'])

/** Lowercase, letters and digits only, a plain English plural made singular. */
export function nameKey(text: string): string {
  const flat = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  return singular(flat)
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1)
  return word
}

/** The words of a name: camelCase, snake_case, kebab-case and spaces all split. */
export function nameTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map(singular)
}

export function indexVocabulary(vocab: Vocabulary): GroundIndex {
  const byKey = new Map<string, number[]>()
  const byToken = new Map<string, number[]>()
  vocab.entries.forEach((entry, i) => {
    const key = nameKey(entry.name)
    if (key.length < 2) return
    push(byKey, key, i)
    for (const token of new Set(nameTokens(entry.name))) if (token.length >= 3) push(byToken, token, i)
  })
  const byBase = new Map<string, number[]>()
  vocab.files.forEach((path, i) => push(byBase, path.slice(path.lastIndexOf('/') + 1).toLowerCase(), i))
  return { vocab, byKey, byToken, paths: new Set(vocab.files), byBase }
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** How surely a candidate names something: `prose` (words joined by a slash) only ever links, never counts as missing. */
type Strength = 'code' | 'ident' | 'proper' | 'quoted' | 'word' | 'prose'
type Candidate = { phrase: string; start: number; end: number; strength: Strength }

const PATHISH = /(?<![\w$./-])(?:[A-Za-z_$][\w$-]*(?:[./][\w$-]+)+\/?|[A-Za-z_$][\w$-]*\/)(?![\w$])/g
const IDENT = /(?<![\w$])(?:[a-z][a-z0-9]*[A-Z][\w$]*|[A-Za-z][a-z0-9]*_[\w$]+)(?![\w$])/g
const PASCAL = /(?<![\w$])[A-Z][a-z0-9]+[A-Z][\w$]*(?![\w$])/g
const QUOTED = /(?<![\p{L}\p{N}])(['"‘“`])([^'"‘’“”`\n]{2,40})(['"’”`])(?![\p{L}\p{N}])/gu
const PROPER = /(?<![\p{L}\p{N}_'’-])(?:\p{Lu}[\p{Ll}\p{N}'’]+|\p{Lu}{2,}\p{Ll}*)(?:\s(?:(?:of|the|de|la|du)\s)?\p{Lu}[\p{Ll}\p{N}'’]+)*(?![\p{L}\p{N}_-])/gu
const WORD = /(?<![\p{L}\p{N}_'’-])\p{Ll}{5,}(?![\p{L}\p{N}_-])/gu

function sentenceStart(text: string, at: number): boolean {
  const before = text.slice(0, at).replace(/[\s"'“‘(\[*_-]+$/u, '')
  return before === '' || /[.!?:;\n]$/.test(before)
}

function candidates(text: string): Candidate[] {
  const out: Candidate[] = []
  const taken: [number, number][] = []
  const add = (c: Candidate) => {
    if (taken.some(([x, y]) => c.start < y && x < c.end)) return
    out.push(c)
    taken.push([c.start, c.end])
  }
  for (const m of text.matchAll(QUOTED)) {
    if ((m[1] === '`') !== (m[3] === '`')) continue
    const inner = m[2]!.trim()
    if (!inner || inner.split(/\s+/).length > 5) continue
    const start = m.index! + m[1]!.length + m[2]!.indexOf(inner)
    add({ phrase: inner, start, end: start + inner.length, strength: m[1] === '`' ? 'code' : 'quoted' })
  }
  for (const m of text.matchAll(PATHISH)) {
    const phrase = m[0].replace(/\.+$/, '')
    if (/^(?:e\.g|i\.e|etc|vs|a\.m|p\.m)$/i.test(phrase) || /^\d/.test(phrase)) continue
    // "Logs/Analytics", "on/off" or "basic/AI-slop" in prose are words, not a path: they link when the code
    // has that path, and are never called missing. A path has a dot, a trailing slash or a deeper level.
    const prose = /^[A-Za-z-]+\/[A-Za-z-]+$/.test(phrase) && !/[a-z][A-Z]|_/.test(phrase)
    if (prose && /^[A-Z][a-z]+\/[A-Z][a-z]+$/.test(phrase)) continue
    add({ phrase, start: m.index!, end: m.index! + phrase.length, strength: prose ? 'prose' : 'code' })
  }
  for (const m of text.matchAll(IDENT)) add({ phrase: m[0], start: m.index!, end: m.index! + m[0].length, strength: 'ident' })
  for (const m of text.matchAll(PASCAL)) add({ phrase: m[0], start: m.index!, end: m.index! + m[0].length, strength: 'proper' })
  for (const m of text.matchAll(PROPER)) {
    let phrase = m[0]
    let start = m.index!
    const words = phrase.split(/\s+/)
    // "Fix the Old Market", "Rename the Activity page": a sentence's first word before "the" is a verb, not a name.
    if (sentenceStart(text, start) && words.length > 1 && (COMMON.has(words[0]!.toLowerCase()) || words[1] === 'the')) {
      let k = 1
      while (k < words.length - 1 && /^(?:of|the|de|la|du)$/.test(words[k]!)) k++
      const skip = phrase.indexOf(words[k]!, words[0]!.length)
      start += skip
      phrase = phrase.slice(skip)
    }
    if (phrase.split(/\s+/).length === 1 && COMMON.has(phrase.toLowerCase())) continue
    add({ phrase, start, end: start + phrase.length, strength: 'proper' })
  }
  for (const m of text.matchAll(WORD)) {
    if (VAGUE.has(m[0]) || COMMON.has(m[0])) continue
    add({ phrase: m[0], start: m.index!, end: m.index! + m[0].length, strength: 'word' })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The draft's own spelling first (`inviteTeamMember` is not `InviteTeamMember`), then definitions first. */
function where(index: GroundIndex, entries: number[], phrase: string): { match: string; kind: EntryKind; files: string[] } {
  const rank = (i: number) => (index.vocab.entries[i]!.name === phrase ? 0 : 3) + WHERE_RANK[index.vocab.entries[i]!.kind]
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b))
  const files: string[] = []
  for (const i of sorted) {
    for (const f of index.vocab.entries[i]!.files) {
      const path = index.vocab.files[f]
      if (path && !files.includes(path)) files.push(path)
      if (files.length >= 2) break
    }
    if (files.length >= 2) break
  }
  const best = index.vocab.entries[sorted[0]!]!
  return { match: best.name, kind: best.kind, files }
}

/** Products and companies a prompt names in passing: "Claude Desktop", "GitHub Actions" are not the code's names. */
const BRANDS = new Set(['claude', 'codex', 'chatgpt', 'openai', 'anthropic', 'github', 'gitlab', 'vercel', 'netlify', 'google',
  'apple', 'microsoft', 'windows', 'macos', 'linux', 'ubuntu', 'chrome', 'firefox', 'safari', 'slack', 'notion', 'figma',
  'stripe', 'aws', 'azure', 'docker', 'kubernetes', 'react', 'next', 'vue', 'svelte', 'node', 'python', 'vscode', 'cursor',
  'twitter', 'discord', 'telegram', 'whatsapp', 'youtube', 'tiktok', 'instagram', 'linkedin', 'supabase', 'firebase', 'postgres'])

/** Head words that name a kind of thing, not a thing: "Codex Desktop App" says nothing about which app. */
const GENERIC_HEAD = new Set(['app', 'page', 'screen', 'view', 'panel', 'button', 'file', 'tool', 'list', 'table', 'form',
  'modal', 'dialog', 'window', 'tab', 'menu', 'card', 'row', 'field', 'section', 'component', 'module', 'service',
  'server', 'client', 'api', 'endpoint', 'script', 'test', 'model', 'store', 'hook', 'helper', 'util', 'manager',
  'handler', 'feature', 'mode', 'version', 'project', 'plugin', 'extension', 'system', 'setting', 'option', 'thing'])

/**
 * Code names close to one the draft uses. A name written in prose ("Old Market") is a near miss only of
 * names that share the word it ends on, the thing it names ("South of Market"); when that word only says
 * what kind of thing it is ("Desktop App"), they must share another word too. "Claude Desktop App" in a
 * Claude plugin is a product, not a misremembered `CLAUDE` constant.
 */
function nearest(index: GroundIndex, phrase: string, prose = false): { name: string; file: string }[] {
  const words = nameTokens(phrase)
  const head = words.at(-1) ?? ''
  const tokens = [...new Set(words)].filter((t) => t.length >= 4 || (prose && t === head && t.length >= 3))
  if (!tokens.length || (prose && !tokens.includes(head))) return []
  const generic = GENERIC_HEAD.has(head)
  const score = new Map<number, number>()
  for (const token of tokens) {
    for (const i of (index.byToken.get(token) ?? []).slice(0, 400)) score.set(i, (score.get(i) ?? 0) + 1)
  }
  // Ties go to names that end on the same word ("ActivityLog" for "Audit Log" before "logActivity").
  const endsLikePhrase = (i: number) => (nameTokens(index.vocab.entries[i]!.name).at(-1) === head ? 0 : 1)
  const ranked = [...score.entries()].sort(([a, sa], [b, sb]) => {
    if (sb !== sa) return sb - sa
    const ea = index.vocab.entries[a]!
    const eb = index.vocab.entries[b]!
    return endsLikePhrase(a) - endsLikePhrase(b) || NEAR_RANK[ea.kind] - NEAR_RANK[eb.kind] || ea.name.length - eb.name.length
  })
  const out: { name: string; file: string }[] = []
  const seen = new Set([nameKey(phrase)])
  for (const [i] of ranked) {
    const entry = index.vocab.entries[i]!
    const key = nameKey(entry.name)
    if (seen.has(key)) continue
    if (prose) {
      const theirs = nameTokens(entry.name)
      if (!theirs.includes(head)) continue
      if (generic && !theirs.some((t) => t !== head && !GENERIC_HEAD.has(t) && words.includes(t))) continue
    }
    seen.add(key)
    out.push({ name: entry.name, file: index.vocab.files[entry.files[0] ?? -1] ?? '' })
    if (out.length >= 3) break
  }
  return out
}

/**
 * The draft's mentions of code names. Found: anything that resolves. Missing:
 * only what clearly names something (a multi-word proper name the code has
 * related names for, a path, an identifier, a quoted name), never a common word.
 */
/** A path or file name as written in a draft, found in the file list: exactly, as the end of a path, or as a folder. */
function lookPath(index: GroundIndex, phrase: string): string[] {
  const path = phrase.replace(/^\.\//, '').replace(/\\/g, '/')
  if (!/[/.]/.test(path)) return []
  if (index.paths.has(path)) return [path]
  if (path.endsWith('/')) {
    const dir = index.vocab.files.find((file) => file.startsWith(path) || file.includes(`/${path}`))
    return dir ? [dir.slice(0, dir.indexOf(path) + path.length - 1)] : []
  }
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return (index.byBase.get(base) ?? []).map((i) => index.vocab.files[i]!)
    .filter((file) => !path.includes('/') || file.toLowerCase().endsWith(path.toLowerCase()))
}

/** Every file a name may mean: the draft's own spelling when the code has it, then its strongest kind of entry. */
function definedIn(index: GroundIndex, entries: number[], phrase: string): string[] {
  const exact = entries.filter((i) => index.vocab.entries[i]!.name === phrase)
  const pool = exact.length ? exact : entries
  const best = Math.min(...pool.map((i) => WHERE_RANK[index.vocab.entries[i]!.kind]))
  const files = pool.filter((i) => WHERE_RANK[index.vocab.entries[i]!.kind] === best)
    .flatMap((i) => index.vocab.entries[i]!.files.map((f) => index.vocab.files[f]!))
  return [...new Set(files)]
}

/** More files than this and a name says too little to ask which: the app's question panel takes four options. */
const MOST_PLACES = 4
const TESTISH = /(?:^|\/)(?:tests?|specs?|__tests__|__mocks__|mocks?|fixtures?|examples?|e2e|stories)(?:\/|$)|\.(?:test|spec|stories|e2e)\.[a-z]+$/i
const TALKS_TESTS = /\b(?:tests?|specs?|fixtures?|mocks?|examples?|stories)\b/i

/**
 * Which of several files a name written as code means, as far as the draft says: another name it uses that lives
 * in one of them, or a word only some of their paths have ("the payments actions.ts"). A test or example copy is
 * not what a draft means unless it speaks of one. One file left: the name points there. Several: `places`.
 */
function settle(mention: Mention, files: string[], elsewhere: Set<string>, text: string): void {
  const narrow = (from: string[], keep: (file: string) => boolean) => {
    const kept = from.filter(keep)
    return kept.length ? kept : from
  }
  let left = TALKS_TESTS.test(text) ? files : narrow(files, (file) => !TESTISH.test(file))
  left = narrow(left, (file) => elsewhere.has(file))
  const parts = (file: string) => new Set(file.split('/').flatMap((part) => nameTokens(part.replace(/\.[^.]+$/, ''))))
  const shared = left.map(parts).reduce((a, b) => new Set([...a].filter((t) => b.has(t))))
  const own = new Set(nameTokens(mention.phrase))
  const words = new Set(nameTokens(text).filter((t) => !shared.has(t) && !own.has(t) && !VAGUE.has(t) && !COMMON.has(t)))
  left = narrow(left, (file) => [...parts(file)].some((t) => words.has(t)))
  if (left.length === 1) {
    mention.files = [left[0]!, ...mention.files.filter((file) => file !== left[0])].slice(0, 2)
    return
  }
  left.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  mention.files = left.slice(0, 2)
  mention.places = left.length <= MOST_PLACES ? left : []
}

/**
 * "rename X to drawCard", "a flag called --json", "add a new Exporter": a name being introduced, not one the
 * code lacks. "to" counts only after a renaming verb in the same sentence: "a button to the Audit Log page"
 * points at something that should exist.
 */
const NAMED_HERE = /\b(?:named|called|new|create|creating|add|adding|introduce|introducing)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?[`'"\u2018\u201C]?$/i
const RENAMED_TO = /\b(?:rename|renamed|renaming|change|changed|changing|move|moved|moving|turn|turned|convert|converted)\b[^.!?\n]{0,60}?\b(?:to|into|as)\s+(?:(?:a|an|the)\s+)?[`'"\u2018\u201C]?$/i
const introduced = (before: string) => NAMED_HERE.test(before) || RENAMED_TO.test(before)

export function ground(text: string, index: GroundIndex | null): Mention[] {
  if (!index || !text.trim()) return []
  const out: Mention[] = []
  const seen = new Set<string>()
  /** Names written as code that the code has in several files, settled once every name is known. */
  const spread = new Map<Mention, string[]>()
  for (const c of candidates(text)) {
    const key = nameKey(c.phrase)
    if (key.length < 2 || seen.has(key)) continue
    if (c.strength === 'code' || c.strength === 'prose') {
      const files = lookPath(index, c.phrase)
      if (files.length) {
        seen.add(key)
        const mention: Mention = { phrase: c.phrase, start: c.start, end: c.end, status: 'found', match: c.phrase, kind: 'path', as: c.strength === 'code' ? 'code' : 'word', files: files.slice(0, 2), near: [] }
        out.push(mention)
        if (c.strength === 'code' && files.length > 1) spread.set(mention, files)
        continue
      }
    }
    const hits = index.byKey.get(key) ?? []
    const single = !/\s/.test(c.phrase.trim())
    const usable = c.strength === 'word'
      // A lowercase word links only to a type of that name (Vehicle for "vehicles").
      ? hits.filter((i) => index.vocab.entries[i]!.kind === 'symbol' && /^[A-Z][a-z]/.test(index.vocab.entries[i]!.name))
      // A capitalised word matching nothing but a file name (Codex, codex.mjs) is a coincidence, not a link.
      : (c.strength === 'proper' || c.strength === 'quoted') && single ? hits.filter((i) => !index.vocab.entries[i]!.stem)
      : hits
    const as = c.strength === 'code' || c.strength === 'ident' ? 'code' : c.strength === 'word' || c.strength === 'prose' ? 'word' : 'name'
    if (usable.length) {
      seen.add(key)
      const { match, kind, files } = where(index, usable, c.phrase)
      const mention: Mention = { phrase: c.phrase, start: c.start, end: c.end, status: 'found', match, kind, as, files, near: [] }
      out.push(mention)
      const all = as === 'code' ? definedIn(index, usable, c.phrase) : []
      if (all.length > 1) spread.set(mention, all)
      continue
    }
    const multi = c.phrase.trim().split(/\s+/).length >= 2
    if (c.strength === 'prose') continue
    if (introduced(text.slice(Math.max(0, c.start - 90), c.start))) continue
    if (c.strength === 'proper' && BRANDS.has(nameTokens(c.phrase)[0] ?? '')) continue
    const near = c.strength === 'word' ? [] : nearest(index, c.phrase, c.strength === 'proper' || c.strength === 'quoted')
    const names = c.strength === 'code' || c.strength === 'ident' ||
      (c.strength === 'quoted' && /\p{Lu}/u.test(c.phrase)) ||
      (c.strength === 'proper' && multi && near.length > 0)
    if (!names) continue
    seen.add(key)
    out.push({ phrase: c.phrase, start: c.start, end: c.end, status: 'missing', as, files: [], near })
  }
  // Only a resolved name can point another name at a file.
  const elsewhere = new Set(out.filter((m) => m.status === 'found' && !spread.has(m) && (m.as === 'code' || m.files.length === 1))
    .flatMap((m) => m.files.slice(0, 1)))
  for (const [mention, files] of spread) settle(mention, files, elsewhere, text)
  return out
}

// ---- folders that may already do what the draft asks --------------------------------

/** Words too common to say which folder a draft is about. */
const FOLDER_STOP = new Set(`this that with from have will your what when them they then than into just only also
some more most very much make need want even each able main work part deep deeply level depth give idea meant
focus example these those there their should would could must nothing happen something takes seeing going
through about after before because where which while being does done other another every thing things find
know like look looks really still sure time times used using well were here mean means note please`.split(/\s+/))

function stem(word: string): string {
  let w = word
  if (w.length > 5 && w.endsWith('ing')) {
    w = w.slice(0, -3)
    if (/([^aeiou])\1$/.test(w)) w = w.slice(0, -1)
  } else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (w.length > 4 && /(s|x|ch|sh)es$/.test(w)) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  return w
}

const folderCache = new WeakMap<GroundIndex, Map<string, string[]>>()

function folders(index: GroundIndex): Map<string, string[]> {
  let found = folderCache.get(index)
  if (found) return found
  found = new Map()
  for (const path of index.vocab.files) {
    const at = path.lastIndexOf('/')
    if (at < 1 || !SOURCE_EXT.test(path)) continue
    const dir = path.slice(0, at)
    const list = found.get(dir)
    if (list) list.push(path.slice(at + 1))
    else found.set(dir, [path.slice(at + 1)])
  }
  folderCache.set(index, found)
  return found
}

/**
 * Folders whose name matches a word of the draft ("logging" finds runlog/,
 * "threats" finds threat/): what the code may already have for the request.
 */
export function relatedFolders(text: string, index: GroundIndex, most = 4): { dir: string; files: string[] }[] {
  // The project's own name is in half its folder names and says nothing about which one the draft means.
  const own = new Set(index.vocab.project ? [nameKey(index.vocab.project), ...nameTokens(index.vocab.project)] : [])
  const stems = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (FOLDER_STOP.has(word) || own.has(word)) continue
    const s = stem(word)
    if (s.length >= 3 && !FOLDER_STOP.has(s) && !own.has(s)) stems.add(s)
  }
  if (!stems.size) return []
  const all = folders(index)
  const matches = (base: string, s: string, tokens: Set<string>) => tokens.has(s) ||
    base.endsWith(s) && base.length - s.length >= 2 || base.startsWith(s) && base.length - s.length <= 3
  // A word that matches many folders (four or more) does not single any of them out.
  for (const s of [...stems]) {
    let hits = 0
    for (const dir of all.keys()) {
      const base = dir.slice(dir.lastIndexOf('/') + 1).toLowerCase()
      if (matches(base, s, new Set([base, stem(base), ...nameTokens(base)]))) hits++
    }
    if (hits >= 4) stems.delete(s)
  }
  if (!stems.size) return []
  const scored: { dir: string; files: string[]; score: number }[] = []
  for (const [dir, files] of all) {
    if (files.length < 2) continue
    const base = dir.slice(dir.lastIndexOf('/') + 1).toLowerCase()
    const tokens = new Set([base, stem(base), ...nameTokens(base)])
    let score = 0
    for (const s of stems) if (matches(base, s, tokens)) score++
    if (score) scored.push({ dir, files: files.slice(0, 5), score })
  }
  return scored.sort((a, b) => b.score - a.score || b.files.length - a.files.length || a.dir.length - b.dir.length)
    .slice(0, most).map(({ dir, files }) => ({ dir, files }))
}

// ---- building the vocabulary from what the host collected -----------------------

export const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|rb|php|scala|lua|gd|ex|exs|clj|hs|ml|dart|vue|svelte|astro|sql|proto|graphql|sh)$/i
const ID = /[A-Za-z_$][A-Za-z0-9_$]*$/
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|vendor|\.git|target|coverage|__pycache__|\.next|\.venv|venv)(\/|$)/

/**
 * `files`: repo-relative paths (`git ls-files`). `declarations`: `path:line:match`
 * lines whose match ends in a declared name. `names`: `path:line:'Quoted Name'`
 * lines. Entries are capped so a huge repo stays a few megabytes.
 */
export function buildVocabulary(input: { files: string[]; declarations: string; names: string; project?: string }, limit = 60000): Vocabulary {
  const files = input.files.filter((path) => path && !SKIP_DIR.test(path))
  const fileIndex = new Map(files.map((path, i) => [path, i]))
  const entries = new Map<string, VocabEntry>()
  const add = (name: string, kind: EntryKind, path: string, stem = false) => {
    if (name.length < 2 || name.length > 60) return
    const f = fileIndex.get(path)
    if (f === undefined) return
    const id = `${kind}:${name}`
    let entry = entries.get(id)
    if (!entry) {
      if (entries.size >= limit) return
      entry = { name, kind, files: [], ...(stem && { stem: true as const }) }
      entries.set(id, entry)
    } else if (!stem) delete entry.stem
    if (!entry.files.includes(f) && entry.files.length < 12) entry.files.push(f)
  }
  for (const line of input.declarations.split('\n')) {
    const m = /^(.+?):\d+:(.*)$/.exec(line)
    if (!m) continue
    const name = ID.exec(m[2]!.trim())?.[0]
    if (name) add(name, 'symbol', m[1]!)
  }
  for (const line of input.names.split('\n')) {
    const m = /^(.+?):\d+:["'`](.+)["'`]$/.exec(line)
    if (m) add(m[2]!.trim(), 'name', m[1]!)
  }
  const dirs = new Map<string, number>()
  for (const path of files) {
    const parts = path.split('/')
    const file = parts.at(-1)!
    const source = SOURCE_EXT.test(file)
    const stem = file.replace(/\.[^.]+$/, '')
    if (stem && stem !== 'index' && source) add(stem, 'path', path, true)
    for (let i = 0; i < parts.length - 1; i++) {
      add(parts[i]!, 'path', path)
      if (source) {
        const dir = parts.slice(0, i + 1).join('/')
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
      }
    }
  }
  return { files, entries: [...entries.values()], map: repoMap(files, dirs), ...(input.project && { project: input.project }) }
}

/** The folders that hold the code, most files first, each with a few of its files: a page the model reads. */
export function repoMap(files: string[], dirs: Map<string, number>, budget = 3200): string {
  const leafy = [...dirs.entries()]
    .filter(([dir, n]) => n >= 2 && dir.split('/').length <= 4)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const lines: string[] = []
  let size = 0
  for (const [dir, n] of leafy) {
    // A folder whose code all sits in one child adds nothing over that child.
    const depth = dir.split('/').length
    const children = leafy.filter(([other]) => other.startsWith(`${dir}/`) && other.split('/').length === depth + 1)
    if (children.length === 1 && children[0]![1] === n) continue
    const own = files.filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/') && SOURCE_EXT.test(path))
      .map((path) => path.slice(dir.length + 1)).slice(0, 6)
    const line = `${dir}/ (${n})${own.length ? `: ${own.join(', ')}` : ''}`
    if (size + line.length > budget) break
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

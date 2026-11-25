import type { EngineInterface } from 'claude-code'
import { editorSides, readHunks, relatedPatch, sidePath } from './edit-patch'
import type { RelatedFile } from './edit-patch'
import { relateEdits } from './edit-relation'
import type { ReadRelation, ReceiptChoice } from './edit-relation'
import { editedFiles } from './turn-edits'
import type { TurnEdits } from './turn-edits'

type OpenIO = Pick<EngineInterface, 'env' | 'fs' | 'process'>

async function makeEditDirectory($: OpenIO): Promise<string> {
  if (await $.env.get('OS').catch(() => undefined) === 'Windows_NT') {
    const temp = await $.env.get('TEMP').catch(() => undefined) ?? await $.env.get('TMP').catch(() => undefined)
    if (temp) return `${temp.replace(/[\\/]+$/, '')}/margincue-${crypto.randomUUID()}`
  }
  const result = await $.process.run(['mktemp', '-d'], { timeoutMs: 2000 })
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('No temporary directory')
  return result.stdout.trimEnd()
}

function editorCommand(terminal: string, integration: string): string | undefined {
  if (terminal === 'cursor' || terminal === 'windsurf') return terminal
  if (terminal === 'vscode-insiders') return 'code-insiders'
  if (terminal !== 'vscode' && terminal !== 'code') return undefined
  // Forks can report the inherited TERM_PROGRAM. The shell integration path identifies the host.
  if (/[\\/]\.?windsurf(?:\.app|-server)?[\\/]/i.test(integration)) return 'windsurf'
  if (/[\\/]\.?cursor(?:\.app|-server)?[\\/]/i.test(integration)) return 'cursor'
  if (/insiders(?:\.app|[\\/])/i.test(integration)) return 'code-insiders'
  return 'code'
}

function editorArgs(value: string): string[] {
  // VISUAL and EDITOR can contain flags and quoted paths. Pass argv directly, so the diff path is never shell code.
  return (value.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []).map((arg) => arg.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double))
}

async function launch($: OpenIO, argv: string[]): Promise<boolean> {
  try {
    return (await $.process.run(argv, { timeoutMs: 3000 })).exitCode === 0
  } catch {
    return false
  }
}

/** Try the editor's CLI on PATH. Return the patch path when the terminal needs to print it. */
export async function openRelatedFiles($: OpenIO, dir: string, related: readonly RelatedFile[]): Promise<string | undefined> {
  const terminal = (await $.env.get('TERM_PROGRAM').catch(() => undefined))?.toLowerCase() ?? ''
  let integration = ''
  if (terminal === 'vscode' || terminal === 'code') {
    integration = await $.env.get('VSCODE_GIT_ASKPASS_MAIN').catch(() => undefined) ?? ''
    if (!integration) {
      const path = await $.env.get('PATH').catch(() => undefined) ?? ''
      // App-supplied CLI directories also identify the fork when Git integration is off.
      integration = path.match(/[^:;]*[\\/](?:resources[\\/]app[\\/]bin|\.?(?:cursor|windsurf)-server[\\/][^:;]*)/i)?.[0] ?? ''
    }
  }
  const cli = editorCommand(terminal, integration)
  const fallback: RelatedFile[] = []
  for (const match of related) {
    const sides = cli && editorSides(match)
    if (cli && sides && sides.before !== sides.after) {
      const left = sidePath(dir, 'before', match.file.path)
      const right = sidePath(dir, 'after', match.file.path)
      await Promise.all([$.fs.write(left, sides.before), $.fs.write(right, sides.after)])
      if (await launch($, [cli, '--diff', left, right])) continue
    }
    fallback.push(match)
  }
  if (!fallback.length) return undefined

  const patch = `${dir}/related-edits.diff`
  await $.fs.write(patch, relatedPatch(fallback))
  const editors = new Set(await Promise.all([$.env.get('VISUAL').catch(() => undefined), $.env.get('EDITOR').catch(() => undefined)]))
  for (const editor of editors) {
    const args = editorArgs(editor ?? '')
    if (args[0] && await launch($, [...args, patch])) return undefined
  }
  return patch
}

export async function openChoiceEdits($: OpenIO, turn: TurnEdits, choice: ReceiptChoice, read: ReadRelation): Promise<{
  found: boolean; path?: string
}> {
  const files = await editedFiles($, turn)
  if (!files.length) return { found: false }
  const dir = await makeEditDirectory($)
  for (let i = 0; i < files.length; i += 6) {
    await Promise.all(files.slice(i, i + 6).map((file) => readHunks($, dir, file)))
  }
  const related = await relateEdits(files, choice, read)
  return related.length ? { found: true, path: await openRelatedFiles($, dir, related) } : { found: false }
}

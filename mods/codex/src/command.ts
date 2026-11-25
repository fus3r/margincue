import { statSync } from 'node:fs'
import { win32 } from 'node:path'

type Command = { command: string; args: string[]; options: { windowsVerbatimArguments?: boolean } }

/** `file` with `args`, as spawn takes them on this platform. */
export function runnable(file: string, args: string[], cwd?: string): Command {
  return process.platform === 'win32'
    ? windowsCommand(file, args, process.env, fileExists, win32.resolve(cwd ?? '.'))
    : { command: file, args, options: {} }
}

/** Prepares a Windows spawn using the supplied environment and file lookup. */
export function windowsCommand(file: string, args: string[], env: NodeJS.ProcessEnv, isFile: (path: string) => boolean, cwd: string): Command {
  const found = findProgram(file, env, isFile, cwd)
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { command: found ?? file, args, options: {} }
  if (args.some((arg) => /[\r\n]/.test(arg))) throw new Error('Cannot pass line breaks through a Windows batch file')
  // Like cross-spawn's npm shim handling, escape the arguments for both cmd.exe parses.
  // The second parse happens when the shim forwards %* to the executable.
  const line = [caret(found), ...args.map((arg) => caret(caret(quoteArg(arg))))].join(' ')
  return { command: variable(env, 'COMSPEC') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } }
}

function findProgram(file: string, env: NodeJS.ProcessEnv, isFile: (path: string) => boolean, cwd: string): string | null {
  const extensions = (variable(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const names = extensions.map((ext) => file + ext)
  if (win32.extname(file)) names.unshift(file)
  // Bare commands use PATH. A relative path is resolved from the child's working directory.
  const folders = /[\\/]/.test(file) ? [''] : (variable(env, 'PATH') ?? '').split(';').filter(Boolean)
  for (const folder of folders) {
    for (const name of names) {
      const path = win32.resolve(cwd, folder.replace(/^"(.*)"$/, '$1'), name)
      if (isFile(path)) return path
    }
  }
  return null
}

/** A variable whatever the case of its name: Windows has Path, and a copy of process.env is case-sensitive. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name]
}

function fileExists(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    return false
  }
}

/**
 * One argument as the program reads it back (the C runtime's rules): in quotes, each quote escaped with a backslash,
 * and the backslashes before a quote or before the closing quote doubled. Other backslashes stay as they are.
 */
function quoteArg(arg: string): string {
  let quoted = '"'
  let slashes = 0
  for (const char of arg) {
    if (char === '\\') {
      slashes++
      continue
    }
    quoted += char === '"' ? `${'\\'.repeat(2 * slashes + 1)}"` : `${'\\'.repeat(slashes)}${char}`
    slashes = 0
  }
  return `${quoted}${'\\'.repeat(2 * slashes)}"`
}

/** A caret before each character cmd.exe acts on: it reads them as text, and drops the carets. */
const caret = (text: string) => text.replace(/[()[\]%!^"`<>&|;, \t*?]/g, '^$&')

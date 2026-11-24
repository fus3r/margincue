// Starting Codex through margincue-relay, so the card sits under Codex's prompt box and
// follows the draft as it is typed. Whenever the relay cannot run (Windows, no terminal,
// no binary, turned off), `margincue codex` starts Codex as before and ctrl+g opens the card.

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { PROTOCOL, serveBand } from './band'
import { PATHS, readSettings } from './store'
import { VERSION } from './version'

export const RELAY = join(PATHS.bin, 'margincue-relay')
/** The relay version this copy of MarginCue ships with (crates/margincue-relay/Cargo.toml). */
const RELAY_VERSION = '0.1.1'
const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'

/** Top-level Codex options that take a value. */
const VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'])
/** Subcommands that run without Codex's full-screen view. */
const PLAIN = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server', 'remote-control', 'app',
  'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts',
  'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help', 'proto'])

/** The folder Codex works in when these arguments open its full-screen view; null for any other command. */
export function interactive(args: string[], cwd = process.cwd()): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (arg === '-h' || arg === '--help' || arg === '-V' || arg === '--version') return null
    if (arg.startsWith('-')) {
      const [name, inline] = arg.split(/=(.*)/s, 2)
      if (VALUE_OPTIONS.has(name!)) {
        const value = inline ?? args[++i]
        if ((name === '-C' || name === '--cd') && value) cwd = resolve(cwd, value)
      }
      continue
    }
    // The first word that is not an option: a subcommand, or the opening prompt.
    return PLAIN.has(arg) ? null : cwd
  }
  return cwd
}

/** The relay binary to use, or null when Codex should start bare. */
export function findRelay(env: NodeJS.ProcessEnv = process.env): string | null {
  const choice = env['MARGINCUE_RELAY']
  if (choice === 'off' || choice === '0' || !SUPPORTED) return null
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  if ((readSettings() as { relay?: boolean }).relay === false) return null
  const path = choice || RELAY
  return relayWorks(path) ? path : null
}

function relayWorks(path: string): boolean {
  if (!existsSync(path)) return false
  const version = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 3000 })
  return version.status === 0 && version.stdout.includes(`protocol ${PROTOCOL}`)
}

/** Runs Codex under the relay; false when it did not start (the caller starts Codex bare). */
export function startRelay(relay: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  const cwd = interactive(args)
  if (!cwd) return false
  let child
  try {
    child = spawn(relay, ['--fd', '3', '--', 'codex', ...args], { stdio: ['inherit', 'inherit', 'inherit', 'pipe'], env })
  } catch {
    return false
  }
  const link = child.stdio[3] as Duplex | null
  if (!link) {
    child.kill()
    return false
  }
  const band = serveBand(link, cwd)
  child.on('exit', (code, signal) => {
    band.close()
    process.exit(code ?? (signal ? 128 + (SIGNALS[signal] ?? 1) : 1))
  })
  child.on('error', (error) => {
    band.close()
    process.stderr.write(`margincue: the relay could not start (${error.message}).\n`)
    process.exit(1)
  })
  return true
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }

// ---- installing the binary ---------------------------------------------------------------

const RELEASES = 'https://github.com/fus3r/margincue/releases/download'

function asset(): string | null {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  return os && arch ? `margincue-relay-${os}-${arch}` : null
}

/**
 * Puts the relay in ~/.margincue/bin: the release build for this version, else a local
 * build when this copy of MarginCue has its sources and Rust is installed.
 */
export async function installRelay(say: (line: string) => void, source = sourceRoot()): Promise<boolean> {
  if (!SUPPORTED) {
    say('   Not on Windows yet: ctrl+g in Codex opens the card.')
    return false
  }
  if (relayWorks(RELAY) && spawnSync(RELAY, ['--version'], { encoding: 'utf8' }).stdout.includes(`relay ${RELAY_VERSION}`)) {
    say('   Already installed.')
    return true
  }
  mkdirSync(PATHS.bin, { recursive: true })
  const name = asset()
  if (name) {
    try {
      const url = `${RELEASES}/v${VERSION}/${name}`
      const [binary, sum] = await Promise.all([fetchBytes(url), fetchBytes(`${url}.sha256`)])
      const expected = sum.toString('utf8').trim().split(/\s+/)[0]
      if (createHash('sha256').update(binary).digest('hex') !== expected) throw new Error('checksum mismatch')
      const temp = `${RELAY}.download`
      writeFileSync(temp, binary)
      chmodSync(temp, 0o755)
      renameSync(temp, RELAY)
      if (relayWorks(RELAY)) {
        say(`   Installed ${name} ${VERSION}.`)
        return true
      }
    } catch {}
  }
  if (source && spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0) {
    say('   Building it from source with cargo (a minute or two)…')
    const manifest = join(source, 'crates', 'margincue-relay', 'Cargo.toml')
    const built = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest], { stdio: 'ignore' })
    const output = join(source, 'crates', 'margincue-relay', 'target', 'release', 'margincue-relay')
    if (built.status === 0 && existsSync(output)) {
      copyFileSync(output, `${RELAY}.download`)
      chmodSync(`${RELAY}.download`, 0o755)
      renameSync(`${RELAY}.download`, RELAY)
      if (relayWorks(RELAY)) {
        say('   Built and installed.')
        return true
      }
    }
  }
  say('   Could not install it: ctrl+g in Codex opens the card instead.')
  return false
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** The package root when this file runs from a checkout (dist/ next to the sources). */
function sourceRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = resolve(here, '..', '..', '..')
    return existsSync(join(root, 'crates', 'margincue-relay', 'Cargo.toml')) ? root : null
  } catch {
    return null
  }
}

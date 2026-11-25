import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const LAYOUT_PATHS = ['app/layout.tsx', 'app/dashboard/layout.tsx']

export function layoutProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'margincue-project-'))
  // A Git work tree gives the card a project index even without ripgrep.
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const path of LAYOUT_PATHS) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'export default function Layout() {}\n')
  }
  return root
}

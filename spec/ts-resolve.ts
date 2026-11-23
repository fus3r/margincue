// The core's modules import each other without file extensions, as the Claude
// Code mod loader expects. Node resolves ESM specifiers exactly, so scripts that
// load the core under node register this hook first and then import the core
// dynamically: `.ts` (then `/index.ts`) is tried for an extensionless relative or absolute path.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!/^(\.{1,2}\/|\/|file:)/.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw error
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        try {
          return nextResolve(specifier + suffix, context)
        } catch {}
      }
      throw error
    }
  },
})

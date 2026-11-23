// MarginCue core, TypeScript. Pure: no clock, no I/O, no host types.
export { Core, createCore, DEFAULT_TIMING, isHostCommand, NOTE_PICK_DROPPED, sameCue } from './core'
export { applyDecisions, attachDecisions, decisionLine, fillStatement, splitDecisions } from './decisions'
export { diffSplice, resolveAnchor, shiftSpan, spliceFits } from './anchor'
export type { Span } from './anchor'
export { Lru } from './lru'
export { foldCase, normalize, parseCueLine, parseReply, unquote } from './parse'
export { parseProfile } from './profile'
export { buildPrompt, buildSystem, formatExample, isTerminated, lastSentenceStart } from './request'
export type * from './types'

export * from './bundle'
export * from './state'

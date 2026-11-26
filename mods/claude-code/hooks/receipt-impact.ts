import { choiceTier } from '../core/choice-tier'
import type { ReceiptView } from '../core/types'
import { nameKey } from '../core/grounding'
import { namedPaths } from './edit-relation'
import type { CapturedChoiceEdit, ChoiceMark } from './turn-edits'

/** A named path or an unambiguous interval after the mark counts as related. */
export function rankReceiptEdits(
  choices: ReceiptView['agent'], edits: readonly CapturedChoiceEdit[], marks: ReadonlyMap<string, ChoiceMark>,
): ReceiptView['agent'] {
  if (!edits.length) return choices
  const paths = [...new Set(edits.map((edit) => edit.path))]
  const positions = [...marks.values()].map((mark) => mark.position)
  return choices.map((choice) => {
    if (choice.tier === 'high') return choice
    const mark = marks.get(nameKey(choice.label))
    const named = namedPaths(paths, `${choice.label} ${choice.value} ${mark?.words ?? ''}`)
    const start = mark?.position
    const unambiguous = start !== undefined && positions.indexOf(start) === positions.lastIndexOf(start)
    const end = unambiguous ? Math.min(Infinity, ...positions.filter((position) => position > start)) : 0
    const related = edits.filter((edit) => named.has(edit.path) ||
      (unambiguous && edit.position !== undefined && start < edit.position && edit.position < end))
    const tier = related.length ? choiceTier(`${choice.label}: {}`, choice.value, related) : choice.tier
    return tier === choice.tier ? choice : { ...choice, tier }
  })
}

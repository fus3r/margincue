import { isMigrationPath, scoreChoice } from '../core/review-first'
import type { ReviewContext } from '../core/review-first'
import type { ReceiptView } from '../core/types'
import { nameKey } from '../core/grounding'
import { namedPaths } from './edit-relation'
import type { CapturedChoiceEdit, ChoiceMark } from './turn-edits'

/** Named paths take precedence over edit order when scoring a choice. */
export function reviewReceiptEdits(choices: ReceiptView['agent'], context: ReviewContext,
  edits: readonly CapturedChoiceEdit[], marks: ReadonlyMap<string, ChoiceMark>, files: readonly string[] = [],
): ReceiptView['agent'] {
  const paths = [...new Set([...files, ...edits.map((edit) => edit.path)])]
  const changed = edits.filter((edit) => edit.changed || edit.matched)
  const migrations = [...new Set(changed.map(({ path }) => path).filter(isMigrationPath))]
  const positions = [...marks.values()].map((mark) => mark.position)
  return choices.map((choice) => {
    const mark = marks.get(nameKey(choice.label))
    const statement = `${choice.label} ${choice.value}`
    const named = namedPaths(paths, `${statement} ${mark?.words ?? ''}`)
    // A generic mention identifies a path only when exactly one migration was edited.
    if (!named.size && migrations.length === 1 && /\bmigration file\b/i.test(statement)) named.add(migrations[0]!)
    const kind = named.size ? 'named' : 'timing'
    const start = mark?.position
    const unambiguous = start !== undefined && positions.indexOf(start) === positions.lastIndexOf(start)
    const end = unambiguous ? Math.min(Infinity, ...positions.filter((position) => position > start)) : 0
    const linked = changed.filter(({ path, position }) => kind === 'named' ? named.has(path)
      : unambiguous && position !== undefined && start < position && position < end)
    const review = scoreChoice({ ...choice, switched: choice.review?.signals.switched }, context, { kind, edits: linked })
    return { ...choice, review }
  })
}

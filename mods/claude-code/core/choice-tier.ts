import { isHardToUndo } from './hard-to-undo'

export const CHOICE_TIERS = ['high', 'mid', 'low'] as const
export type ChoiceTier = typeof CHOICE_TIERS[number]
export type ChoiceEdit = { path: string; deleted?: boolean; publicInterface?: boolean }

const DEPENDENCIES = /^(?:(?:package(?:-lock)?|npm-shrinkwrap|composer)\.json|pnpm-lock\.yaml|(?:yarn|uv|poetry|composer|pipfile|gemfile|cargo|mix)\.lock|bun\.lockb?|(?:cargo|pyproject)\.toml|pipfile|gemfile|go\.(?:mod|sum)|requirements(?:-[\w-]+)?\.txt|pom\.xml|build\.gradle(?:\.kts)?|mix\.exs|package\.resolved)$/
const SCHEMA = /(?:^|\/)(?:migrations?|alembic\/versions)\/|(?:^|[/._-])schemas?(?:\.\w+)?\.(?:json|ya?ml|sql|prisma|graphql|gql)$|\.(?:prisma|proto)$/
const POLICY = /(?:^|\/)(?:auth|authentication|authorization|permissions?|rbac)\/|(?:^|\/)(?:(?:auth|authentication|authorization|permissions?|rbac|iam)(?:[.-](?:config|policy|rules?))?\.[\w.]+|codeowners|firestore\.rules|storage\.rules|\.htaccess)$/
const INTERFACE = /^(?:openapi|swagger)(?:[-.]v?\d+)?\.(?:json|ya?ml)$|\.d\.[cm]?ts$/
const SHARED_CONFIG = /(?:^|\/)(?:\.github\/workflows|\.circleci|\.config)\/|(?:^|\/)(?:\.gitignore|\.gitattributes|\.editorconfig|\.env(?:\.example)?|dockerfile|(?:docker-)?compose\.ya?ml|(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json|(?:eslint|prettier|vite|webpack|next|babel|jest|vitest)\.config\.[\w.]+|pnpm-workspace\.yaml)$/
const DATA_FORMAT = /^(?:serialization|deserialization|wire-format)\.[\w.]+$|\.(?:csv|tsv|jsonl|ndjson|parquet|avro)$/
const SUPPORT = /(?:^|\/)(?:__tests__|tests?|specs?|fixtures?|examples?|docs)\/|\.(?:test|spec)\.[\w.]+$/

export function choiceTier(statement: string, value: string, edits: readonly ChoiceEdit[] = []): ChoiceTier {
  if (isHardToUndo(statement, value)) return 'high'
  const paths = new Set<string>()
  const modules = new Set<string>()
  let shared = false
  for (const edit of edits) {
    if (edit.deleted || edit.publicInterface) return 'high'
    const path = edit.path.replace(/\\/g, '/').toLowerCase()
    paths.add(path)
    if (SUPPORT.test(path)) continue
    const slash = path.lastIndexOf('/')
    const name = path.slice(slash + 1)
    if (DEPENDENCIES.test(name) || SCHEMA.test(path) || POLICY.test(path) || INTERFACE.test(name)) return 'high'
    if (SHARED_CONFIG.test(path) || DATA_FORMAT.test(name)) shared = true
    if (slash !== -1) modules.add(path.slice(0, slash))
  }
  return shared || paths.size >= 3 || modules.size >= 2 ? 'mid' : 'low'
}

export function rankedChoices<T extends { tier: ChoiceTier }>(choices: readonly T[]): T[] {
  return CHOICE_TIERS.flatMap((tier) => choices.filter((choice) => choice.tier === tier))
}

export function tierCounts(choices: readonly { tier: ChoiceTier }[]): string {
  const counts = { high: 0, mid: 0, low: 0 }
  for (const { tier } of choices) counts[tier]++
  return CHOICE_TIERS.map((tier) => `${counts[tier]} ${tier}`).join(' · ')
}

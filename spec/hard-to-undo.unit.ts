import assert from 'node:assert/strict'
import { test } from 'node:test'
import './ts-resolve.ts'

const { isHardToUndo } = await import('../mods/claude-code/core/hard-to-undo')

const open = [
  ['After {}, the agent will permanently delete the team in a scheduled job', '30 days'],
  ['Expired accounts are {}', 'hard-deleted nightly'],
  ['Retire inactive accounts with {}', 'a scheduled cleanup job'],
  ['For expired exports, {}', 'run a nightly purge job'],
  ['Past retention, {}', 'delete stored audit logs'],
  ['After the import, {}', 'drop the legacy email column'],
  ['Reset stale staging data by running {}', 'TRUNCATE TABLE events'],
  ['On conflict, {}', 'overwrite `config.json`'],
  ['Fix the published commits by {}', 'rewriting the git history'],
  ['Ship the storage update with {}', 'a schema migration'],
  ['Before enabling the flag, {}', 'apply the Prisma migration'],
  ['Backfill {} from the old store', 'the archived rows'],
  ['For CSV parsing, {}', 'add papaparse as a dependency'],
  ['For charts, {}', 'npm install chart.js'],
  ['For the next refresh, {}', 'add @sentry/node'],
  ['Before cutting a release, {}', 'upgrade React to 19.2'],
  ['Before cutting a release, {}', 'upgrade pinned runtime dependencies'],
  ['When the report ships, {}', 'rename the public API endpoint'],
  ['After the client rolls out, {}', 'remove `/api/v1/reports`'],
  ['For existing exports, {}', 'change the documented CSV headers'],
  ['In the next release, {}', 'remove the existing CLI flag'],
  ['For admin accounts, {}', 'require MFA'],
  ['For contractors, {}', 'revoke write access'],
  ['At the end of onboarding, {}', 'send an email to the team owners'],
  ['At invoice time, {}', 'charge the customer’s card'],
  ['After the smoke tests, {}', 'deploy the API to production'],
  ['When the build is green, {}', 'publish the package to npm'],
] as const

const bind = [
  ['Allow each token {} requests per minute', '60'],
  ['Use {} per page', '50 rows'],
  ['Show {} of chart history', 'the last 90 days'],
  ['Place the export button {}', 'beside the filters'],
  ['Make the summary cards {}', 'more compact'],
  ['Change pagination on the public API to {}', '50 rows per page'],
  ['For expired teams, {}', 'soft-delete the team'],
  ['After {}, never delete the team', '30 days'],
  ['Keep the export history and {}', 'do not purge audit logs'],
  ['The nightly purge job will {}', 'report matched rows only'],
  ['The scheduled cleanup job runs {}', 'in dry-run mode'],
  ['Permanently delete the expired teams {}', 'never'],
  ['Drop {} from the table preview', 'the timestamp column'],
  ['Truncate product names at {}', '60 characters'],
  ['Import the file {}', 'without overwriting the existing file'],
  ['Show {} on the audit page', 'schema migration status'],
  ['The schema migration will {}', 'remain disabled'],
  ['Read the migration report {}', 'as plain text'],
  ['Use {} for form validation', 'the existing zod dependency'],
  ['Add {} to the dependency graph', 'a version badge'],
  ['Bump {} by one', 'the batch size'],
  ['Keep the existing public API and {}', 'add a per-client limit'],
  ['Change the authentication button label to {}', 'Sign in'],
  ['Show the permissions {}', 'in a table'],
  ['For new invitations, {}', 'show an email preview'],
  ['Notify trial users in {}', 'the in-app preview'],
  ['Test a payment by {}', 'simulating a card charge'],
  ['For local testing, {}', 'make a payment in Stripe test mode'],
  ['For the rollout review, {}', 'write a production deploy plan'],
  ['Use Docker Compose to deploy {}', 'a local demo'],
  ['Publish the docs {}', 'as a local preview'],
] as const

test('explicit hard-to-undo defaults open the row', () => {
  for (const [statement, option] of open) assert.equal(isHardToUndo(statement, option), true, `${statement} / ${option}`)
})

test('ordinary defaults and mentions of an effect stay binding', () => {
  for (const [statement, option] of bind) assert.equal(isHardToUndo(statement, option), false, `${statement} / ${option}`)
})

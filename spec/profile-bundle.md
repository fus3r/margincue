# Profile bundle format

The bundle is the runtime interface for a decision catalog. It is UTF-8 JSON.
The authoring files can change independently. Compile and check the built-ins
with these commands.

```sh
node mods/claude-code/scripts/build-bundles.ts
node mods/claude-code/scripts/sync-assets.ts
node mods/claude-code/scripts/build-bundles.ts --check
node mods/claude-code/scripts/sync-assets.ts --check
```

The compiler reads the Markdown cards, reuses the pilot schema’s frame and
option IDs and consequence costs, and adds the bilingual touch rules and
translations in `mods/claude-code/scripts/bundle-rules.ts`. Each canonical
output is `profiles/<profile>/bundle.json`. The mod embeds the same data so
its directory can be loaded on its own. Other runtimes can read the JSON
directly. A private bundle uses the same format and can be placed in
`~/.margincue/bundles/`.

## Fields

| Field | Meaning |
| --- | --- |
| `formatVersion` | Integer `1`. Consumers reject other formats. |
| `version` | Catalog revision string for logging. The compiler uses the first 12 hex characters of a SHA-256 over the compact JSON of `{profile, slots}`. |
| `profile` | Stable ID for the bundle. |
| `slots` | Nonempty array in priority order for ties. Slot IDs are unique across loaded bundles. |

IDs start with a lowercase ASCII letter, use lowercase ASCII letters, digits,
underscores or hyphens, and are at most 80 characters. A personal bundle with
a profile or slot ID collision is skipped.

Each slot has the following properties.

| Field | Meaning |
| --- | --- |
| `id` | Stable slot ID used in decisions and logs. |
| `scope` | Default answer scope, `project`, `user`, or `session`. Model scope is selected at answer time. |
| `touch` | Object with `en` and `fr` rule sets. |
| `frame` | Optional frame ID from the pilot schema. Frames can overlap. |
| `requires` | Optional fact IDs that must all be true to offer the slot. |
| `label` | Compact localized band label, `{en, fr}`. |
| `statement` | Localized `{en, fr}` of `{plain, expert}`, each containing one `{}` placeholder. |
| `options` | Two to eight options in authored order. The first feasible option is the displayed default. |
| `tier`, `rigor` | `essential\|standard\|research` and `explore\|build\|compete\|study`. |
| `guard`, `cost` | Boolean guard flag and integer consequence cost from 1 to 5. |
| `when`, `settled` | Card prose for the expert reviewer. |
| `why`, `source` | Consequence and supporting source for the person reading the card. |
| `opens` | IDs of related decisions, available to consumers. |

Each option has an `id`, localized `wording` in the same shape as a statement
without the placeholder, and optionally one `requires` fact ID. The IDs
`other` and `delegated` are reserved for stored free text and explicit
delegation. Neither appears as a catalog option. A guard cannot be delegated.

## Touch and facts

A rule set has a `match` array. An entry is a literal word or phrase, or an
object such as the following.

```json
{
  "phrase": "timeout handling",
  "with": [["idempotency key", "status check", "outcome lookup"]]
}
```

The anchor phrase and at least one phrase in each `with` group must occur in
the draft body. The other groups may match anywhere in the body. Phrases
compare whole Unicode letter and number tokens, including underscores, with
lowercase and accent folding. Punctuation and whitespace separate tokens.
Hosts get the anchor's original UTF-16 span. The inferred draft language
controls wording. Touch checks both languages.

Optional `exclude` phrases suppress the slot. Optional `settled` phrases
identify a decision already stated in the draft and take precedence over
a stored answer. A recognized line in a trailing Decisions block does the same.
`facts` maps fact IDs to lists of positive-evidence phrases. A host can also
provide explicit facts. A host fact takes precedence over draft evidence for
that ID, including when its value is false. A missing fact remains unknown.
Only options with known-true prerequisites are offered or attached.

| State | Meaning |
| --- | --- |
| `inapplicable` | No relevant touch/frame, an exclusion, a false prerequisite, or too few possible options. |
| `unknown` | The frame was touched without evidence for this slot, or feasibility remains unknown. |
| `open` | The slot itself was touched, at least two choices are feasible, and nothing has settled it. |
| `delegated` | The narrowest matching stored answer lets the agent decide. |
| `filled` | A stored answer, draft evidence, or an explicit project instruction settles the slot. |

The first-touch cue is selected from eligible open slots. Guards precede
other slots, then higher cost precedes lower cost. Ties follow bundle and slot
order. Depth and task rigor filter open non-guards. Filled marks can still
appear at any depth. `opens` does not make another slot open by itself.

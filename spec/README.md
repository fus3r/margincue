# Core conformance traces

`spec/traces/*.json` pin down the core's behaviour as data, so the TypeScript core
(`mods/claude-code/core/`) and the Rust core (`crates/margincue-core/`) can be held to
the same contract. Each trace is a list of events fed to a fresh core, with the effects
expected after each one.

```sh
node spec/run-traces.ts                      # every trace, against the TypeScript core
node spec/run-traces.ts spec/traces/09-*.json  # some
node spec/run-traces.ts --print FILE         # also print each step's actual effects
node --test spec/core.unit.ts                # unit tests of the pure helpers
```

## File format

```json
{
  "name": "one line",
  "description": "what the trace shows",
  "assets": "fixtures/assets.json",
  "metrics": false,
  "steps": [
    { "event": { "type": "draft", "now": 1000, "text": "Add", "origin": "type",
                 "edit": { "start": 0, "end": 0, "text": "Add" } },
      "expect": [ { "type": "view", "view": { "text": "Add" } } ],
      "note": "optional, shown when the step fails" }
  ]
}
```

- `assets` is a path relative to `spec/` of a JSON file `{ "system": "...", "profiles":
  { "<name>": "<profile markdown>" } }`, an inline object of that shape, or `"repo"` for
  `prompts/system.md` and `profiles/*.md`. The traces use `fixtures/assets.json`, a small
  fixed system prompt and three profiles (front matter with rubric and examples, a
  `max_cues: 2` profile, and a file with no headings), so they do not change when the
  real prompts are edited.
- `event` is exactly a core event (see the Event table in ARCHITECTURE.md, and
  `core/types.ts`). Times are host milliseconds; offsets are UTF-16 code units.
- `expect` is the list of effects that `handle(event)` returns, in order, after
  removing `metric` effects (set `"metrics": true` to compare them too). A step
  without `expect` is not checked. `"expect": []` means no effect at all.

### Matching

- Arrays must have the same length and match element by element.
- Objects match when every key the expectation names is present and matches; keys it
  leaves out are not checked. `{ "$absent": true }` as a value requires the key to be
  missing (used for `start`/`end` of global cues).
- Everything else is compared with `===`.

So an expectation lists only what the step is about (`{"type":"view","view":{"cues":
[{"id":"c1","stale":true}]}}`), but the number and order of effects, and the number of
cues, are always checked.

## What a port must reproduce

- **Effect order.** Within one `handle` call: `cancel`, `request`, `submit` and `metric`
  in the order the work happened, then at most one `timer` (only when the wanted
  wake-up changed; `"at": null` clears it), then at most one `view` (only when its
  JSON differs from the last one emitted).
- **Ids.** Requests are numbered 1, 2, 3… per core; cue ids are `c1`, `c2`… in order
  of creation. A provisional cue's id is kept by the full cue that fills it.
- **View keys.** `view` has `enabled, profile, phase, text, cues, focus, latencyMs,
  decisions, note`. Each cue has `id, start?, end?, anchor, statement, options, chosen,
  pending, stale, provisional, held` (the runner does not check key order, but the
  TypeScript core emits them in this order).
- **Requests.** `system` is a list of text blocks: `prompts/system.md` with
  `{{max_cues}}` filled and trimmed, the profile rubric (when not empty), the profile
  examples formatted as `Example / Status: complete / Draft: / <<< / … / >>> / Output: /
  …` joined by blank lines (when any). `prompt` is `Status: complete`, `Draft:`, `<<<`,
  the draft with the confirmed decisions applied, `>>>`, and `Dismissed: a; b` when any.
  `maxTokens` is `timing.fullMaxTokens` (320) or `timing.planMaxTokens` (24).
- **Case folding** (anchor resolution, identity): per UTF-16 code unit, lowercase only
  where the mapping stays one code unit long.

## The traces

| File | Covers |
| --- | --- |
| 01-typing | idle-gap review, a typed period, the `minGapMs` rate limit, a late reply shown stale, then the fresh one keeping the id |
| 02-paste | paste reviews at once; `NONE` |
| 03-late-replies | the in-flight limit (a third review cancels the oldest), late replies mapped by anchor, a vanished anchor dropped |
| 04-edits | spans shift on edits, edge insertions keep the anchor, touching it drops the cues, a caret move is a no-op |
| 05-plan-then-full | parallel plan request: provisional cues, filled by the full reply, unconfirmed ones removed; a full reply cancels its plan; a plan cut mid-line is ignored |
| 06-malformed | fences, list markers, quotes, missing plan line, missing `{}`, prose before the plan, one-option cues, cues after `NONE`, `max_cues`, global cues, a failed call |
| 07-pick-dismiss-submit | pick (focus moves, review at once with the Decisions block), dismiss (Dismissed line, suppressed later), acceptAll, submit with decisions, submit without |
| 08-toggle-off | off cancels and sends nothing, replies from before are ignored, on reviews at once, submit while off |
| 09-held | contract v1.1 held cues: caret at end, unterminated last sentence, `settleMs`, `holdChars`, the settle timer |
| 10-generation | contract v1.1 generations: a profile change cancels and ignores older replies; a no-op config changes nothing |
| 11-stale-pick | contract v1.1: a pick on a stale cue is pending until the next reply for the current text, applied or dropped with a note |
| 12-decisions-block | contract v1.1: a Decisions block the user typed stays verbatim; a user line that fills a statement wins |
| 13-cache | the LRU: history back to a reviewed text redraws with no request |
| 14-not-reviewed | `/`, `!`, `#` drafts and drafts under 12 characters or 3 words |
| 15-request-layout | exact system blocks and user message, a rubric-only profile |

## Version 2

The 15 original traces are unchanged. A host selects v2 by giving `config`
a `mode`. The legacy protocol retains its reply format, plan-request option,
multi-cue views and scheduling. The Claude Code mod uses v2. Its proactive
review continues to send the shipped rubric and parse the original reply
format, with one open cloud cue at a time. On-demand review uses the V2
catalog wire format. `assets: "catalogs"` loads the real compiled JSON
bundles and both prompts for v2 traces.

`loadState` supplies the current model, a snapshot of durable answers, and
optional explicit facts and project instruction slot IDs. `submitted` can
seed the task-opening policy on resume. The session layer survives a durable
reload and is cleared by `sessionReset`. Resolution runs from session to
project to the exact current model to user. Each answer has `slot`, `option`,
`scope`, and `setAt`. A model answer includes `model`. Free text goes in
`text` under the reserved option `other`. `setAt` is the host’s wall-clock
`at` value when supplied, otherwise the core’s event time for replay.

`set`, `delegate` and `forget` emit one `persist` operation with the scope.
A missing `scope` on a set or delegation uses the card's default. A missing
scope on forget removes the narrowest matching value. Session answers need no
disk write. The mod’s project file contains `{"version":1,"decisions":[...]}`
and optional `facts` for unknown option prerequisites. An instruction author
can add `<!-- margincue: slot_one, slot_two -->` to a root Claude instruction file
to mark slots already covered there. The core honors that assertion when
drawing and attaching.

A v2 `view.state` includes the mode, depth, language, model, touched marks,
open count and up to one first-touch cue with scope and option IDs. Local
decisions are computed before any cloud result. On submit the actual submitted
text is rescanned for standing slots. Explicit draft and project decisions
take precedence. Confirmations on the draft and standing choices are
deduplicated by statement and line. Enter never takes an unconfirmed default.

Auto reviews the first prompt if eligible and then eligible drafts of at least
40 words without a leading follow-up marker. On reviews all eligible drafts.
An explicit ask-first phrase can enable review for that draft in auto.
Delegation phrases suppress proactive draft review and open non-guard state
cues for the draft. Quiet shows only the marks and count during typing.
Off hides the mod’s band and stops reviews and logging.

Clause boundaries, paste and idle can start draft review. An in-flight full
reply for the exact submitted draft and decisions snapshot can yield one
amendment for 3.5 seconds after Enter. A host can set `amendable: false` when
that submission cannot safely amend the current turn. `amend` carries the
chosen short follow-up. `endAmendment` or fresh text clears it. In Claude Code
the mod offers it only for the matching main turn and uses
`$.session.append` to enqueue a plugin reminder for the next model request.
If that turn makes no further request, Claude Code can carry the reminder to
the next turn.

`review` requests up to two consequential open choices using the draft, profile,
level, any applicable catalog entries, and the current card rows. The checklist
in `view.expert` carries a review ID. `expertPick` applies catalog choices to the
same state and storage rules. A new key from the reviewer can be picked only
for the current draft. `audit: true` enables candidate metrics for both
shown and suppressed choices. V2 adds `persist` and `amend` to the ordered
effects before timer and view.

Run the v2 units with `node --test spec/state.unit.ts`. Trace 16 covers
layers, model matching, bilingual marks, exact attachment and instruction
deduplication. Trace 17 covers first-touch delegation, the four modes
across the traces and units, clause review and a late amendment. The profile
wire format is specified in [Profile bundle format](profile-bundle.md).

## The card

The Claude Code mod supplies `config.sheet` (the name predates the card, which
replaced the kick-off sheet). When it is present the automatic tier is the card:
`true` runs it and `false` silences it. `config.sketch` and `config.refs`
(default `true`) switch the sketch and the line saying where names live. With
`sheet` omitted, the original protocol and v2 keep their review flow. `config.user`
is one line about the person (from the host's first-run interview), sent as a system
block of every reading; `config.prefer` lists the profiles they work in, which halves the
evidence `detectLenses` needs; `config.depths` gives a depth per profile, used for that
profile's catalog and on-demand review in place of `depth`.

**Before Enter.** Any draft of six words or more that is not a host command has
a card. On each edit the core matches the draft against the vocabulary the host
sent (`vocabulary`, see `core/grounding.ts`) and lists the names it mentions:
found, with up to two files, definitions first; or missing, for multi-word
proper names, identifiers, paths and quoted names the code lacks, with the
nearest names it has. A missing name with near matches becomes a `repo` row
("which of these does it mean"). A reading (`request` of kind `card`) starts at
a sentence end at most every 3 s, or after 900 ms without an edit; one is in
flight at a time and a newer draft waits for it. Its system blocks are
`assets.cardSystem` and, when indexed, the repository outline; its prompt holds
the draft (8,000 characters at most, start and end kept), the names found and
missing, folders whose names match the draft's words, what is already decided,
the rows on screen, dismissed keys, and the catalogs of expert profiles whose
words the draft uses (two or more) or that the user selected. Profiles the project calls
for (`core/project.ts`, from the vocabulary's folder name, files and `libs`) go in the
system blocks instead, filtered by the project's rigor and the depth.

The reply is line-based (`core/card.ts`): `read | …`, `kind | …`, then
`row | key | label | one|many|range|num | statement with {} | options… [| @anchor]`.
`num` rows become ranges of about nine readable steps. A newer reading keeps a
row's id when its key or statement matches; rows the person set stand whatever
the reading says, and dismissed keys never come back. When the reading is for
the draft as it stands and its kind is `build` or `explore`, a sketch
(`request` of kind `sketch`, `assets.sketchSystem`) follows at once, and again
700 ms after a change of selection. `cardFocus` moves between rows; `cardCycle`
gives the focused row its next value (cycling back onto the default leaves
nothing to attach); `cardSet` picks an option (a pick-any row toggles it);
`cardDismiss` drops a row; `sketch` toggles, pins or refreshes the sketch.

**At Enter.** Only rows the person set join the Decisions block, as filled
statements, then `Where things are: …` for up to four found names the draft wrote as
code (a path, a file, an identifier, backticks); names and plain words never travel. A pinned
sketch follows as a fenced block. Each set row of type one or range emits
`learn` (the host counts picks per key; the same option twice becomes the row's
habit, shown with ↺ and used as its default).

**During the turn.** The card holds the choices the agent marks in its replies
(`blank`, from `assets.blanksProtocol`). `cardCycle` sends an amendment 1.5 s
after the last press; `cardSet` and `amend` send at once. **After the turn**
(`endAmendment`) the view carries a `receipt` (the lines that travelled and the
agent's choices, with what was switched) and an `after` card on which a change
emits `fill`: a follow-up prompt for an empty composer.

Run `node --test spec/*.unit.ts` for the card, grounding and blank units, the
kick-off trigger vectors still shared with the Codex hook, and the earlier units.

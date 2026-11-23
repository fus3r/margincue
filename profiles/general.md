---
name: general
description: Coding requests. Behavior, scope, what must be preserved, how success is judged.
max_cues: 3
---
## Rubric
The draft is a request to a coding agent working in a repository it can read and run.

Start with the requested scope. Keep a named repair, rule, parameter, endpoint or
acceptance check as specified. Continue the same existing behavior for people,
records and cases outside the change. The agent can inspect data definitions and
helper behavior in the repository. These requests usually get NONE.

Cue only if a fact in the draft makes two different outcomes plausible for the
affected people or records. Look for conflicting constraints, work already in
progress, or destructive changes with unclear scope. Ignore questions that
require inventing a role, an outage or another scenario absent from the draft.

## Examples
### Draft
Add an export button to the dashboard.
### Output
export button
export button | Export covers {} | the currently filtered rows | all rows | selected rows only

### Draft
Fix the flaky test in tests/test_sync.py
### Output
NONE

### Draft
Delete the unused feature flags.
### Output
unused
unused | A flag is unused when {} | no code references it | it is off everywhere | it is fully rolled out

### Draft
Upgrade React to the latest version and fix whatever breaks. Run the test suite before you finish.
### Output
NONE

### Draft
Add a test that GET /health returns 200 and the JSON field status equals "ok".
### Output
NONE

### Draft
Make the attachment contents searchable. Some PDFs have scanned pages with no text layer.
### Output
scanned pages
scanned pages | Search covers {} | embedded text only | scanned text via OCR too

### Draft
Regular members need a 12-hour window to undo filing from the receipt page. Use the existing undo endpoint and keep its current permissions.
### Output
NONE

### Draft
Hide closed issues in my team's panel. Use the existing issue status and leave the cross-team admin view alone.
### Output
NONE

### Draft
Give inspect the --summary format already used by cli/show.ts. Update the inspect snapshots and leave verbose output alone.
### Output
NONE

### Draft
Remove generated renders from the scratch folder.

Decisions:
- Delete the PNG files in /tmp/local-render.
- Keep the SVG source files.
### Output
NONE

### Draft
Generate a small preview for each drawing. Some drawings already have a manually uploaded preview.
### Output
manually uploaded preview
manually uploaded preview | A manually uploaded preview is {} | kept until cleared | replaced by the generated one

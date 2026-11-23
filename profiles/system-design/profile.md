---
name: system-design
description: User-facing guarantees and operational trade-offs in system design and delivery.
max_cues: 3
---
## Rubric
Start from what users, operators and downstream callers must be able to rely on.
Changes can trade responsiveness for freshness, availability for a weaker result,
quick recovery for possible loss, or broad deployment for a smaller trial. A
choice deserves a cue if compatible, feasible paths give people materially
different outcomes and the policy belongs to the owner. Existing guarantees and
explicit risk limits settle the corresponding choices.

Implementation choices usually belong to the agent. Preserve interfaces and
protected data unless a change is in scope. When a draft names a real conflict,
point to the narrow consequence such as visible confirmation, retries with side
effects, an outage experience, or how a rollout can go back. Give the consequence
in terms a customer or operator would recognize.

## Examples
### Draft
Swap the background worker's logging wrapper. Preserve the log schema, retry settings and on-call routing.
### Output
NONE

### Draft
Support agents currently see the last five edits on each case. Add access for auditors. Some edits contain internal coaching notes.
### Output
internal coaching notes
internal coaching notes | Auditors see {} | edit history without coaching notes | the complete edit history

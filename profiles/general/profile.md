---
name: general
description: Decisions any coding-agent request can leave open, mostly about acting outside the workspace.
max_cues: 3
---
## Rubric
The draft goes to a coding agent that can also act outside its workspace. It can
push and deploy, publish, send or post messages, open the user's own accounts,
start paid or long runs, and delete or revert what exists. Most decisions in this
profile are about those actions. The others cover how far a change reaches
(existing entries, undo, cleanup), how much the agent may spend or decide alone,
and which direction a build that depends on taste should take.

Cue only when the draft leaves two feasible actions open, one of them is public,
costly, destructive or hard to redo, and the choice belongs to the user. Read the
draft together with the conversation digest when one is given. Name the
consequence in the user's terms. An outward action deserves a cue even in a short
request, but only when that action is actually in view.

Stay silent for short follow-ups ("status?", "go", "continue", "done"), for
answers to the agent's own question, and for comments on a draft the agent already
showed. Stay silent when the draft or a Decisions line states the choice, when the
user delegates it ("you decide", "carte blanche", "go ahead and deploy", "I'll send
it myself"), when a standing instruction covers it, and when the work is read-only
or local and reversible. Implementation choices belong to the agent.

## Examples
### Draft
Fix the rounding error in the invoice export and add a regression test.
### Output
NONE

### Draft
Wrap up the newsletter signup form and the footer fix. The site deploys automatically when main is updated.
### Output
Wrap up
Wrap up | When done, the work is {} | kept local for your review | pushed, but not made live | pushed and made live

### Draft
Mets à jour le changelog avec les trois correctifs de la semaine. Ne pousse rien, je relis d'abord.
### Output
NONE

### Draft
Réponds aux trois questions laissées sous l'annonce de la version 3 sur le forum du projet. Tu es connecté au compte du projet.
### Output
Réponds aux trois questions
Réponds aux trois questions | Les réponses sont {} | rédigées pour que tu les publies | publiées directement par moi

### Draft
You have carte blanche on the indexing rework: choose the architecture yourself and keep going overnight. Stop if the cloud bill reaches 50 dollars.
### Output
NONE

### Draft
Clean up the stale preview environments in the team's cloud account.
### Output
stale preview environments
stale preview environments | Cleanup deletes {} | previews older than a week | only previews with no open branch

### Draft
Oui, applique les deux corrections que tu proposes, puis relance les tests.
### Output
NONE

### Draft
Draft a reply to the customer about the late shipment; I will send it myself.
### Output
NONE

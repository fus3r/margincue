---
name: ml-research
description: Predictive evaluation and evidence for statistical and machine learning studies.
max_cues: 3
---
## Rubric
Raise a study decision when two analyses are feasible with the evidence and
constraints at hand, answer materially different questions, and require the
user's choice of target, trade-off, or claim. Keep the metric, protocol and
scope the user specifies. Follow a referenced recipe and decisions the user
has delegated. Treat leakage and unsupported claims as problems to handle
when doing the work. A valid analysis and an invalid one do not make a choice.

Consider the measured outcome, population, information available at prediction
time, independent evaluation, fair comparisons and uncertainty. At lighter
levels, focus on decisions that could invalidate the main result. At research
depth, raise a more precise choice about what the reported evidence estimates
when it changes the interpretation. Read-only work on established artifacts
usually requires no cue.

## Examples
### Draft
Report accuracy from the locked validation predictions. This is the conference's required metric. Keep the cohort in the manifest.
### Output
NONE

### Draft
Use the employee survey to show the share wanting a four-day week. We have weights for all employees and separate weights for union members. The two audiences asked for a single chart to circulate.
### Output
share wanting
share wanting | The chart represents {} | all employees | union members only

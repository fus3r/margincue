# General coding-agent work

Use the draft to establish what the agent owns, what counts as done, and which changes require the person's decision.

## Scope, interfaces, and acceptance

### Signals

acceptance criteria | public interface | existing behavior | existing behaviour | existing callers | scope of change | regression test | refactor the whole | compatibility contract | critères d'acceptation | comportement existant

### Essentials

**Theory.** A request to fix one behavior also implies that other behaviors people rely on should keep working.
**Workflow.** Reproduce the issue, name what must stay compatible, and run one check through the usual entry point.
**Choice.** Ask about a wider change only if the request plausibly calls for one.

### Standard

**Theory.** A contract includes inputs, outputs and visible side effects that existing callers depend on. A test should exercise the boundary where a regression would matter.
**Workflow.** Identify affected callers, record a failing behavior, and check both the requested change and its closest neighboring case.
**Choice.** Clarify whether existing callers must work as before or can migrate with the change.

### Research

**Theory.** Public contracts can include ordering, error semantics and persisted representations. With mixed versions, compatibility is directional.
**Workflow.** Inspect the contract actually used by callers and older data. Validate the migration and rollback boundaries, as well as the normal success path.
**Choice.** Choose an in-place compatible change or a versioned migration where both are realistic and differ materially in scope.

### Sources

- [Semantic Versioning, public API and compatibility](https://semver.org/spec/v2.0.0.html)
- [Danilo Sato, Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)

## Evidence, reproducibility, and verification

### Signals

verification plan | verify live | production smoke test | repro steps | reproducible build | verify the result | source of truth | current snapshot | test evidence | vérifier en production | étapes de reproduction | source de vérité

### Essentials

**Theory.** A check can only show what it ran against. A local pass leaves any claim about the running service open.
**Workflow.** Run the smallest check that answers the question and keep the output. For a reproducible build, have an independent builder repeat it and compare the specified files byte for byte.
**Choice.** Choose whether done means a local confirmation or a check in a shared environment when both are in scope.

### Standard

**Theory.** A reproducible claim needs the inputs, version, environment, and acceptance rule. For a reproducible build, independent rebuilds using the same source, defined environment, and instructions must yield bit-identical copies of every specified artifact.
**Workflow.** Compare artifact hashes across independent rebuilds for a build claim. For a behavior claim, exercise the user-visible path and record the result.
**Choice.** Choose the release or validation bar when more than one would meet the stated objective.

### Research

**Theory.** Evidence transfers only when relevant conditions match. Staging can establish a procedure while leaving live data, load, credentials, or routing untested.
**Workflow.** Define the acceptance claim, observable, and representative environment. For builds, declare the environment properties that must be held fixed and check bit identity of the specified artifacts across independent rebuilds.
**Choice.** Decide what evidence is sufficient to act and which uncertainty the deliverable may carry forward.

### Sources

- [Reproducible Builds, definition](https://reproducible-builds.org/docs/definition/)
- [Google SRE, testing reliability](https://sre.google/sre-book/testing-reliability/)

## Publication, authorization, and rollback

### Signals

push to main | deploy to production | publish release | publish the release | public release | send the message | post to the forum | force push | live deploy | deploys automatically | publier en production | envoyer le message | publier la version

### Essentials

**Theory.** Some changes leave the workspace, reach people, or affect a shared service. Preparing the change and making it public are different steps.
**Workflow.** Identify who or what will see the action and whether its effect can be reversed.
**Choice.** Ask what should be prepared or sent only when permission or the destination is genuinely open.

### Standard

**Theory.** A merge can also deploy, notify, or start automation. Its external effects may persist after a code revert.
**Workflow.** Check the target branch, automation, audience, and recovery path before the shared action.
**Choice.** Clarify whether completion includes opening a review, merging, deploying, or publishing when the request leaves that boundary open.

### Research

**Theory.** Rollback scope depends on the effect boundary. A version can be reverted while recipients, downstream writes, and published artifacts retain its effects.
**Workflow.** Locate the point of no return, stage the reversible steps, and verify how to pause and recover downstream effects.
**Choice.** Decide where exposure starts and who owns any irrecoverable step when the authorizations leave both possibilities open.

### Sources

- [Git, git-revert](https://git-scm.com/docs/git-revert)
- [GitHub, managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

## Shared data and cleanup

### Signals

delete old | delete stale | wipe data | remove duplicates | purge records | cleanup scope | overwrite existing | bulk update | merge records | supprimer les anciens | supprimer les doublons | écraser les fichiers | purge des données

### Essentials

**Theory.** A cleanup rule defines which records count as stale or redundant. Identical names can refer to different records when teams or accounts share a naming scheme.
**Workflow.** Use shared names to find records to inspect. Check content and ownership before grouping files for cleanup. Preview the affected records and identify how to undo the change.
**Choice.** Choose which teams are in scope or whether verified duplicates should be archived or deleted. Reused names alone are insufficient evidence for deletion.

### Standard

**Theory.** Copying, archiving, and deleting differ in visibility, retention, and recoverability. Concurrent updates can change the set after a preview.
**Workflow.** Check ownership and references, use an explicit predicate, and verify the outcome against the reviewed set. Identical content across owners still requires a retention policy for both.
**Choice.** Decide between a reversible archive and permanent removal if both meet the request and retention policy.

### Research

**Theory.** Entity resolution trades false merges against missed matches. Deleting a canonical record can propagate to references, while hiding it may leave those references intact.
**Workflow.** Inspect the lineage and the ambiguous tail, establish a stable set at write time, and reconcile dependent records after the change.
**Choice.** Agree on tolerated false merges or deletion boundaries before applying an irreversible bulk change.

### Sources

- [PostgreSQL, foreign keys and referential actions](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)
- [Fellegi and Sunter, A Theory for Record Linkage](https://doi.org/10.1080/01621459.1969.10501049)

## Budgets, stopping conditions, and handoff

### Signals

spend limit | budget cap | paid api | overnight run | timebox | stop condition | approval checkpoint | handoff criteria | budget maximum | plafond de dépenses | condition d'arrêt

### Essentials

**Theory.** An open-ended task can keep spending time after the useful answer is known.
**Workflow.** Name the result that would be enough, the budget, and what should happen on reaching it.
**Choice.** Decide whether to stop at the first usable result or continue to compare feasible options.

### Standard

**Theory.** A budget can limit money, elapsed time, or attempts. The right stopping condition is tied to the decision the work will inform.
**Workflow.** Gather a cheap, representative signal first where the request allows it. Record the evidence threshold and checkpoint the result.
**Choice.** Clarify the budget dimension or decision threshold when the options would materially change the work.

### Research

**Theory.** Information has value when it changes a decision or reduces a consequential downside. Overlapping evidence can add less value than a different check.
**Workflow.** Identify the leading decision and the outcome that would reverse it, then sequence tests by decision impact and cost.
**Choice.** Decide whether unresolved uncertainty warrants another costly pass or a handoff with a stated limit.

### Sources

- [Ronald A. Howard, Information Value Theory](https://doi.org/10.1109/TSSC.1966.300074)
- [FinOps Foundation, budgeting](https://www.finops.org/framework/capabilities/budgeting/)

# System-design decision catalog

Each `pair` has an `open` draft and one `settled` change to it. An empty `opens:` has no outgoing link. The source supports the consequence. The choices are written for MarginCue.

### freshness_window
tier: essential
rigor: build
guard: no
when: Change a display of mutable information where an authoritative read on each view and a short bounded cache are feasible. Faster access is useful and the newest value can matter, but the user has not set a freshness requirement.
settled: The surface contract, draft, or explicit delegation fixes tolerable staleness. Historical, immutable and read-only analysis tasks do not raise it.
plain: People see {} | the latest confirmed value | values up to 30 seconds old
expert: Interactive reads use {} | synchronous origin reads | a 30-second bounded cache
why: A cache can make repeated reads faster, while people who just made a change may still see the old value.
source: [Azure Cache-Aside, lifetime and consistency](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside#problems-and-considerations)
opens:
pair:
  open: Make the seat-count panel load faster after changes. We can serve from the bookings table or a 30-second cache and the panel is informational.
  settled: Append “The count must reflect a confirmed booking immediately.”

### submission_confirmation
tier: essential
rigor: build
guard: no
when: Add a user-facing submission that enters a durable queue, where acknowledging queueing and waiting for completion are both practical. The draft leaves what the first receipt promises open.
settled: The interaction design or API contract specifies acknowledgment on acceptance or completion. A task to inspect a queue or report finished work does not reopen the receipt.
plain: The user gets a receipt {} | as soon as work queues | once the work finishes
expert: The submit call succeeds {} | after durable enqueue | after the worker commits
why: A fast receipt can confirm acceptance without telling the user the requested work is done.
source: [Azure Queue-Based Load Leveling, response and durability](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling#problems-and-considerations)
opens: retry_after_unknown
pair:
  open: Move poster PDF generation to the existing durable queue. It takes a few seconds and the submit screen can show either a queued receipt or a completed one.
  settled: Append “Show acceptance as soon as the durable enqueue succeeds.”

### retry_after_unknown
tier: essential
rigor: build
guard: no
when: A user-triggered side effect can succeed even if its acknowledgment times out. The service supports same-key retries and an outcome lookup, and both continuing automatically and asking the user to review status are feasible.
settled: The draft, existing retry contract, or explicit delegation fixes timeout behavior. A read or a confirmed rejection has no uncertain side effect.
plain: After a timeout, the request {} | retries while shown as pending | waits for a status check
expert: Timeout recovery uses {} | retries with the same idempotency key | operation lookup before user retry
why: A lost response can leave the result unknown. Blind retries can repeat the side effect, while waiting for review increases friction.
source: [AWS Builders' Library, Making retries safe with idempotent APIs, late-arriving requests](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
opens:
pair:
  open: Add timeout handling to the badge-issue button. The issuer may already have printed the badge. It supports an idempotency key and a status check.
  settled: Append “Keep it pending and retry with the same key automatically.”

### live_degradation
tier: essential
rigor: build
guard: no
when: An interactive view depends on a service that may be unavailable. Serving a labeled read-only last result is safe and available, and showing an unavailable notice is also acceptable. The user owns availability versus freshness during the outage.
settled: The fallback policy or draft fixes cached results or an error. If stale inputs would violate the user’s requirements, they are not a feasible fallback.
plain: During the outage, people see {} | the last saved view, read-only | an unavailable notice
expert: The read path falls back to {} | a labeled read-only snapshot | an unavailable response
why: A reduced view preserves access but may present out-of-date information. An unavailable notice avoids that ambiguity.
source: [Google SRE, Addressing Cascading Failures, Enter Degraded Modes](https://sre.google/sre-book/addressing-cascading-failures/#enter-degraded-modes)
opens:
pair:
  open: When the room directory is offline, the assignments screen still has its last labeled snapshot. Decide how the view should behave for room coordinators.
  settled: Append “Serve the last snapshot read-only with its timestamp.”

### deploy_inflight
tier: standard
rigor: build
guard: no
when: A planned restart or rollout can interrupt active work. Jobs can finish within an allowed drain window or can safely be returned and retried. The owner has not chosen whether deployment waits for current users' work.
settled: The release policy, shutdown contract, or task fixes the handling of active jobs. A stateless change without active work does not raise it.
plain: At restart, current jobs {} | finish before we switch | are put back to run again
expert: Graceful shutdown uses {} | bounded drain before exit | safe requeue on termination
why: Draining delays the restart, while requeueing can restart progress and delay completion for users.
source: [Twelve-Factor IX, Disposability, graceful worker shutdown](https://12factor.net/disposability)
opens:
pair:
  open: Make preview workers restart for the new image. We can drain the in-flight renders in a few minutes or safely requeue them, and release timing is flexible.
  settled: Append “Wait for active renders to finish before replacing the worker.”

### restore_point
tier: standard
rigor: study
guard: yes
when: Plan an actual recovery and cutover where both the last backup and additional recoverable writes are available. Replaying those writes preserves more work but delays opening the service. Selecting an older recovery point risks leaving out user work.
settled: The approved recovery objectives, incident decision, or user instruction fixes which data must survive and when to reopen. A restore drill on a copy does not set a live recovery point.
plain: Service returns with {} | the newest recoverable work | the last backup, sooner
expert: Recovery uses {} | backup plus log replay | last snapshot only
why: Opening from an older point can mask or lose work the user already completed. Replaying newer work can cost downtime.
source: [AWS Well-Architected REL13-BP01, recovery objectives for downtime and data loss](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_objective_defined_recovery.html)
opens:
pair:
  open: Recover the registrations board. The midnight snapshot can go live in minutes and verified write logs get us nearly to the failure if we spend longer replaying.
  settled: Append “Do not reopen until verified writes have been replayed.”

### overload_priority
tier: standard
rigor: build
guard: no
when: Interactive and background requests compete for scarce service capacity during a known overload. Live priority and serving oldest requests first are both feasible. Users will experience different delays and the owner has not set priority.
settled: The draft, criticality, or service policy orders the classes. A request to tune capacity without choosing who waits leaves the existing order in place.
plain: When busy, we serve {} first | people waiting live | whoever queued earliest
expert: Overload scheduling uses {} | interactive class priority | FIFO across classes
why: Prioritizing interactive requests can keep a screen responsive while older asynchronous work waits longer.
source: [Google SRE, Handling Overload, Criticality](https://sre.google/sre-book/handling-overload/#criticality); [Azure Priority Queue](https://learn.microsoft.com/en-us/azure/architecture/patterns/priority-queue)
opens:
pair:
  open: At peak we get one print slot at a time for the live kiosk and the overnight batches. Both share a waiting list today. Set the priority for peak times.
  settled: Append “Give the live kiosk first access whenever requests are waiting.”

### release_audience
tier: standard
rigor: build
guard: no
when: Plan the first production exposure of a change when a small pilot cohort and exposure to everyone eligible are both feasible. Outcomes can differ before the full rollout and the user owns the release policy.
settled: A rollout brief, existing flag policy, user instruction, or explicit delegation fixes the initial audience. Implementing an inactive flag does not expose the feature.
plain: The change reaches {} first | a small pilot group | all eligible users
expert: Initial rollout targets {} | a canary cohort | all eligible traffic
why: A pilot limits the number of people affected by an unexpected problem, while an immediate rollout gives everyone the change sooner.
source: [Google SRE Workbook, Canarying Releases, definition and rationale](https://sre.google/workbook/canarying-releases/#what-is-canarying)
opens: service_indicator
pair:
  open: Plan activation of the new map editor. Flags can target a pilot or everyone with editor access, and neither group has been promised a launch date.
  settled: Append “Start with the volunteer pilot group this Friday.”

### staging_parity
tier: research
rigor: study
guard: no
when: Choose how to run a prelaunch trial with an available production-class backing service and a cheaper stand-in. Service differences could change what a pass proves, and both trial scopes are supported and useful.
settled: The acceptance plan fixes environmental parity or limits the trial to a mock workflow. Selecting it was delegated or there is no production-like test environment available.
plain: The trial uses {} | the same kind of service | a cheaper stand-in
expert: Prelaunch testing uses {} | production-class backing services | a lower-fidelity emulator
why: A cheaper trial may validate the workflow while missing service incompatibilities that affect real users after launch.
source: [Twelve-Factor X, Dev/prod parity, backing services](https://12factor.net/dev-prod-parity)
opens:
pair:
  open: Trial the booking lock before rollout. We can run the real kind of database in a test account or use our cheap emulator, which handles locking differently. Either trial is feasible for this milestone.
  settled: Append “The release check must use the production database engine in staging.”

### cutover_rollback
tier: research
rigor: study
guard: yes
when: Change a stateful format or store so the old release cannot directly read new writes. A tested compatibility window and a separate offline backup-based recovery path are both viable. The owner has not chosen how much rollback access or downtime to accept.
settled: The migration plan fixes compatibility, backup recovery and what happens to writes after cutover. A rename on a disposable copy has no live rollback risk.
plain: After the switch, going back uses {} | a period with both formats | a backup restore with downtime
expert: Rollback relies on {} | a tested compatibility window | offline backup restore
why: Removing old-format compatibility can make rollback slower or leave out post-cutover writes. Preserving it costs migration complexity.
source: [AWS Builders' Library, Ensuring rollback safety, Two-phase deployment technique](https://builder.aws.com/content/3F04j2yRAAMBuPSPs50xwXZqg01/ensuring-rollback-safety-during-deployments)
opens: restore_point
pair:
  open: Switch the sheets store to the new format, which the old app cannot read. We can keep a tested compatibility window or recover from a backup with downtime. Either fits the change calendar.
  settled: Append “Old and new app versions must keep reading and writing for one release.”

### service_indicator
tier: research
rigor: study
guard: no
when: Set one primary measure for an operational objective. User-visible request success and completion within a time limit are separately observable, are useful for different risks, and neither is fixed by the service contract.
settled: The agreed SLO, incident goal, or acceptance check fixes the primary measure. Dashboard work on an existing SLI does not choose another one.
plain: The service target tracks {} | requests that succeed | requests that finish quickly
expert: The primary SLI is {} | request success ratio | latency threshold attainment
why: A request can succeed and still be too slow. The selected measure changes which regressions count against the objective.
source: [Google SRE, Service Level Objectives, Indicators](https://sre.google/sre-book/service-level-objectives/#indicators)
opens:
pair:
  open: Set one primary service target for the comments endpoint. Some requests succeed after a long wait while others fail fast. Both failure and slowness are measured.
  settled: Append “Use the fraction that finish within 300 ms as primary.”

### event_ordering
tier: research
rigor: build
guard: no
when: Several independent records send events to a shared view or downstream consumer. Per-record order and a single overall order are feasible, but differ in the observable sequence and throughput. Neither guarantee is implicit in an existing contract.
settled: The consuming workflow, queue contract, or draft says whether cross-record order matters. A batch report or unrelated change that preserves current order leaves it settled.
plain: Updates appear {} | in order per record | in one order across records
expert: Delivery guarantees {} | per-entity ordering | one global order
why: Independent groups can be processed in parallel, while a single sequence makes a cross-record timeline reproducible at a coordination cost.
source: [Azure Sequential Convoy, context and problem](https://learn.microsoft.com/en-us/azure/architecture/patterns/sequential-convoy#context-and-problem)
opens:
pair:
  open: Build an updates stream for independent workshop benches. The panel can show a single replayable sequence for supervisors or just preserve the order of each bench's messages.
  settled: Append “Only event order within each bench is required.”

# System design

Specify what callers and operators can rely on. Work through the load, timing, and failures under which those promises must hold.

## Service objectives and error budgets

### Signals

slo | sli | error budget | burn rate | availability target | latency target | tail latency | service objective | budget d'erreur | objectif de disponibilité | latence p99

### Essentials

**Theory.** A service target describes how often users get a good result. Average response time can hide a slow minority.
**Workflow.** Pick one important user action, count successes and slow responses, and choose a time window and target.
**Choice.** Clarify whether the promise is about finishing successfully, finishing in time, or both.

### Standard

**Theory.** An event-based SLI divides good eligible events by all eligible events. An SLO sets the target for that ratio over a window. One minus the target is the allowed fraction of bad events.
**Workflow.** Measure at the caller-visible boundary, define exclusions and latency thresholds, and decide how consuming the error budget changes rollout policy.
**Choice.** Decide which critical paths or customer cohorts get their own objective.

### Research

**Theory.** Burn rate is the observed bad-event fraction divided by the allowed fraction. A long window estimates budget impact, while a short window helps confirm the problem is ongoing. Low traffic can make both noisy.
**Workflow.** Backtest alert windows and targets using production traffic patterns and known incidents. Review classifier and denominator changes too.
**Choice.** Set the page-worthy impact and response window for each service promise.

### Sources

- [Google SRE, service level objectives](https://sre.google/sre-book/service-level-objectives/)
- [Google SRE Workbook, alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)

## Commit points and external effects

### Signals

durable enqueue | durable queue | durable write | submit succeeds | transactional outbox | database transaction | atomic write | batch atomicity | commit point | upload | resumable | partial success | all or nothing | mise en file durable | transaction distribuée | succès partiel | background queue

### Essentials

**Theory.** A queued job may still fail. A job number can confirm that the request was saved. A finished result confirms that the work completed.
**Workflow.** Specify the response payload, status, and retry behavior at acceptance and completion.
**Choice.** When both are open, choose what the endpoint returns and when. It can return a job number after durable acceptance or the result after completion. A draft that sets the acknowledgement point settles this choice.

### Standard

**Theory.** A database transaction can commit local changes atomically. Sending an external message in a separate write creates a failure window. An outbox records the publish intent in the same commit.
**Workflow.** Trace commit, retry, and crash boundaries. Confirm when the caller receives an acknowledgement and how unfinished effects become visible.
**Choice.** Decide whether to acknowledge durable acceptance or wait for the visible effect to finish.

### Research

**Theory.** An outbox makes intent durable but replay can publish duplicates. Even with atomic database state, a side effect outside that boundary needs downstream deduplication or a recovery contract.
**Workflow.** State the invariant across stores and exercise crashes immediately before and after each commit and acknowledgement.
**Choice.** Decide which effects must become visible together and which may converge or be compensated later.

### Sources

- [PostgreSQL, transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [AWS Prescriptive Guidance, transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

## Replication, consistency, and isolation

### Signals

read replica | read replicas | replica lag | consistency guarantee | linearizability | linearizable | serializable isolation | write skew | split brain | network partition | read your writes | quorum reads | cohérence forte | isolation sérialisable | retard de réplication | offline sync | offline edits | concurrent edits

### Essentials

**Theory.** Without a freshness guarantee, replicas can lag indefinitely. A user who just made a change usually expects to see it on their next read.
**Workflow.** Name the reads that must see recent writes, then try delayed updates and an unavailable copy.
**Choice.** Decide whether to wait for a fresh answer or serve a clearly marked older answer.

### Standard

**Theory.** Read-your-writes lets callers observe their own completed writes. Linearizability gives individual operations a sequential order consistent with real time. Strict serializability requires a serial transaction order that respects real-time precedence.
**Workflow.** Write the invariants and read paths, then test concurrent updates, replica lag, and failure of an origin.
**Choice.** Choose where a stronger promise applies and what callers get when it cannot be met.

### Research

**Theory.** The Gilbert–Lynch result makes linearizable read/write semantics and availability at every nonfailed node mutually exclusive during a network partition. Strict serializability adds a real-time requirement to serializability.
**Workflow.** Specify the consistency model by operation. Use failure histories and invariant-based tests across partitions and reconciliation.
**Choice.** Decide which operations may return degraded results and which must reject or wait.

### Sources

- [Herlihy and Wing, Linearizability, §§2.2 and 3.2](https://www.cs.cmu.edu/~wing/publications/HerlihyWing90.pdf)
- [Gilbert and Lynch, Brewer's conjecture](https://doi.org/10.1145/564585.564601)
- [PostgreSQL, transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

## Messaging, retries, and idempotency

### Signals

at least once | exactly once | delivery guarantee | idempotency | idempotency key | duplicate delivery | redelivery | webhook retry | retry policy | message ordering | livraison au moins une fois | clé d'idempotence | ordre des messages | exponential backoff | dead letter queue | duplicate processing | webhook delivery | retry

### Essentials

**Theory.** A timeout can mean the first attempt succeeded and the reply was lost. Repeating an action can apply it twice.
**Workflow.** Reuse the same server-enforced idempotency key on every retry of an operation. Test duplicate delivery and make status visible when the outcome is unclear.
**Choice.** Choose whether people can retry immediately or must first check the status of the original operation.

### Standard

**Theory.** At-least-once delivery can redeliver messages. Idempotency requires that reprocessing the same operation has the same effect, including when attempts overlap.
**Workflow.** Define key scope and retention, atomically record effects and deduplication where possible, and test both acknowledgement loss and reordering.
**Choice.** Decide whether events need order per entity or whether operations can commute or reconcile.

### Research

**Theory.** A broker's transaction or deduplication scope bounds its exactly-once guarantee. An external effect needs a shared transaction or an equivalent protocol at its own boundary.
**Workflow.** Test crashes before and after effect and acknowledgement, replay past retention, and define reconciliation for uncertain outcomes.
**Choice.** Decide which boundary the guarantee covers and how operators resolve ambiguous effects.

### Sources

- [AWS Builders' Library, making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- [Apache Kafka, message delivery semantics](https://kafka.apache.org/documentation/#semantics)

## Capacity, queues, and overload

### Signals

backpressure | queue backlog | queue depth | load shedding | rate limit | rate limiting | capacity planning | saturation | concurrency limit | throughput target | délestage | file d'attente | limite de débit | connection limit | requests per minute | worker queue

### Essentials

**Theory.** When more work arrives than can finish, waiting time grows. Retrying immediately can make a busy service busier.
**Workflow.** Measure how long work waits, limit how much can queue, and test what happens at peak load.
**Choice.** Decide whether to delay, refuse, or serve a smaller result when the system runs out of capacity.

### Standard

**Theory.** Little's law relates averages in a stable system. The mean number of requests in the system equals throughput times mean time in the system. Use the same boundary for all terms and measure tail latency separately.
**Workflow.** Load-test bursts and sustained traffic, measure queue age and saturation, and budget concurrency, timeouts, and retry volume together.
**Choice.** Choose which traffic gets priority and how rejected work can recover.

### Research

**Theory.** Once work reaches the bottleneck's service rate, allowing more requests in flight usually lengthens the queue. Correlated retries and common deadlines can amplify overload.
**Workflow.** Test the saturation knee with realistic arrivals, dependency latency, and retries. Measure goodput and per-class tail latency as shedding begins and recovers.
**Choice.** Pick a priority or fairness promise if both are supported. When priority, queue limit and retry response are given, use that contract.

### Sources

- [Little, A Proof for the Queuing Formula L = λW](https://doi.org/10.1287/opre.9.3.383)
- [Google SRE, handling overload](https://sre.google/sre-book/handling-overload/)

## Freshness, caches, and degraded reads

### Signals

cache invalidation | cache ttl | data freshness | stale data | stale reads | stale while revalidate | cache aside | read through cache | materialized view | invalidation du cache | données périmées | fraîcheur des données | cache | ttl | invalidation

### Essentials

**Theory.** A cached or precomputed answer can be faster and can show older information after something changes.
**Workflow.** Measure how old an answer can become, test updates and outages, and show the user its age when it matters.
**Choice.** Decide how old an answer is acceptable and when the screen should say it is unavailable.

### Standard

**Theory.** TTL limits how long an entry can be reused under a policy. Source data can already be old at refresh, and outage policy can extend reuse past expiry.
**Workflow.** Track source timestamps, test invalidation races and concurrent misses, and define a different policy for outage fallback if needed.
**Choice.** Choose which reads may be stale and which must wait for a current source.

### Research

**Theory.** Freshness is a property of the end-to-end path. A per-cache TTL cannot prove read-your-writes or an age bound across layers.
**Workflow.** Budget lag from origin through refresh and cache, measure age by cohort, and test invalidation races, failover, and refresh failure.
**Choice.** Set separate freshness and availability promises for normal and degraded operation when both modes are in scope.

### Sources

- [RFC 9111, freshness and serving stale responses in HTTP caches](https://www.rfc-editor.org/rfc/rfc9111.html)
- [Azure Architecture Center, Cache-Aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)

## Rollout, compatibility, and migration

### Signals

canary | phased rollout | feature flag rollout | contract migration | expand contract | rolling deploy | schema migration | dual write | backwards compatibility | rollback window | déploiement progressif | migration de schéma | rétrocompatibilité | feature flag | zero downtime | rollback path | migration de base de données

### Essentials

**Theory.** A release can expose everyone to a defect at once. Restoring the old code may fail if the new version already changed the data.
**Workflow.** Try a small rollout, check one user-visible signal, and rehearse stopping it and restoring service.
**Choice.** Use the specified audience or choose one that fits the rollout goal when delegated. If initial exposure is still an open choice, offer a pilot or all eligible users when both are feasible.

### Standard

**Theory.** During a rolling deploy, old and new versions may run together. Expand–contract keeps the shared interface compatible until the data migration and cutover are verified.
**Workflow.** Add compatible fields, backfill, compare reads, switch traffic, and only then remove the old representation.
**Choice.** Decide how long the rollback window lasts and which user cohort verifies the new route.

### Research

**Theory.** A canary needs a comparable control and enough traffic to see a meaningful degradation. Rolling traffic back can leave writes from the new version in place.
**Workflow.** Choose guardrail metrics and a hold period, test mixed-version reads and writes, and rehearse rollback after a partial backfill.
**Choice.** Decide when operators can promote, roll back, or must repair forward after an irreversible step.

### Sources

- [Google SRE Workbook, canarying releases](https://sre.google/workbook/canarying-releases/)
- [Danilo Sato, Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)

## Recovery, durability, and degraded operation

### Signals

disaster recovery | data loss | recovery point | recovery time | rpo | rto | backup restore | restore drill | point in time recovery | regional failover | restore from backup | reprise après sinistre | restauration de sauvegarde | write ahead log

### Essentials

**Theory.** Recovering quickly and recovering every recent change are different goals. A backup is useful only if it can be restored.
**Workflow.** Pick a likely failure, restore to a clean environment, and check how much time and data were lost.
**Choice.** Decide what users may see during recovery and how much downtime or data loss they can tolerate.

### Standard

**Theory.** RPO limits how far back restored data may fall. RTO limits elapsed recovery time. Replication can reduce recovery time while copying a bad write to the replicas.
**Workflow.** Rehearse restoring backups and logs, validate data at the restore point, and measure time to resume the critical user path.
**Choice.** Decide whether a read-only view is useful while writes are being recovered.

### Research

**Theory.** Region loss, logical corruption, and compromised credentials have different fault and recovery boundaries. Multi-store recovery can violate cross-store invariants without a compatible restore cut or reconciliation.
**Workflow.** Test a representative failure per boundary, restore independent backups, and reconcile cross-store changes before advertising recovery.
**Choice.** Specify which acknowledged writes must survive each fault class and when degraded operation is acceptable.

### Sources

- [Google SRE, data integrity](https://sre.google/sre-book/data-integrity/)
- [AWS Well-Architected, disaster recovery objectives](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_objective_defined_recovery.html)

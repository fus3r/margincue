# Product and startup work

Connect the initial customer and the job they need done to a release and a measurement plan. Express decisions as changes in user behavior, policy, or evidence.

## Discovery, segments, and the job

### Signals

customer discovery | target customer | target audience | first customer | user research | user needs | user interviews | job to be done | customer segment | product discovery | recherche utilisateur | besoin utilisateur | segment client | public cible

### Essentials

**Theory.** Different people can use the same product for different reasons. The first release needs one person with a real task.
**Workflow.** Describe who they are, when they face the task, what they do now, and what a better outcome looks like.
**Choice.** Pick which audience and job the first release serves when the pitch leaves several plausible.

### Standard

**Theory.** An observed workaround is evidence of behavior and friction. Stated interest is evidence of preference under interview conditions.
**Workflow.** Recruit from the proposed segment, reconstruct recent cases, compare workarounds, and record evidence that would rule out the segment.
**Choice.** Choose whether to serve a narrow high-need segment or validate a broader audience first.

### Research

**Theory.** Recruiting from existing users conditions on adoption and can miss barriers that kept other eligible people out. Buyer, operator, and beneficiary may face different incentives.
**Workflow.** Sample adopters, eligible non-adopters, and abandoned attempts where practical. Map buying and use separately and triangulate interview claims with observed behavior.
**Choice.** Choose which population and adoption barrier the discovery is meant to resolve.

### Sources

- [GOV.UK Service Manual, learning about users and their needs](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs)
- [GOV.UK Service Manual, discovery](https://www.gov.uk/service-manual/agile-delivery/how-the-discovery-phase-works)

## Workflow, usability, and the first release

### Signals

first release | mvp | onboarding flow | first run experience | product prototype | clickable prototype | usability test | core workflow | activation flow | time to value | service journey | première version | parcours utilisateur | test d'utilisabilité

### Essentials

**Theory.** A usable first release lets someone finish a whole task. A prototype can test whether they know what to do before the task is built.
**Workflow.** Pick a start, an end, and the shortest realistic path between them. Try it with a person from the target group.
**Choice.** If both assisted and self-serve paths are feasible, ask how the first release handles that step. Once the workflow is chosen, sketch it in the requested scope and use a simple presentation.

### Standard

**Theory.** A prototype can expose navigation problems. Evidence of demand and repeat use comes from observing the product in use.
**Workflow.** Map the happy path and a common recovery path. Test a realistic task with a measurable success criterion, then instrument the live value event.
**Choice.** Choose between testing workflow comprehension and delivering a usable pilot for repeat behavior.

### Research

**Theory.** High-touch help can raise pilot completion by removing friction a self-serve product still has. A release validates adoption only for the support and distribution actually offered.
**Workflow.** Log assisted and unassisted completion, recruit across access constraints, and compare where people abandon or need intervention.
**Choice.** Decide whether the pilot tests the value of the service or the viability of delivering it self-serve.

### Sources

- [GOV.UK Service Manual, alpha and testing risky assumptions](https://www.gov.uk/service-manual/agile-delivery/how-the-alpha-phase-works)
- [GOV.UK Service Manual, moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing)

## Activation, retention, and cohort measurement

### Signals

activation metric | activation rate | product analytics | retention cohort | cohort analysis | retention rate | conversion funnel | north star metric | signup conversion | event instrumentation | taux d'activation | taux de rétention | taux de conversion

### Essentials

**Theory.** Signing up records interest. Finishing a useful task and coming back record different behaviors.
**Workflow.** Pick the action to count, who can take it, and when to check it. Review where people stop along the way.
**Choice.** If success is still open, choose between signups, a completed first task, or coming back. When reporting an existing measure, use its given cohort and window.

### Standard

**Theory.** Activation is the share of all eligible units that complete the value event during the window. The denominator includes eligible units that never activate.
**Workflow.** Set eligibility independently of the outcome, count each unit once, and use comparable follow-up. For workspaces, specify whether activation takes one member's action, actions by several distinct members, or a workspace-level event.
**Choice.** When the unit is open, decide whether the value event belongs to a person or a workspace. Keep any eligibility, event, and window already defined for that unit.

### Research

**Theory.** A cohort enrolled near the reporting cutoff has less opportunity to return. Conditioning on activation changes the population and can hide shifts in signup quality.
**Workflow.** Define risk sets and comparable follow-up, break out acquisition mix, and audit missing or double-counted events.
**Choice.** Distinguish retention conditional on activation from retention across the eligible starting cohort.

### Sources

- [GOV.UK Service Manual, measuring success and completion](https://www.gov.uk/service-manual/measuring-success/measuring-the-success-of-your-service)
- [Kohavi et al., criteria and metrics for online experiments](https://ai.stanford.edu/~ronnyk/GuideControlledExperiments.pdf)

## Experiments, rollout, and decisions

### Signals

a b test | ab test | randomized experiment | experiment rollout | feature experiment | holdout group | guardrail metric | sample ratio mismatch | test de variante | test contrôlé | expérience randomisée

### Essentials

**Theory.** Users can act differently on different days even if the product stays the same. Concurrent random assignment helps isolate the effect of each version.
**Workflow.** Define who is eligible, randomly assign people or groups to versions, and pick the main outcome and what would stop or expand rollout.
**Choice.** Decide which result matters most and what minimum harm should pause rollout.

### Standard

**Theory.** Random assignment makes assignment groups comparable in expectation. The experiment unit should match the boundary where people share the experience.
**Workflow.** Define eligibility, assignment, primary and guardrail metrics, detectable effect, and stopping rule. Check allocation before interpreting outcomes.
**Choice.** Choose the assignment unit or rollout rule when people can cross or share product variants.

### Research

**Theory.** Intent-to-treat compares groups as assigned. Partial interference confines spillovers to teams. Two-stage randomization can identify direct, spillover, total, and overall effects for the tested allocations.
**Workflow.** Randomize whole teams to compare team-wide rollout policies. To study spillovers, randomize treatment coverage across teams, then assign treatment to members within each team at its assigned coverage.
**Choice.** Choose a team-wide rollout comparison or specify which effects at the tested coverage levels matter. Keep the stated metrics.

### Sources

- [Kohavi et al., Practical Guide to Controlled Experiments on the Web](https://ai.stanford.edu/~ronnyk/GuideControlledExperiments.pdf)
- [Microsoft Research, diagnosing sample ratio mismatch](https://www.microsoft.com/en-us/research/publication/diagnosing-sample-ratio-mismatch-in-online-controlled-experiments-a-taxonomy-and-rules-of-thumb-for-practitioners/)
- [Hudgens and Halloran, causal effects under interference](https://pmc.ncbi.nlm.nih.gov/articles/PMC2600548/)

## Pricing, packaging, and unit economics

### Signals

pricing page | pricing plan | pricing plans | pricing tier | seat based pricing | paid conversion | free trial | pricing experiment | willingness to pay | unit economics | usage based pricing | modèle tarifaire | disposition à payer | essai gratuit

### Essentials

**Theory.** People can like an offer and still choose against paying for it. A plan should make clear what it buys.
**Workflow.** Identify the buyer, state the offer and renewal terms, and look for behavior such as purchasing or renewing.
**Choice.** Decide who gets free access and what useful boundary separates it from paid access.

### Standard

**Theory.** Higher conversion, higher revenue, and higher contribution after variable costs can favor different plans. The charge unit also influences how customers use the product.
**Workflow.** Compare offers on an eligible cohort, include support and usage cost, and check price comprehension and renewal behavior.
**Choice.** If the draft asks which supported unit to bill, compare those units directly. Include allowances, fees or mixed plans only when the billing decision includes them.

### Research

**Theory.** Paid conversion can occur at signup, when a trial ends, or on a later purchase. Profitability depends on retention, usage cost, and who changes their purchasing behavior. Willingness-to-pay estimates depend on how they are elicited, including whether a response has real purchase consequences.
**Workflow.** Define the conversion event and its window from signup or exposure, including how trials count. Compare cohorts with equivalent follow-up, track selection and renewals, and stress-test costs for heavy usage.
**Choice.** Decide whether to optimize short-term paid adoption or durable contribution under uncertain retention and cost.

### Sources

- [OpenStax Principles of Economics, price elasticity](https://openstax.org/books/principles-economics-3e/pages/5-1-price-elasticity-of-demand-and-price-elasticity-of-supply)
- [Stripe, pricing models and billing schemes](https://docs.stripe.com/products-prices/pricing-models)
- [Stripe, subscription trials and billing](https://docs.stripe.com/billing/subscriptions/trials)
- [Wertenbroch and Skiera, Measuring Consumers' Willingness to Pay at the Point of Purchase](https://faculty.wharton.upenn.edu/wp-content/uploads/2012/05/Wertenbroch-and-Skiera-2002.pdf)

## Policy, permissions, and user trust

### Signals

product policy | refund policy | cancellation policy | audit access | approval flow | account permissions | role permissions | role based access control | rbac | staff notes | user consent | price guarantee | saved quote | supplier price | règle de remboursement | droits d'accès | consentement utilisateur

### Essentials

**Theory.** Different people can need different views or actions in the same task. Showing too much can expose information they were never meant to see.
**Workflow.** Walk through the task as each role, check what they need to know, and show them what happens when an action fails.
**Choice.** Decide which role can see sensitive information, take an action, or approve an exception.

### Standard

**Theory.** Role-based access control assigns permissions through roles. Product commitments can also depend on account state and earlier promises about price, access, or deadlines.
**Workflow.** Map roles, commitments and edge cases. Check the copy, user-visible state, and an escalation path against the same policy.
**Choice.** Clarify which commitment or authorization should apply across the handoff.

### Research

**Theory.** Policies at role, account and lifecycle boundaries can conflict. The product's permission and exception rules define which grants or restrictions take precedence.
**Workflow.** Trace precedence to the product's rules and test competing roles, revocation, and replay of prior actions. Measure completion and errors that expose information or violate commitments.
**Choice.** Decide who owns exceptions and settle precedence where the product's rules leave a conflict open.

### Sources

- [NIST, role-based access control and role permissions](https://csrc.nist.gov/Projects/Role-Based-Access-Control/faqs)
- [GOV.UK Service Standard, solving a whole problem for users](https://www.gov.uk/service-manual/service-standard/point-2-solve-a-whole-problem)
- [W3C WCAG 2.2, input assistance and error prevention](https://www.w3.org/TR/WCAG22/#input-assistance)

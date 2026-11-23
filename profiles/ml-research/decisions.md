# ML-research decision catalog

Each `pair` has an `open` draft and one `settled` change to it. An empty `opens:` has no outgoing link. The source supports the consequence. The choices are written for MarginCue.

### label_window
tier: essential
rigor: build
guard: no
when: Define a prediction outcome when the records contain both an original promised cutoff and a later agreed revision. Either cutoff answers a plausible user goal and the data covers both.
settled: A label specification, downstream decision, the draft, or an explicit delegation determines which cutoff counts.
plain: The outcome counts {} | results by the original deadline | results by the revised deadline
expert: The label uses {} | the original promised cutoff | the revised promised cutoff
why: Changing the cutoff can turn the same event from a miss into a success and change which model looks better.
source: [REFORMS item 3d, outcome variable and definition](https://arxiv.org/html/2308.07832#Sx9)
opens:
pair:
  open: Predict missed arrivals for shared labs. Both the original booked deadline and the agreed extension are recorded, and either would be useful in next month's report.
  settled: Append “A miss is measured against the agreed extension.”

### split_strategy
tier: essential
rigor: build
guard: no
when: Repeated observations share a group and both predicting future observations from known groups and generalizing to unseen groups are feasible uses. The requested evaluation has one primary population and both holdouts can be built.
settled: The deployment population, group or time split, existing split file, or delegated benchmark protocol already determines the holdout.
plain: Test data comes from {} | whole new groups | later records in known groups
expert: Evaluation uses {} | group-disjoint holdout | within-group temporal holdout
why: A within-group score can benefit from recognizing groups and is not evidence for performance on new groups.
source: [Kapoor and Narayanan, leakage type L3.2](https://arxiv.org/html/2207.07048#S2.SS4); [REFORMS item 6b](https://arxiv.org/html/2308.07832#Sx12)
opens: uncertainty_target
pair:
  open: Predict faulty images in two settings, future pictures from cameras already installed and pictures from newly installed cameras. We have repeat observations per camera and room for one headline score.
  settled: Append “The headline score is for newly installed cameras.”

### metric_priority
tier: essential
rigor: explore
guard: no
when: Select or compare classifiers with labeled outcomes when catching more positives and reducing false alerts are both feasible priorities and favor different candidates. The user asks for one primary criterion and has not picked it.
settled: An explicit metric, loss, decision workflow, or delegation provides the selection criterion. Merely computing a specified score is settled.
plain: Model selection prioritizes {} | catching more real cases | fewer false alerts per flag
expert: Model selection targets {} | higher recall | higher precision
why: Models can exchange false negatives for false positives, so the metric can reverse the ranking.
source: [REFORMS Module 7a, performance metrics](https://arxiv.org/html/2308.07832#Sx13)
opens: threshold_policy
pair:
  open: Choose one scanner model from these two. The same labeled check shows A catches more violations and B generates fewer fruitless reviews per flag. Make one the headline winner.
  settled: Append “Use precision to pick the winner.”

### final_score_partition
tier: essential
rigor: compete
guard: no
when: Request a headline result after tuning on validation data, with a separate untouched labeled set actually available. Both a quick exploratory result from tuning data and an independent final estimate are useful and permitted.
settled: The draft or protocol fixes the evaluation partition or status of the claim. A demand for a final unbiased estimate with no independent data is a limitation to handle during the work.
plain: The headline result is {} | a fresh-data estimate | an exploratory tuning-set score
expert: Headline evaluation uses {} | untouched labeled holdout | tuning validation, explicitly exploratory
why: Selection on validation favors lucky candidates, so the reused score has a different interpretation.
source: [ESL 2nd ed., §7.2, separate training, validation and test sets](https://mcube.lab.nycu.edu.tw/~cfung/docs/books/hastie2009elements_of_statistical_learning.pdf#page=241); [Kapoor and Narayanan, L1.1](https://arxiv.org/html/2207.07048#S2.SS4)
opens:
pair:
  open: Validation picked our best checkpoint. Logs and an untouched labeled holdout are ready. Give me a headline number for the note, which can be an exploratory update or a final estimate.
  settled: Append “Use the untouched holdout for the headline.”

### feature_fallback
tier: standard
rigor: build
guard: no
when: A serving feature can be late or missing, an always-available model exists, and a legitimate point-in-time proxy is available on some requests. Both avoiding the optional feature and using its timely proxy with a fallback fit the request.
settled: A feature contract, latency requirement, or explicit policy fixes the usable inputs. A value that only exists after prediction time is excluded, with no cue to choose leakage.
plain: Predictions use {} | inputs we always have | timely data when present
expert: Serving features use {} | universally observed inputs | as-of proxy with fallback
why: The optional signal can improve some predictions while creating differences between covered and uncovered cases. Retrospective data can exaggerate that benefit.
source: [Kapoor and Narayanan, leakage type L2](https://arxiv.org/html/2207.07048#S2.SS4); [REFORMS item 6c](https://arxiv.org/html/2308.07832#Sx12)
opens:
pair:
  open: We score parcel delay at scan time. Historical traffic data gets revised; a genuine scan-time reading exists for two thirds of parcels and the basic model runs for all of them.
  settled: Append “Use only inputs available for every parcel.”

### comparison_budget
tier: standard
rigor: compete
guard: no
when: Compare models where per-trial resource costs materially differ, both equal trial counts and equal compute allotments fit the cap, and the user has not chosen whether to compare search opportunity or results under a resource budget.
settled: The benchmark design, compute policy, or delegated execution specifies the budget per method. A frozen comparison does not reopen it.
plain: Each method gets {} | the same compute time | the same number of tries
expert: Tuning matches {} | compute budget | trial count
why: Equal compute can give a faster model more trials. Equal trials can spend more compute on the slower model.
source: [REFORMS Module 5, modeling and comparable baselines](https://arxiv.org/html/2308.07832#Sx11); [NeurIPS Paper Checklist, Experiment compute resources](https://neurips.cc/public/guides/PaperChecklist)
opens: uncertainty_target
pair:
  open: Compare the small encoder to the large one. We can afford equal trials or equal GPU-hours, and the small one runs twice as many trials per hour. Pick a comparison that will inform our next experiment.
  settled: Append “The comparison holds GPU-hours equal per encoder.”

### threshold_policy
tier: standard
rigor: build
guard: no
when: A fixed score will trigger a user-facing action. Labeled operating curves show that feasible thresholds trade more catches and more alerts for fewer false alerts and more misses. Neither priority is fixed.
settled: A threshold, alert budget, cost policy or existing operating point fixes the choice. Reporting curves or accuracy without setting a threshold leaves the operating policy out of scope.
plain: The alert cutoff favors {} | more catches and more alerts | fewer alarms, more missed cases
expert: The action uses {} | a lower score threshold | a higher score threshold
why: Even with the scoring model fixed, a threshold changes who is flagged and how much work follows a flag.
source: [ISL 1st ed., §4.4.3, classification thresholds and ROC](https://www.statlearning.com/s/ISLRSeventhPrinting.pdf)
opens:
pair:
  open: Turn the anomaly score into a library returns alert. Two tested cutoffs trade more recovered items for more interruptions at the desk, and the team can run either one.
  settled: Append “The desk wants the lower-alert cutoff we tested.”

### coverage_scope
tier: standard
rigor: study
guard: no
when: Compare methods with a shared labeled cohort plus labeled additional subgroups where only some methods apply. Both a like-for-like common-cohort result and separate labeled subgroup results are useful. The conclusion's scope is still open.
settled: The paper, scope statement, or manifest defines the evaluation cohort and claim. Unlabeled outcomes cannot support an observed comparison outside that cohort.
plain: The main report covers {} | the shared labeled cohort | results by eligible subgroup
expert: The comparison reports {} | common-cohort estimates | separate subgroup estimates
why: Changing eligibility changes what a headline result can represent, even when each subgroup is scored correctly.
source: [REFORMS Module 3g, evaluation representativeness](https://arxiv.org/html/2308.07832#Sx9)
opens: subgroup_weight
pair:
  open: Compare two report classifiers. Both run on desktop. Only the newer one runs on mobile, where we already have separate labels. The report can be a like-for-like score or show results per eligible platform.
  settled: Append “Use only the common desktop cohort in the comparison.”

### subgroup_weight
tier: research
rigor: study
guard: no
when: Aggregate one study score across several observed groups with unequal sizes. An equal-group interpretation and a per-observation interpretation are both useful, feasible and likely to produce different rankings.
settled: The estimand, weights, client specification, or aggregation protocol selects the denominator. Reading an already computed aggregate does not reopen it.
plain: The overall score gives equal weight to {} | each group | each example
expert: Group performance is combined by {} | macro-averaging group scores | sample-size weighting group scores
why: Large groups can dominate an observation-weighted score even when smaller groups have very different outcomes.
source: [REFORMS 1a, target population](https://arxiv.org/html/2308.07832#Sx7); [REFORMS 7a, metrics](https://arxiv.org/html/2308.07832#Sx13)
opens:
pair:
  open: Reduce our three labeled regions to one score. One region has 80 times as many images, and the two weighting rules favor different models.
  settled: Append “Each region has equal weight.”

### uncertainty_target
tier: research
rigor: study
guard: no
when: Choose one uncertainty summary for an evaluation with both repeated model fits and case-level held-out predictions. The stakeholder may care about fit-to-fit variability on this benchmark or sampling variation across future cases under a fixed fit.
settled: The protocol, requested interval, or analysis plan specifies the source of variation. The only available data can also rule one target out.
plain: The error bar reflects {} | differences across repeat runs | variation across new cases
expert: Uncertainty conditions on {} | fixed cases, varying seeds | fixed fit, resampling cases
why: Variability from training randomness and uncertainty across cases answer different questions and can differ substantially.
source: [NeurIPS Paper Checklist, Experiment statistical significance, factors of variability](https://neurips.cc/public/guides/PaperChecklist); [REFORMS Module 7b](https://arxiv.org/html/2308.07832#Sx13)
opens:
pair:
  open: Add one interval to the main result. We have eight fits with different seeds and stored case predictions for the chosen fit. Readers ask both about reruns and about new examples.
  settled: Append “The interval covers rerun variance on this fixed benchmark.”

### multiplicity_scope
tier: research
rigor: study
guard: no
when: Report a family of valid tests where either minimizing the chance of any false claim or accepting a controlled false discovery proportion for follow-up is feasible and relevant. The intended strength of the result is open.
settled: A confirmatory protocol, a discovery plan, or a declared error criterion sets the multiplicity goal. Computing existing corrections is routine.
plain: The findings prioritize {} | avoiding any false claim | more leads for follow-up
expert: Multiplicity control uses {} | family-wise error control | false discovery rate control
why: Controlling the chance of even one false rejection is a stronger goal than controlling the expected proportion of false discoveries.
source: [ISL 2nd ed., §§13.3–13.4, authors’ Chapter 13 slides](https://hastie.su.domains/ISLR2/Slides/Ch13_Multiple_Testing.pdf)
opens:
pair:
  open: Report the results for 18 prespecified feature tests. The note may contain a short set of confirmatory claims or a longer set of candidates for independent follow-up.
  settled: Append “For this note, control the chance of any false claim.”

### abstention_policy
tier: research
rigor: study
guard: no
when: A fixed classifier has low-confidence cases. A provisional automated result and abstention with an available human review route are both permitted. The user owns the trade-off between immediate coverage and unreliable results.
settled: The workflow, policy or draft sets whether low-confidence results can be shown or referred. No usable review route, or a fixed reporting-only request, removes the choice.
plain: Uncertain cases get {} | a provisional suggestion | review by a person
expert: Low-confidence predictions get {} | flagged provisional outputs | abstention with manual referral
why: Abstaining can improve the accuracy of automated results by covering fewer cases and increasing review work.
source: [El-Yaniv and Wiener, risk–coverage trade-off](https://www.jmlr.org/papers/v11/el-yaniv10a.html)
opens:
pair:
  open: Put document tags from the fixed classifier into the review tool. For low-confidence tags, we can either show a labeled suggestion immediately or use the staffed review queue.
  settled: Append “Low-confidence tags always go to human review.”

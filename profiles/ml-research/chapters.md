# Statistics and machine learning

Start with the claim the work should support. Then choose the target, model, and evidence that can support that claim. These chapters use ESL and ISLP for the statistical foundations and lab workflows.

## Prediction targets and statistical risk

### Foundations

For a fixed input $x$, let $m(x)=E[Y\mid X=x]$. Expand the squared loss around $m(x)$. The cross term disappears because $E[Y-m(x)\mid X=x]=0$, leaving $\operatorname{Var}(Y\mid X=x)+(m(x)-a)^2$ for a fixed prediction $a$. This makes the conditional mean the squared-loss optimum. Averaging the second term over independent training samples produces the usual bias–variance expression. A different loss can select a different functional of the same distribution. Establish the downstream use and information cutoff before specifying the target or scoring rule.

### Signals

prediction target | prediction horizon | forecasting horizon | loss function | prediction loss | label definition | label cutoff | bias variance | Bayes risk | variable cible | horizon de prédiction | fonction de perte

### Essentials

**Theory.** A prediction is judged against an outcome and a definition of error. Averaging equally bad misses and penalizing large misses heavily can favor different predictions.
**Workflow.** Write down who gets a prediction, when it is made, what counts as the outcome, and which inputs exist at that time.
**Choice.** Pin down the event, horizon, or meaning of a costly miss when the draft leaves several useful interpretations.

### Standard

**Theory.** Squared loss targets the conditional mean and absolute loss a conditional median. Under asymmetric linear loss, forecast the conditional quantile at level c_under / (c_under + c_over), where the costs are per unit of underprediction and overprediction.
**Workflow.** Define the prediction timestamp and label window, audit features as of that time, and match the baseline, loss, and metrics to the same target.
**Choice.** Choose a mean forecast for aggregate planning or a quantile that reflects the relative costs of under- and overprediction when both uses are plausible.

### Research

**Theory.** With finite second moments, squared risk at fixed x decomposes into irreducible conditional variance and squared deviation from the conditional mean. Averaging this deviation over training samples gives squared bias plus estimator variance.
**Workflow.** Specify the deployment distribution, the loss, and the source of randomness. Check overlap and information timing before comparing risks across populations.
**Choice.** Decide which population's risk or which loss functional the claim should target.

### Sources

- [ESL, 2nd ed., §§2.4 and 2.9](https://hastie.su.domains/ElemStatLearn/)
- [ISLP, ch. 2](https://www.statlearning.com/resources-python)
- [Steinwart and Christmann, conditional quantiles and pinball loss](https://arxiv.org/abs/1102.2101)
- [REFORMS, study goals and data preparation](https://arxiv.org/abs/2308.07832)

## Resampling, leakage, and final assessment

### Foundations

Cross-validation estimates loss under a specified procedure and sampling design. Selecting the best score from several noisy estimates preferentially selects favorable estimation error. In nested validation the outer fold has no part in model choice, and each outer fit repeats preprocessing, feature selection, and tuning. A locked external set can evaluate one frozen fit in a defined population. Ordinary folds suit independent, exchangeable cases. When deployment requires held-out groups or later times, apply group or time restrictions in both loops and check for label windows that cross temporal boundaries.

### Signals

cross validation | nested cv | nested resampling | train test split | train test | holdout | hold out | test accuracy | test set | validation set | group split | temporal split | time series split | data leakage | out of sample | validation croisée | jeu de test | fuite de données | label leakage | offline evaluation | evaluation

### Essentials

**Theory.** Examples used to pick a model can make its final score look better than it is. Rows from the same person or from the future can also give the model clues it will lack in real use.
**Workflow.** Choose what must be held out, fit preprocessing and models on training data, tune on validation, then score on separate data.
**Choice.** Clarify whether the score is for new groups or later records from known groups when both uses are possible.

### Standard

**Theory.** Resampling estimates performance for the split and training procedure it reproduces. Group-disjoint and rolling-origin splits estimate different generalization targets.
**Workflow.** Freeze the unit, horizon, and split before tuning. Fit preprocessing inside each training fold, preserve label availability, and use a locked test set or nested evaluation for the final estimate.
**Choice.** Decide which deployment population or time horizon the headline estimate represents.

### Research

**Theory.** In nested CV the outer loop evaluates the full selection procedure at the outer training size. Reporting the best inner-CV score reuses the selection signal. Training-error optimism is the expected excess of loss on fresh responses at the same inputs over training loss.
**Workflow.** Apply group or time restrictions in both loops when deployment requires them. Keep any external test cohort locked and account for dependence among overlapping folds.
**Choice.** Raise procedure performance versus frozen-fit performance only if the target remains open and suitable data exist for both.

### Sources

- [ESL, 2nd ed., §§7.4 and 7.10 (training-error optimism and cross-validation)](https://link.springer.com/chapter/10.1007/978-0-387-84858-7_7)
- [ISLP, ch. 5](https://www.statlearning.com/resources-python)
- [Varma and Simon, bias in cross-validation after model selection](https://doi.org/10.1186/1471-2105-7-91)
- [scikit-learn, cross-validation splitters and sampling assumptions](https://scikit-learn.org/stable/modules/cross_validation.html)

## Linear models, shrinkage, and selection

### Foundations

Assume $E[Y\mid X]=X\beta$ and full column rank. The least-squares matrix $A_0=(X^TX)^{-1}X^T$ satisfies $A_0 X=I$. Any other linear unbiased estimator has matrix $A_0+D$ with $DX=0$. With conditional error covariance $\sigma^2 I$, the cross terms vanish and its extra covariance is $\sigma^2 DD^T$, a positive semidefinite matrix. That is the Gauss–Markov comparison. For ridge with centered predictors and an unpenalized intercept, minimize $\mathrm{RSS}+\lambda\|\beta_{\mathrm{slopes}}\|^2$. The fitted component along a penalized design singular direction with squared singular value $d$ is shrunk by $d/(d+\lambda)$. Compare error on the same folds, inspect coefficient stability, and give inference after selection its own protocol.

### Signals

linear regression | least squares | ridge regression | ridge penalty | lasso | elastic net | regularization path | feature selection | one standard error rule | one se rule | régression linéaire | moindres carrés | régularisation | lasso penalty

### Essentials

**Theory.** A linear model combines features with weights. Shrinkage pulls weights toward zero and can make predictions less sensitive to noise. Some penalties also drop features.
**Workflow.** Fit a simple linear baseline, scale features on training data, and compare the models on fresh data.
**Choice.** Decide whether the result should prioritize prediction or a small set of features that people can inspect.

### Standard

**Theory.** The least-squares residual is orthogonal to the design's column span. Ridge shrinks directions with little information most strongly. An L1 penalty can set coefficients exactly to zero.
**Workflow.** Standardize inside each fold, trace cross-validated error along the penalty path, and check residuals and feature stability.
**Choice.** Choose the model with minimum mean CV loss or use the one-standard-error rule to pick the simplest model within one SE of that minimum. Use the SE at the minimum.

### Research

**Theory.** Under E[Y | X] = Xβ, full rank, and spherical errors, Gauss–Markov gives least squares minimum covariance among linear unbiased coefficient estimators. Ridge with RSS + λ‖β‖² trades bias for variance on penalized directions. The lasso KKT conditions allow a zero coefficient when its absolute residual score is at most the penalty threshold.
**Workflow.** Check conditioning and support stability under resampling. Use a separate inference design for claims after selection.
**Choice.** Distinguish prediction risk, support recovery, and coefficient inference before choosing the analysis.

### Sources

- [ESL, 2nd ed., §§3.2–3.4](https://link.springer.com/chapter/10.1007/978-0-387-84858-7_3)
- [ISLP, chs. 3 and 6](https://www.statlearning.com/resources-python)
- [Tibshirani, Regression Shrinkage and Selection via the Lasso](https://doi.org/10.1111/j.2517-6161.1996.tb02080.x)
- [Hastie, Qian, and Tay, glmnet cross-validation and the one-standard-error rule](https://glmnet.stanford.edu/articles/glmnet.html#cross-validation)

## Classification, calibration, and operating points

### Foundations

At posterior probability $p$, the expected cost of a positive decision is $(1-p)C_{FP}$, and a negative decision costs $pC_{FN}$, assuming correct decisions cost zero. Equating these expressions gives the cost-optimal cutoff when the costs are fixed and probabilities calibrated. Calibration concerns agreement between probabilities and frequency. Ranking survives strictly increasing transformations of a score. Check both against fresh data and validate the cutoff where the decision will run, particularly if prevalence or costs shift.

### Signals

classifier | classification threshold | operating point | probability calibration | calibration curve | calibrated probabilities | decision threshold | roc auc | precision recall | brier score | log loss | false positives | false negatives | seuil de décision | faux positifs | courbe roc | probability cutoff | alert threshold | calibrate | probability

### Essentials

**Theory.** A score can rank cases well and still misstate their chances. Changing the cutoff trades missed cases for false alerts.
**Workflow.** Compare a simple baseline, check whether predicted chances agree with observed frequencies, and inspect how alert volume changes across cutoffs.
**Choice.** Decide how many false alerts are worth catching more real cases, or whether the deliverable only needs to rank cases.

### Standard

**Theory.** ROC AUC measures ranking. Precision depends on prevalence and the threshold. Log loss and the Brier score reward honest probabilities in expectation.
**Workflow.** Calibrate with held-out or out-of-fold predictions, choose an operating point from costs or capacity on validation data, then report discrimination, calibration, and threshold metrics on untouched data.
**Choice.** Decide whether calibrated probabilities, ranking, or a fixed alert workload should drive selection.

### Research

**Theory.** For calibrated posterior p and constant false-positive and false-negative costs, predict positive when p exceeds C_FP / (C_FP + C_FN), taking correct decisions to cost zero. Capacity limits or varying costs change the policy.
**Workflow.** Inspect calibration by relevant slice, quantify uncertainty at the operating point and stress-test under plausible prevalence or cost shifts.
**Choice.** Choose the utility, volume constraint, or abstention policy that defines success.

### Sources

- [ESL, 2nd ed., §§2.4 and 7.2 (costs and log loss)](https://hastie.su.domains/ElemStatLearn/)
- [ESL, 2nd ed., §9.2.5 (ROC curves)](https://link.springer.com/chapter/10.1007/978-0-387-84858-7_9)
- [ISLP, ch. 4](https://www.statlearning.com/resources-python)
- [Gneiting and Raftery, strictly proper scoring rules](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf)
- [Niculescu-Mizil and Caruana, Predicting Good Probabilities with Supervised Learning](https://icml.cc/Conferences/2005/proceedings/papers/079_GoodProbabilities_NiculescuMizilCaruana.pdf)

## Nonlinearity, splines, and additive models

### Foundations

With $\lambda>0$ and at least two distinct inputs, the unique minimizer of residual sum of squares plus $\lambda\int(f''(t))^2\,dt$ is a natural cubic smoothing spline. For a fixed penalty parameter and design, its fitted values are a linear transformation of the response. The trace of that smoother defines its effective degrees of freedom. Natural boundary conditions give linear continuation beyond the outer knots. Treat extrapolation as a modeling commitment. Use residuals, fold-wise validation, and edge plots to identify whether a worse fit comes from insufficient flexibility or unsupported regions.

### Signals

smoothing spline | smoothing splines | regression spline | regression splines | additive model | nonlinear regression | polynomial regression | partial effects | basis expansion | modèle additif | régression non linéaire

### Essentials

**Theory.** A curve can capture a changing trend. A very flexible curve can also follow random bumps or behave poorly outside the observed range.
**Workflow.** Plot the data and residuals, compare a line to a smooth curve on fresh data, and inspect behavior near the edges.
**Choice.** Establish whether the result must extrapolate, explain individual trends, or only predict inside the observed range.

### Standard

**Theory.** Regression splines join low-degree polynomials with continuity constraints. Additive models sum smooth feature effects and need explicit terms for interactions.
**Workflow.** Tune basis size or smoothing inside validation, compare a linear baseline, and inspect support for each smooth.
**Choice.** Decide whether interactions are part of the target or whether additive effects are needed for interpretation.

### Research

**Theory.** With a positive integrated squared second-derivative penalty weight and at least two distinct inputs, the squared-error smoothing problem has a unique natural cubic spline minimizer with knots at the distinct design points.
**Workflow.** Inspect effective degrees of freedom and sensitivity to boundary assumptions. Check correlated smooth terms and support before interpreting partial effects.
**Choice.** Choose the smoothness or shape constraints that the scientific claim can defend.

### Sources

- [ESL, 2nd ed., §§5.2–5.4 and 9.1](https://hastie.su.domains/ElemStatLearn/)
- [ISLP, ch. 7](https://www.statlearning.com/resources-python)
- [Yuedong Wang, Smoothing Splines: Methods and Applications, §1.2](https://api.pageplace.de/preview/DT0400.9781420077568_A23978509/preview-9781420077568_A23978509.pdf)

## Trees, bagging, and boosting

### Foundations

For $B$ tree predictions with common variance $\sigma^2$ and common pairwise correlation $\rho$, the variance of their average follows by summing $B$ variance terms and $B(B-1)$ covariance terms, then dividing by $B^2$. With $\sigma^2$ and $\rho$ fixed, the variance approaches $\rho\sigma^2$ as $B$ grows. Random feature subsampling can help by lowering this shared component, though individual trees may become weaker. Gradient boosting fits a learner to the negative loss gradient at current predictions, which equals the residual for half-squared loss. Choose a baseline suited to the comparison, then tune the ensemble and evaluate the selected procedure on independent cases.

### Signals

decision tree | decision trees | random forest | random forests | gradient boosting | boosted trees | xgboost | lightgbm | tree pruning | bagging | out of bag | arbre de décision | forêt aléatoire

### Essentials

**Theory.** A tree predicts by following simple rules. Combining many trees can improve predictions at the cost of one readable set of rules.
**Workflow.** Fit a small tree first, compare a forest or boosted model on the same split, and inspect where each makes mistakes.
**Choice.** Decide whether a person must be able to follow the whole model or whether a better-scoring ensemble is usable.

### Standard

**Theory.** Bagging averages unstable fits. Random forests randomize candidate features to reduce dependence among trees. Boosting fits trees successively to improve a loss.
**Workflow.** Tune pruning or leaf size, check an ensemble against a small tree at the same evaluation budget, and keep early stopping off the test set.
**Choice.** Decide which latency, stability, or interpretability constraint the fitted model must satisfy.

### Research

**Theory.** For B exchangeable tree predictions with variance σ² and common correlation ρ, the mean's variance is σ²[ρ + (1 − ρ)/B]. Gradient boosting adds weak learners along fitted negative loss gradients.
**Workflow.** Check correlation and error curves as ensemble size grows, compare at matched budgets, and evaluate importance on held-out data with correlated predictors in mind.
**Choice.** Separate predictive comparison from a claim about variable importance.

### Sources

- [ESL, 2nd ed., chs. 10 and 15](https://hastie.su.domains/ElemStatLearn/)
- [ISLP, ch. 8](https://www.statlearning.com/resources-python)
- [Breiman, Random Forests](https://doi.org/10.1023/A:1010933404324)

## Margins and kernels

### Foundations

The soft-margin linear SVM minimizes a squared weight norm plus a penalty on hinge loss, $\max(0,1-yf(x))$ for labels in $\{-1,1\}$. The dual uses only pairwise inner products, so a positive semidefinite kernel can replace those inner products. The support vectors have nonzero dual coefficients. Input scaling changes both the geometry and the meaning of a kernel-width setting. Compare scaling and kernel choices inside the same training folds, and budget prediction cost using the number of support vectors when serving matters.

### Signals

support vector machine | support vector machines | support vector classifier | support vector classification | svm | rbf kernel | margin classifier | kernel trick | noyau gaussien | marge maximale

### Essentials

**Theory.** A margin classifier looks for a boundary with room between classes. A curved boundary can fit more patterns and may fit more noise.
**Workflow.** Scale the features using training data, then compare a simple boundary and a flexible one on fresh examples.
**Choice.** Decide whether added accuracy is worth slower predictions or a harder-to-explain boundary.

### Standard

**Theory.** A soft-margin SVM trades margin size against hinge-loss violations. An RBF kernel controls the distance over which observations influence each other.
**Workflow.** Fit scaling within folds, compare a linear baseline with tuned C and kernel width, and calibrate separately if the output must be a probability.
**Choice.** Specify whether the use case needs a margin score or calibrated probabilities.

### Research

**Theory.** A positive-semidefinite kernel supplies inner products in a feature space. In the soft-margin SVM dual, only nonzero dual coefficients contribute to the decision function.
**Workflow.** Validate kernel and scaling together, track support-vector count and latency, and stress-test under plausible feature-scale or distribution shifts.
**Choice.** Decide which error and serving-budget target should constrain selection.

### Sources

- [ESL, 2nd ed., ch. 12](https://hastie.su.domains/ElemStatLearn/)
- [ISLP, ch. 9](https://www.statlearning.com/resources-python)

## Neural networks and training comparisons

### Foundations

Separate optimization progress, model selection, and independent assessment. A training-loss curve describes fit to training data. A validation curve can choose a checkpoint but becomes part of the selection procedure. For a controlled comparison, match the resource that corresponds to the claim. Equal examples, trials, or GPU-hours answer different questions. Match baseline tuning effort and isolate changes with paired data splits or seeds where this reduces irrelevant variation. Report the optimization and selection protocol alongside the final score.

### Signals

neural network | neural networks | deep learning | checkpoint selection | early stopping | transformer model | fine tuning | finetuning | compute budget | training seeds | semi supervised training | ablation | feature group | réseau de neurones | apprentissage profond | arrêt anticipé | weight decay | model ablation

### Essentials

**Theory.** A larger network can fit more patterns, including noise. Training progress and performance on fresh data answer different questions.
**Workflow.** Start from a simple baseline, choose when to stop using validation data, and evaluate the chosen checkpoint on untouched examples.
**Choice.** Establish whether to optimize result quality or compare what can be achieved within a fixed budget.

### Standard

**Theory.** Backpropagation computes gradients by the chain rule. Early stopping, weight decay, and augmentation change the effective training procedure.
**Workflow.** Track learning curves, use a fixed model-selection rule, log data and seeds, and compare against a simpler model under a stated tuning budget.
**Choice.** Decide whether model comparisons hold compute, data exposure, or search effort fixed.

### Research

**Theory.** A reported run mixes architecture, optimization, data, checkpoint selection and run-to-run variance. Repeated checkpoint selection on the same set adapts the procedure to that set.
**Workflow.** Match the budget tied to the claim, cross or pair seeds where appropriate, and fix the selection and ablation protocol before final evaluation.
**Choice.** Separate a controlled comparison from a best-result claim at a fixed budget.

### Sources

- [ISLP, ch. 10](https://www.statlearning.com/resources-python)
- [REFORMS, modeling and reproducibility](https://arxiv.org/abs/2308.07832)
- [NeurIPS Paper Checklist, experimental details and compute resources](https://neurips.cc/public/guides/PaperChecklist)

## Unsupervised structure and dimension reduction

### Foundations

For centered data, projecting onto a unit direction $v$ explains variance $v^T\Sigma v$. The Rayleigh quotient reaches its maximum at a leading eigenvector. For rank $k$, truncated SVD leaves squared reconstruction error equal to the sum of squared discarded singular values. Variance and distances depend on representation, so validate scaling and feature choice against the use case. When comparing clustering runs, align arbitrary cluster labels or use a label-invariant similarity measure.

### Signals

pca | principal component | principal components | k means | clustering | cluster stability | unsupervised learning | dimensionality reduction | analyse en composantes principales | réduction de dimension | classification non supervisée | explained variance | variance

### Essentials

**Theory.** PCA finds directions that capture variation. Clustering groups nearby points. Both depend on how features are scaled and what counts as nearby.
**Workflow.** Choose meaningful features and scales, inspect the representation, and see whether groups survive reasonable changes.
**Choice.** Decide whether the goal is a compact view of the data or stable groups for people to act on.

### Standard

**Theory.** For centered data, PCA directions are covariance eigenvectors ordered by explained variance. K-means minimizes squared distance to assigned centroids for the given representation.
**Workflow.** Compare scaling choices, tune dimension or cluster count for the intended use, and check stability across initializations and resamples.
**Choice.** Choose whether compression error, stability, or a downstream task should validate the representation.

### Research

**Theory.** Eckart–Young characterizes the truncated SVD as a best rank-k approximation in Frobenius norm. Near-tied eigenvalues can leave individual principal directions unstable while the subspace is stable.
**Workflow.** Inspect spectral gaps and subspace stability, align cluster labels across resamples, and validate any externally named categories on independent evidence.
**Choice.** Distinguish a descriptive partition from a reproducible subgroup or prediction claim.

### Sources

- [ESL, 2nd ed., §14.5 and ch. 14](https://hastie.su.domains/ElemStatLearn/)
- [ISLP, ch. 12](https://www.statlearning.com/resources-python)

## Survival, censoring, and event risk

### Foundations

At event time $t_j$, Kaplan–Meier estimates the probability of remaining event-free through that time as $1-d_j/n_j$ conditional on being at risk just before it. Multiplication gives the survival estimate, with censored individuals removed from later risk sets. This requires independent right censoring within the analyzed risk sets. Dropout related to prognostic covariates may require adjustment. A competing event changes who can experience the event of interest. Estimate cumulative incidence with competing events present when the claim is an observed-world absolute risk. Record time zero and entry separately when follow-up can begin late.

### Signals

survival analysis | survival curve | survival model | censoring | censored data | kaplan meier | cox model | proportional hazards | competing risks | time to event | analyse de survie | risque concurrent | censure à droite

### Essentials

**Theory.** In time-to-event data, some people stop being observed before the event. Their observed follow-up still tells us something about how long they stayed event-free.
**Workflow.** Define the event and time origin, record last follow-up, and inspect how much data is available at each horizon.
**Choice.** Clarify which event and horizon the result should describe, including what happens when another event prevents it.

### Standard

**Theory.** A competing event precludes the target event. Cumulative incidence is the absolute risk with competing events present. A cause-specific hazard is the instantaneous rate of the target event among units still event-free. A hazard ratio compares those rates between groups.
**Workflow.** Use cumulative incidence for observed-world probabilities. Check risk sets, follow-up, and proportional hazards for a Cox comparison.
**Choice.** If both targets are open, ask for absolute risk by a horizon or a relative cause-specific hazard. Keep the implied analysis valid for each.

### Research

**Theory.** Aalen–Johansen estimates cumulative incidence under independent right censoring within risk sets. Censoring competing events in Kaplan–Meier estimates net survival from the cause-specific hazard. Competing causes can be dependent. Interpreting net survival as survival after eliminating competing events requires additional causal assumptions.
**Workflow.** Specify the risk sets, check delayed entry and adjust for covariate-dependent dropout where needed. Assess calibration at the relevant horizon.
**Choice.** Choose a cause-specific rate comparison or an absolute event probability. A mechanistic claim needs evidence beyond the hazard contrast.

### Sources

- [ISLP, ch. 11](https://www.statlearning.com/resources-python)
- [Kaplan and Meier, Nonparametric Estimation from Incomplete Observations](https://jhanley.biostat.mcgill.ca/bios601/SurvivalAnalysis/KaplanMeier1958.pdf)
- [Aalen and Johansen, transition matrices for censored observations](https://www.jstor.org/stable/4615704)
- [Young et al., causal estimands under competing events](https://arxiv.org/abs/1806.06136)

## Uncertainty for performance and comparisons

### Foundations

For two fixed models on the same independently sampled test units, resample those units once per bootstrap draw and recompute both metrics on that draw. This preserves pairing for a score difference. When units contain correlated observations, resample at the independent cluster level where the design supports it. Refitting at fixed tuning adds fitting variability conditional on the chosen settings. To include model-selection variability, rerun selection within each training replicate. Document which data, seeds, and design choices stay fixed before interpreting an interval.

### Signals

confidence interval | confidence intervals | paired bootstrap | bootstrap interval | bootstrap intervals | bootstrap resampling | paired comparison | benchmark comparison | baseline | dataset | seed variability | training seeds | error bars | performance difference | cluster bootstrap | standard error of the estimate | standard error of the difference | intervalle de confiance | incertitude d'échantillonnage | erreur standard

### Essentials

**Theory.** A small score gap can come from the test examples or from rerunning training. Which source of variation matters depends on what will happen next.
**Workflow.** Compare methods on the same examples where possible, report the gap, and name what repeats when the analysis is rerun.
**Choice.** Decide whether the result is about this benchmark, new examples, or new training runs.

### Standard

**Theory.** Pairing holds shared test cases fixed across methods when computing a difference. Resampling individual rows assumes those rows can vary independently.
**Workflow.** Resample the same independent units jointly across models, such as users or sites. Track training-seed variability separately when it matters.
**Choice.** Choose the population and source of variation the reported interval should cover.

### Research

**Theory.** Resampling test units for frozen fits quantifies conditional sampling variability. Refits at fixed tuning capture fitting variability conditional on the chosen settings. Selection variability requires repeating selection.
**Workflow.** For a pipeline-level interval, rerun selection within each training replicate. Match the resampling to the dependence structure, pair shared test units, and account for overlapping CV folds.
**Choice.** Choose uncertainty for frozen fits on new test units or for a refitted selection pipeline when both designs are feasible. A request to freeze fits sets the conditional target.

### Sources

- [ESL, 2nd ed., §§7.10–7.12 (resampling and conditional versus expected test error)](https://link.springer.com/chapter/10.1007/978-0-387-84858-7_7)
- [ISLP, ch. 5](https://www.statlearning.com/resources-python)
- [Bates, Hastie, and Tibshirani, cross-validation targets and uncertainty](https://arxiv.org/abs/2104.00673)
- [Koehn, paired bootstrap resampling for machine translation evaluation](https://aclanthology.org/W04-3250/)
- [REFORMS, uncertainty and reporting](https://arxiv.org/abs/2308.07832)

## Multiple testing and selective claims

### Foundations

For $m$ valid p-values, testing each true null at $\alpha/m$ gives probability at most $\alpha$ of any false rejection by the union bound. The Benjamini–Hochberg step-up rule orders all $m$ values and rejects through the largest rank $k$ with $p_{(k)}\le qk/m$, under the dependence conditions for its FDR guarantee. A search over hypotheses can change the tested family or invalidate marginal p-values. State the family and prior selection steps, and use independent confirmation when the original design cannot support the intended claim.

### Signals

multiple testing | multiple comparisons | false discovery | family wise error | fwer | fdr | benjamini hochberg | bonferroni | selective inference | multiple hypotheses | correction de multiplicité | tests multiples | fausses découvertes

### Essentials

**Theory.** When many effects are checked, some can look convincing by chance. The amount of evidence needed depends on whether the work is finding leads or confirming claims.
**Workflow.** List what was tested, label exploratory findings, and reserve separate evidence for confirmation where possible.
**Choice.** Decide whether the output should produce leads for follow-up or support a small set of firm claims.

### Standard

**Theory.** Family-wise error is the chance of at least one false rejection. False discovery rate is the expected false share of discoveries, with the share defined as zero when none are made.
**Workflow.** Define the family before inspecting results, use a correction appropriate to the error criterion, and report effects as well as adjusted significance.
**Choice.** Choose the error criterion based on how the discoveries will be used.

### Research

**Theory.** Bonferroni controls FWER under arbitrary dependence with valid marginal p-values. Benjamini–Hochberg (BH) controls FDR under independence or positive regression dependence on the subset of true nulls (PRDS). Under arbitrary dependence, Benjamini–Yekutieli applies BH at q / (1 + 1/2 + … + 1/m) for m tests.
**Workflow.** Define the tested family and account for prior filtering. Justify PRDS beyond pairwise positive correlations if using BH under dependence.
**Choice.** If the guarantee is open, choose between controlling the chance of any false rejection and controlling the expected false share of discoveries.

### Sources

- [ISLP, ch. 13](https://www.statlearning.com/resources-python)
- [Benjamini and Hochberg, controlling the false discovery rate](https://doi.org/10.1111/j.2517-6161.1995.tb02031.x)
- [Benjamini and Yekutieli, FDR under dependence](https://doi.org/10.1214/aos/1013699998)

## Effects, identification, and sensitivity

### Foundations

Consistency connects observed and potential outcomes for the received treatment. Conditional exchangeability lets a conditional mean among treated or untreated stand in for the corresponding potential-outcome mean. Positivity requires positive probabilities of each treatment being compared throughout the target covariate support. Finite samples can still have empty strata. Under these conditions, averaging the conditional outcome-mean contrast over the target population identifies an average effect. Write the target trial, draw the assignment and outcome timeline, and inspect whether covariate overlap and measurement make the proposed contrast credible.

### Signals

causal inference | treatment effect | propensity score | observational study | difference in differences | confounding | causal effect | effet causal | score de propension | effet du traitement | inférence causale

### Essentials

**Theory.** Predicting what happens and finding what an action changes are different jobs. People receiving an action may already differ from the others.
**Workflow.** Name the action, comparison, outcome, and time window. Inspect how people got the action and whether the groups can be compared.
**Choice.** Decide whether the result is for prediction, description, or a claim about the effect of an intervention.

### Standard

**Theory.** Under consistency, conditional exchangeability, and positivity, adjusting for appropriate pre-treatment covariates can identify an average treatment effect. Positivity requires a positive chance of each treatment across the target covariate support. Some sample strata can still be empty.
**Workflow.** Write the target trial, choose time zero, inspect overlap and balance, and run sensitivity checks tied to the assignment process.
**Choice.** Decide whether to target the eligible population, treated units, or a supported overlap population.

### Research

**Theory.** The ATE and ATT integrate conditional effects over different covariate distributions. Doubly robust estimation can protect against misspecification of one nuisance model under its conditions, while causal identification still requires assumptions about assignment and outcomes.
**Workflow.** State the identification argument and assess practical positivity, interference, and unmeasured confounding.
**Choice.** Select the estimand and defensible sensitivity analysis before choosing the estimator.

### Sources

- [Hernán and Robins, Causal Inference: What If](https://miguelhernan.org/whatifbook)
- [REFORMS, outcome definition and claims](https://arxiv.org/abs/2308.07832)

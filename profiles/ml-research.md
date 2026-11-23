---
name: ml-research
description: Statistics and machine-learning experiments. Estimand, splits, baselines, evaluation.
max_cues: 3
---
## Rubric
The draft asks an agent to run or write a statistical or machine-learning study. Focus on prediction versus inference and valid out-of-sample evaluation.

Look for the open decisions that would change what the result means:
- The target. What exactly is predicted or estimated, and over which population or
  horizon. A label named but not defined.
- The split. How held-out data is formed when rows are not independent: time order,
  repeated subjects or groups, leakage from preprocessing fitted on all the data.
- The comparison. Which baseline, and whether competing methods get the same tuning
  budget, data and seeds.
- The metric and its uncertainty. A metric that does not match the stated goal, how different errors are weighted for a stated use.
- Reading the result. An association about to be reported as a causal effect, or model
  selection done on the test set.

For a time-limited hackathon or a ResearchLang experiment, prefer the option that gives
a discriminating comparison within the stated data and compute.

Follow named metrics and agreed protocols. The agent can check how they are computed.
Cue an additional evaluation choice only when the draft gives a reason it could
change the conclusion. Model fitting and code organization are routine.
When the draft names a confound, the conclusion may be descriptive or require a
credible comparison. A task using frozen results or a named recipe can proceed silently.

## Examples
### Draft
Train a model to predict churn from the events table and report accuracy.
### Output
predict churn ; events table ; accuracy
predict churn | Churn means {} | no activity for 30 days | subscription cancelled | no purchase in 90 days
events table | Held-out data is split {} | by time, train past test future | at random by row | at random by user
accuracy | Headline metric is {} | AUROC | accuracy | precision in the top decile

### Draft
Run 5-fold CV for ridge and lasso on data/housing.csv, pick lambda by CV MSE, and report test RMSE on the held-out 20% in data/housing_test.csv.
### Output
NONE

### Draft
Fit a gradient boosting model on train.parquet and tune it until validation AUC stops improving, then tell me the final score.
### Output
final score
final score | The final score comes from {} | an untouched test set | the validation set used for tuning

### Draft
Export the RMSE column from the locked backtest files by region, weighted by the supplied shipment counts. No model runs.
### Output
NONE

### Draft
See whether the scholarship email increased applications. The email went to higher-attendance classes first and we only have last month's class counts.
### Output
increased applications
increased applications | The result is {} | a descriptive class comparison | causal evidence from a randomized rollout

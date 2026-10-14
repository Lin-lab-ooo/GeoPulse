# GeoPulse: trained NumPy window MLP autoencoder pilot

This is a real 128 → 32 → 8 → 32 → 128 MLP autoencoder (8,904 trained parameters), with tanh hidden layers, linear reconstruction, MSE loss, Adam, normal-only training, and three fixed seeds. It is **not a Conv-AE, GNN, pretrained model, failure predictor, or reliable industrial alarm**.

## Reproduce

Python 3 with NumPy is the only training dependency. From the project directory:

```
python ml/train.py
python ml/calibrate.py
node --test tests/neural-model.test.mjs
```

`train.py` verifies/downloads the four upstream CSVs and license using `sources.json` hashes, writes the initial cross-mode evaluation, per-point predictions and training losses, and exports seed 7. `calibrate.py` evaluates the explicitly exploratory second protocol with frozen weights and exports the calibrated replay candidate. `base-model.json` retains the original frozen seed-7 model. No browser/GPU training dependency is installed.

## Data provenance and third-party license

Data authors: Iurii Katser and Vyacheslav Kozitsin, SKAB, https://github.com/waico/SKAB . Original CSV bytes live in `data/`; exact download URLs and SHA-256 hashes are in `sources.json`. Their separate upstream GPL-3.0 license is retained in `data/LICENSE-SKAB-GPL-3.0.txt` and `public/ai/LICENSE-SKAB-GPL-3.0.txt`. `public/ai/replay.json` is a JSON reformat of the complete valve1/1.csv experiment, with unchanged values, timestamps and labels. Its map position is an explicit demonstration mapping, not a geographic fact from SKAB. Only NumPy is used by our independently written training implementation; no upstream model code is copied.

## First protocol and negative result

The anomaly-free file is split chronologically into 60% training, 20% early-stopping validation and 20% threshold calibration, with 16-row gaps. Normalization uses only training rows. Windows contain 16 timestamps × 8 sensor channels. Windows crossing non-increasing timestamps or gaps greater than 1.5 times the segment median positive interval are excluded, with no interpolation. This leaves 422 training, 538 early-stop and 555 threshold windows. The three separate, predetermined experiments valve1/1.csv, valve2/1.csv and other/1.csv produce 577 valid scored test windows. All models use the same valid timestamps. Maximum epochs 30, early-stop patience 5, batch size 128, learning rate .001, seeds 7/19/41. Threshold is the held-out normal-score 99th percentile. Deployed seed is fixed to 7, never chosen by test accuracy.

All three seeds and both baselines falsely flag all normal test points (FPR 100%). Seed 7 has F1 .4836 and AP .4238. The test operating regimes differ sharply from the training file: valve1 normal flow shifts by −58.09 training standard deviations, vibration channels by −42.84/−57.70. This failure is retained in `evaluation.json` and `predictions.csv`.

## Exploratory deployment calibration

After observing the failure, a second, explicitly exploratory protocol was fixed: an operator must certify the first 256 readings of each deployment regime as normal. Dataset labels verify that assumption here; all three prefixes are normal. Each prefix fits its own per-channel normalization and 99th percentile score threshold. AE weights and PCA basis remain frozen. All methods receive exactly the same prefix budget. A 16-row gap follows the prefix; evaluation windows begin in the segment at row 272, with the first possible score at row 287. Prefix/gap rows are excluded from evaluation. Gaps leave 410 evaluated points, with 73/15/65 valid calibration windows per experiment. The small second calibration set is an additional limitation.

Overall AE precision .5844, recall .7717, F1 .6651, AP .6999, FPR .4469. PCA F1 .5260/AP .6544/FPR .3761; standardized-energy F1 .6495/AP .7221/FPR .4646. AE does not consistently beat simple baselines: its AP is below statistical energy and its FPR remains high. This is an experimental candidate, not demonstrated reliable monitoring. The post-failure protocol is not a fresh untouched holdout result. See `exploratory-calibration.json` and `exploratory-predictions.csv`.

AP is unadjusted per-point average precision; aggregate exploratory AP ranks scores divided by each experiment's calibrated threshold. F1 uses the same per-experiment threshold ratio of 1. No point adjustment, test-set threshold selection or seed selection is used. Reconstruction channel residuals identify disagreement, not fault causes.

## Browser API

`new Worker('/js/neural-worker.js', {type:'module'})`. Send `{type:'start', runId, intervalMs:100, loop:false, startIndex:0}` and `{type:'stop',runId}`. Only the matching active run can be stopped. A newer start cancels an older pending asset load. A single serial timer and a 16-reading history keep work bounded; main-thread rendering and the GPU are not used for inference.

`ready` includes `model.name/windowSize/channels/threshold/experimental/evaluation/calibration`, data source, total samples, actual start and suggestedStartIndex. `evaluation` contains `overall`, `experiment`, `baselines.pca/statistical` (precision/recall/f1/ap/falsePositiveRate and counts) and the original failure results. A `sample` contains runId/index/timestamp/readings/score/threshold/status/channelResiduals/groundTruth/latencyMs. `status` is warming/normal/anomaly; warming score is null. Labels appear only for evaluation and a suggested demonstration start (first anomaly minus 64); inference never reads them. `done`, `stopped`, and `error` terminate a run.

The exported candidate is calibrated only for the valve1 replay. Offline prefix calibration is not backdated into predictions: indices before the evaluation segment plus a complete window remain warming. Arbitrary startIndex preloads at most 15 strictly prior readings, never future samples, and resets history on timestamp gaps. The suggested view is selected using ground truth for demonstration only, without changing evaluation.

`parity-fixtures.json` stores three independent Python float64 predictions, checked against browser-compatible JS to relative tolerance 1e-9. Tests also verify source hashes, retained negative results, frozen weights, label independence, bounded scheduling, restart/stop races and prevention of scoring before calibration.

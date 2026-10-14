# Whole-map report analysis sources and static replot

This folder publishes the chart/analysis source behind the dated [whole-map report](../../reports/whole-map-2026-10-14/README.md), plus a small entry point to redraw four figures from its public aggregates. These are measured trials. Synthetic business input does not mean synthetic timing values.

Install the plotting dependencies and run from the repository root:

```sh
python -m pip install matplotlib numpy
python tools/whole-map-report-analysis/replot.py --out /tmp/geopulse-replot-new
```

On Windows, choose a new temporary output directory, for example `--out "$env:TEMP/geopulse-replot-new"`. The directory must not already exist and must be outside the immutable report package. `--data` may select another copy of the dated package. This script reads JSON, uses Matplotlib's Agg backend, and writes static PNG/SVG. It launches no browser or GPU workload and does not re-run performance trials.

The four figures show matched 100k whole-map readiness, actual two-ID updates, separate camera CPU/GPU spans, and separate Baidu startup/business-stream scopes. Every repeat distribution is checked by recomputing median/min/max from the three published per-trial values. Output `replot-verification.json` records input/script/output SHA and the checked numbers. The layout is a readable redraw; byte-identical recreation of the original 22 figures is not claimed. No milliseconds are converted into physical FPS.

The [numeric raw evidence extractor](../../reports/whole-map-2026-10-14/measurements/README-evidence.md) independently supplies frame, batch, span, update, window and presentation-point measurements. That workflow supports raw-statistic checks; replot.py consumes already-aggregated measurements and is not an independent raw reanalysis or benchmark. Complete multi-GB CDP traces and SDK bundles are not shipped.

## Historical analysis source audit

[historical-adapted/](historical-adapted/) contains the archived primary/helper, matched, position-update, Baidu and trace analyzers. Each came from its original analysis directory rather than a newer workspace script. [source-adaptations.json](source-adaptations.json) records the exact original archived SHA and separate public-file SHA.

Public adaptations remove machine-specific font paths, use repository-relative/`--source-root` defaults for production source verification, and correct the Baidu historical report-text typo that claimed initial tile failed=0 (raw complete1 reports 2). Numeric aggregation and plotting algorithms are preserved. A custom font may be supplied as `GEOPULSE_REPORT_FONT`. Matched/trace sources with no required edits retain their original bytes.

The full historical CLIs require original report/trial/trace files and bound source/vendor assets, which this public summary does not supply. Use them to audit methodology and original figure code; use replot.py for a self-contained public redraw. Their original hashes bind the original private archive bytes, not public adaptations. The frozen dated report and its original chart bytes remain unchanged.

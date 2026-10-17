# GeoPulse

**English** · [简体中文](README.zh-CN.md)

A streaming WebGL map prototype for campus and industrial-park point, line, and area data. It continuously reads HTTP NDJSON, parses batches in a Worker, stages data incrementally on the main thread, and waits for an upload acknowledgment before proceeding to the next batch. The defaults are fixed batches of 2,048 features and demand-driven rendering. The local sandbox runs without an account; the Baidu basemap requires your own browser API key (AK).

![Local WebGL workspace](docs/assets/workspace.png)

The screenshot comes from a cold-start check of the local sandbox without an account or external network access. Its requestAnimationFrame (rAF) callback metrics are not screen presentation frame rates.

## Quick start

Install Node.js 20 or later, then run this command from the repository root:

```sh
npm start
```

Open http://127.0.0.1:4173/ . There are no npm dependencies to install. On Windows, you can also double-click `start.cmd`. Start with the local sandbox, which does not require a map account. To connect to Baidu, enter your own browser AK under “地图接入” (Map connection) and configure its referrer allowlist. Do not commit an AK to this repository.

Start loading to explore the point, line, and area layers, pan and zoom the map, and inspect alerts and run logs. You can stop the stream and start a new load. The export buttons save reports to the local `reports` directory; exported files are excluded from Git by default.

## Implementation highlights

- **Continuous streaming and backpressure:** parsing respects the remaining capacity of the current batch. The main thread sends an ACK after issuing all geometry-upload commands for the complete batch, with at most one unacknowledged batch in flight. An ACK does not mean GPU execution or screen presentation has completed.
- **Incremental updates:** dirty ranges are merged for contiguous vertices bound to the same ID, avoiding repeated full-page statistics. A compact submission receipt is optional. Position updates affect the currently bound slots; later appends with the same ID retain their newly supplied coordinates.
- **Spatial picking:** the complete spatial tree narrows the candidate set before an exact nearest-vertex calculation. Picking falls back to a full scan while the tree is incomplete. Moved objects, deletion, and transparency are handled separately.
- **Demand-driven rendering:** data changes, interaction, animation, and tree-building work trigger rendering. Active effects such as alert pulses continue to draw; “demand” does not mean permanently zero frames.
- **Auditable experiments:** positions, uploads, candidates, primitive completeness, failure states, and actual exports are validated separately. Negative results are retained, and component CPU speedups are not converted into whole-map FPS claims.

Dynamic bounding-box maintenance and the “first batch 2,048, subsequent batches 8,192” policy remain research candidates; neither has replaced the production defaults. The five-combination evaluation includes 246 quality assertions, 72 complete RGBA comparisons, and 54 performance loads. See the [test report](docs/TEST-REPORT.md) for the evidence, adoption status, and negative results.

## Whole-map performance reports and charts

[Browse the redesigned charts by topic](reports/whole-map-2026-10-15-design/README.md). Each chart covers one topic and retains individual measurements, medians, and ranges. Loading, updates, CPU, GPU, and Baidu validation are presented separately. After downloading the repository, open that report's `index.html` to view one chart at a time. This update only reorganizes the charts; the original data and reports are preserved.

The [2026-10-14 whole-map report](reports/whole-map-2026-10-14/README.md) compares streaming ingestion, camera interaction, and position updates on a real city basemap, with separate CPU, GPU, and browser presentation feedback. The table below shows medians from three local runs with 100,000 synthetic points and matched batch settings. MapLibre uses its native update coalescing. The report lists each library's completion contract and repeat ranges separately.

| Metric | GeoPulse | deck.gl | MapLibre |
| --- | ---: | ---: | ---: |
| Basemap + business overlay ready | 293.9 ms | 327.8 ms | 1535.9 ms |
| Two-point position update to actual draw confirmation | 3.7 ms | 4.2 ms | 504.3 ms |

Readiness includes basemap resources and the business-data pipeline, but excludes JavaScript bundles loaded before the run. The observed strengths are data ingestion and position updates in these workloads. There is no evidence that GeoPulse leads in steady-state whole-map GPU rendering, and loading gains cannot be converted into FPS improvements. The readiness-time ranges overlap with deck.gl, so the small difference between medians does not establish a general advantage.

![Basemap and business overlay readiness: three measurements, median, and range](reports/whole-map-2026-10-15-design/figures/matched/whole-map-ready.png)

[Two-point update chart](reports/whole-map-2026-10-15-design/charts/updates/two-point-update-wall.md) · [Whole-map CPU chart](reports/whole-map-2026-10-15-design/charts/matched/camera-whole-map-cpu.md) · [Whole-map GPU chart](reports/whole-map-2026-10-15-design/charts/matched/camera-whole-map-gpu.md).

The Baidu product path was tested separately with 100,000 synthetic points, lines, and rectangles (120,000 vertices) on a real Shanghai basemap. Median business-data loading time after the basemap was ready decreased from 454.3 ms to 254.3 ms. SDK connection and basemap network readiness were recorded separately. This is a local comparison of fixed batching and hybrid batching; it is not a whole-map cold-start measurement or a frame-rate improvement.

The default Baidu integration uses the SDK's standard basemap to avoid a blank map if an optional custom style fails to load. Future primary performance conclusions follow the [whole-map benchmark protocol](docs/WHOLE-MAP-BENCHMARK-PROTOCOL.md): validate the basemap first, measure the complete pipeline, and retain missing values, failures, and differences in confirmation contracts.

## Tests and reproduction

```sh
npm test
```

This runs the core Node tests included in this repository and requires no AK, browser, or external service. On October 14, 2026, this public copy was tested with **594/594 passing, 0 failures, and 0 skipped tests**. For a new run, use that run's output. Do not equate the 612 tests in the historical full research workspace with the default test count in this smaller public repository.

The archived pre-publication verification also records **594/594 passing**. See the [publication verification record](docs/WHOLE-MAP-PUBLICATION-CHECKS.json) for the test receipt, source identity, and scope of the measurement evidence.

See [chart reproduction](tools/whole-map-report-analysis/README.md) for the chart source and commands to redraw the published aggregate data. No map AK is needed.

See [redesigned-chart reproduction](tools/whole-map-report-design/README.md) for the commands that generate the individual charts and gallery.

To validate actual streaming, Workers, complete primitive uploads, pixels, updates, cancellation, and exports, use the independent pipeline tools described in [optional browser reproduction](docs/BROWSER-REPRODUCTION.md). They are not part of the default CI, and the research combinations have not changed the production defaults.

An archived-evidence audit that depends on approximately 69.23 MiB of historical JSON is available separately through `npm run test:archive`. The historical original reports are not copied into this public repository. If its inputs are missing, the command explicitly exits with code 2 rather than silently skipping. See [archive tests](docs/ARCHIVE-TESTS.md). GitHub Actions runs only the core Node tests; it does not replace native WebGL, real SDK, or performance testing.

## Current limitations

The million-feature stress workload consists of fixed-seed synthetic points, polylines, and axis-aligned rectangles, not a million real devices. Arbitrary concave polygons, holes, and full GeoJSON editing are not supported. Line and area picking still uses nearest-vertex semantics.

Forcing context loss in the real Baidu SDK has triggered a full-page reload; recovery of the original map instance has not been demonstrated. Successful normal loading does not cover that failure. The neural-network demonstration retains false positives and negative-benefit results and is not a reliable industrial alerting system. See [known limitations](docs/KNOWN-LIMITATIONS.md).

## License and provenance

Original project source is licensed under [MIT](LICENSE). The SKAB data and its reordered files have separate GPL-3.0 license text and author attribution; the project's MIT declaration does not replace those terms. See [third-party notices](THIRD_PARTY_NOTICES.md) and the [model experiments](ml/README.md). The Baidu SDK is loaded online, and users must configure their own service accounts.

GitHub: [Lin-lab-ooo/GeoPulse](https://github.com/Lin-lab-ooo/GeoPulse) · Gitee: [lin-lab/GeoPulse](https://gitee.com/lin-lab/GeoPulse). Both repositories use the same release history. Historical creation-time manifests retain their original status and do not describe the current publication state.

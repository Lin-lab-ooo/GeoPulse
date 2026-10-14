# Third-party materials

The project source is covered by the root MIT license. The following materials retain their separate provenance and license notices.

## SKAB data

Authors: Iurii Katser and Vyacheslav Kozitsin. Upstream: https://github.com/waico/SKAB . The source URLs, SHA-256 values and byte counts are recorded in [ml/sources.json](ml/sources.json).

Original CSV data and the preserved upstream GPL-3.0 text are in [ml/data](ml/data/NOTICE.txt). [public/ai/replay.json](public/ai/replay.json) reformats the valve1 experiment; timestamps, readings and labels are retained. Its map position is a demonstration mapping, not a geographic fact. The GPL-3.0 text is also preserved in [public/ai](public/ai/LICENSE-SKAB-GPL-3.0.txt).

The project MIT notice does not replace this separate data license. In this public checkout, the public/ai NOTICE's historical `../sources.json` reference was corrected to `../../ml/sources.json`. This is a provenance-path correction; model, replay and algorithm bytes were retained. Along with the core/archive package script split, it changes the complete runtime fingerprint from the original measured checkout.

Training and exploratory calibration are documented in [ml/README.md](ml/README.md), including negative results and the limits of the exported candidate. No upstream model implementation is copied by the independent NumPy training code.

## Baidu Maps

The SDK is loaded from its service at runtime using the user's own account configuration. SDK source, account credentials, POI response caches and long diagnostic SDK excerpts are not bundled as open-source project code or data.

## Whole-map benchmark figures

The cross-renderer report uses MapLibre GL JS 6.14.0 (BSD-3-Clause) and deck.gl 9.4.0 (MIT). Their package sources and native SDK bundles are not vendored in the report. The common city basemap comes from the [MapLibre demotiles](https://github.com/maplibre/demotiles) repository pinned at commit `601ae60796ceceda2cbd2ed3d2ea92d17a84be4b`.

The map imagery in the report is attributed to [OpenMapTiles](https://openmaptiles.org/) and [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). OpenStreetMap data retains its ODbL terms; applicable OpenMapTiles style/schema materials retain their CC BY 4.0 notices. No city vector tiles or font files are bundled in this report. Attribution also accompanies cropped map screenshots where a canvas export did not include the native attribution control. Baidu map screenshots retain the native Baidu attribution; they do not license the Baidu SDK or map data under the project's MIT license.

## CI tooling

The CI configuration references the official [actions/checkout](https://github.com/actions/checkout) and [actions/setup-node](https://github.com/actions/setup-node) v7 usage documentation checked during preparation. Their source is not vendored. The workflow requires no project secret and runs local Node tests only.

# Public whole-map measurement evidence

These files are derived, allowlisted measurements for the 2026-10-14 whole-map evaluation. They contain **all 54 requested trials**: formal-realmap1 (27), matched-policy1 (9), minimal-policy1 (9), native-coalesced1 (3), and the final baidu-production-complete1 product run (6). Earlier Baidu standard and diagnostic runs are excluded from this package and are not combined with the final product run.

The five gzip NDJSON files total **19,793,973 bytes (18.88 MiB)**. Every file starts with one group metadata record, followed by one record for each trial. Read one line at a time; full traces are neither required nor included. The manifest records source identities, original report/trial/trace SHA-256 and byte counts, extractor SHA-256, compressed and uncompressed derivative hashes, measurement counts, field allowlists, and coverage. Gzip uses an empty filename and `mtime=0`; no machine-specific gzip metadata is written.

## Retained evidence

- Per-frame CPU service time, shared-context GPU timing, GPU status, null/unavailable values, timing boundaries, windows, phase marks, and GL upload counters.
- Per-batch timestamps, point/count progress, worker metrics, network/read/parse/pack/ACK/backpressure timing, ACK type, and coalesced final actual-render receipts.
- Actual business-frame revisions and update receipts, requested update counts, and completion wall times. An enqueue ACK is not a draw ACK. Coalesced readiness requires all native update promises, complete count, committed revision, and nonempty native business draw evidence.
- Typed spans with start/end, thread, phase, scope/kind, status, and parent IDs where available. These are column arrays rather than repeated dictionaries. Scalar layerId/layerType/renderPass/sourceId identifiers are retained; structured sourceId values are null. Building/place-label layer calls can be checked, but a layer call alone does not prove nonempty pixels or complete visual quality. Keep synchronous CPU, awaited wall intervals, and GPU spans separate. Nested phases and concurrent threads cannot be added as end-to-end elapsed time.
- Baidu baseline/loading/camera frames, per-window coverage, stage spans, business protocol/terminal metrics, geometry digests, and safe resource-response metadata. The original final tile network record has **2 failed tile requests**, 16 completed successful tile responses, zero in-flight tiles, and a quiet network; failed cases are retained.
- Browser presentation points, exact profiler-window bounds, and clock anchors from previously generated trace analyses. These are browser-reported presentation feedback, not certified physical display scanout. Physical FPS and physical latency remain null. Native rAF callback rates are not physical FPS. Legacy business fields `fps`, `fpsMean`, `frameP95`, and `frameP99` are retained with their original names for business rAF telemetry only; they cannot be treated as whole-map, browser-presentation, or physical FPS.

`minimal-policy1` has no collected detailed CPU/GPU frames, stage windows/spans, or browser trace. Those arrays are empty and unavailable derived values remain null. Previously analyzed trace presentation points exist for the formal, native-coalesced, and final Baidu groups; matched-policy1 raw traces have SHA identities but no previously generated presentation analysis in this evidence source, so its browserTrace is null. A null measurement is never converted to zero.

## Read and recompute

Tables have `columns`, `rows`, per-column `dictionaries`, and optional `constants`: each row position corresponds to the named column. When a column appears in `dictionaries`, a non-null integer in that column indexes its exact original categorical string. Fields in `constants` apply unchanged to every row and must be merged into decoded rows. This is a lossless encoding; numeric timing/count columns retain their original values and nulls remain null. `profile.frames`, `profile.spans`, `profile.windows`, `batches`, `businessFrames`, `workerSpans`, and Baidu window tables use this format. Missing input fields are represented by null. `profile.uploads` aligns by row index with `profile.frames`; `batchWorkerMetrics` aligns by row index with `batches`.

```python
import gzip, json

with gzip.open('formal-realmap1.ndjson.gz', 'rt', encoding='utf-8') as stream:
    for line in stream:
        trial = json.loads(line)
        if trial['record'] != 'trial':
            continue
        frame_table = trial['profile']['frames']
        dictionaries = frame_table.get('dictionaries', {})
        frames = [
            {**frame_table.get('constants', {}),
             **{key: (dictionaries[key][value]
                      if key in dictionaries and value is not None else value)
                for key, value in zip(frame_table['columns'], row)}}
            for row in frame_table['rows']
        ]
```

Frame inclusion is `window.startEpochMs <= frame.startEpochMs < window.endEpochMs`. Frame CPU/GPU distributions use linearly interpolated quantiles at `(n-1)*q`, one scalar per trial, then repeat medians and full ranges. GPU distributions include measured, valid samples only. Span accounting clips intervals to each window and unions intervals on the same thread; phase rows overlap and must not be summed. Native worker calls do not certify a complete aggregate worker CPU total.

`verification.json` contains **3,483 successful independent checks** against the existing private analyses: per-trial CPU/GPU distributions including medians/P95/P99, exact whole-map readiness endpoints, actual native coalesced final-render proof, update wall distributions, and matching drawn revision evidence. The MapLibre update reference belongs to native-coalesced1; GeoPulse and deck.gl update references belong to matched-policy1. No cross-group trial substitution is performed.

To regenerate using access to the private sources:

```text
python tools/whole-map-public-evidence.py --source PRIVATE_RESULTS --output NEW_PUBLIC_EVIDENCE_DIRECTORY
```

The extractor reads reports and one trial at a time; it hashes complete traces in chunks without parsing them. Browser presentation data comes from bounded existing trace-analysis files. Use a new output directory for a new evidence release. The published package is an allowlisted derivative, not the original complete raw reports.

## Privacy and scope

This package excludes local absolute paths, user accounts, AKs and other credentials, URL query strings, raw URLs, stacks, source JSON payloads, SDK native JavaScript, OSM/vector tile bytes, complete HAR/CDP traces, and full resource bodies. The extractor only selects named fields, additionally rejects unsafe strings, and retains SHA-256 identities without deleting hexadecimal hashes as false credential matches. A scan of 216,149 decoded strings found zero path/URL/account/query-token pattern matches; the release also requires the repository's exact credential scan.

MapLibre-based matched comparisons use the same map platform. Baidu is a separate actual product validation and cannot be used to attribute cross-platform differences to GeoPulse's algorithm. This release retains observed measurements and negative/missing cases, and does not infer a product's maximum throughput from strict per-batch confirmation or update-loop workloads.

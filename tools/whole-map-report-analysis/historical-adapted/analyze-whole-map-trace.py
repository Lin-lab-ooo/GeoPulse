#!/usr/bin/env python3
"""Analyze owned whole-map CDP traces without claiming physical display FPS.

Only reads the supplied trace and writes a new compact JSON file. Frame evidence
is paired by trace async ID and bound to a renderer by wm-* marks or --renderer-pid.
Chromium source reference (implementation varies with browser version):
https://github.com/chromium/chromium/blob/main/cc/metrics/compositor_frame_reporter.cc
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import math
import pathlib
import statistics
from typing import Any

RELEVANT_TERMS = (
    "FramePresented", "FrameDisplayed", "PipelineReporter", "FrameReporter",
    "SubmitCompositorFrame", "SwapBuffers", "Presentation", "Display::DrawAndSwap",
    "DrawFrame", "BeginFrame", "RenderingStats", "FireAnimationFrame", "RunTask",
)
PRESENTED_STATES = {"STATE_PRESENTED_ALL", "STATE_PRESENTED_PARTIAL"}
RECOMMENDED_CATEGORIES = [
    "blink.user_timing", "benchmark", "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-display.framedisplayed",
]


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def async_id(event: dict) -> str | None:
    value = event.get("id2", event.get("id"))
    return json.dumps(value, sort_keys=True, separators=(",", ":")) if value is not None else None


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    at = (len(values) - 1) * q
    lo, hi = math.floor(at), math.ceil(at)
    return values[lo] + (values[hi] - values[lo]) * (at - lo)


def stats(values: list[float]) -> dict:
    return {
        "n": len(values), "minMs": min(values) if values else None,
        "p50Ms": percentile(values, .5), "p95Ms": percentile(values, .95),
        "p99Ms": percentile(values, .99), "maxMs": max(values) if values else None,
    }


def cadence(timestamps_us: list[float], scope: str) -> dict:
    timestamps = sorted(set(timestamps_us))
    intervals = [(b - a) / 1000 for a, b in zip(timestamps, timestamps[1:]) if b > a]
    duration = (timestamps[-1] - timestamps[0]) / 1000 if len(timestamps) > 1 else None
    return {
        "scope": scope, "uniqueTimestampCount": len(timestamps),
        "firstTraceTsUs": timestamps[0] if timestamps else None,
        "lastTraceTsUs": timestamps[-1] if timestamps else None,
        "observedSpanMs": duration,
        "intervals": stats(intervals),
        "browserObservedCallbacksPerSecond": (len(timestamps) - 1) * 1000 / duration if duration else None,
        "physicalPresentationFps": None,
    }


def union_length(intervals: list[tuple[float, float]]) -> float:
    if not intervals:
        return 0.0
    total = 0.0
    start, end = sorted(intervals)[0]
    for lo, hi in sorted(intervals)[1:]:
        if lo <= end:
            end = max(end, hi)
        else:
            total += end - start
            start, end = lo, hi
    return total + end - start


def pairs(events: list[dict], names: set[str]) -> tuple[list[dict], dict]:
    opened: dict[tuple, list[dict]] = collections.defaultdict(list)
    complete, orphan_end = [], 0
    for event in sorted((e for e in events if e.get("name") in names), key=lambda e: e.get("ts", 0)):
        token = async_id(event)
        if token is None:
            continue
        key = (event.get("pid"), event.get("name"), token)
        if event.get("ph") == "b":
            opened[key].append(event)
        elif event.get("ph") == "e":
            if opened[key]:
                begin = opened[key].pop()
                if finite(begin.get("ts")) and finite(event.get("ts")) and event["ts"] >= begin["ts"]:
                    complete.append({"begin": begin, "end": event, "token": token,
                                     "pid": begin.get("pid"), "durationMs": (event["ts"] - begin["ts"]) / 1000})
            else:
                orphan_end += 1
        elif event.get("ph") == "X" and finite(event.get("dur")):
            end = {**event, "ts": event["ts"] + event["dur"]}
            complete.append({"begin": event, "end": end, "token": token,
                             "pid": event.get("pid"), "durationMs": event["dur"] / 1000})
    return complete, {"orphanEnds": orphan_end, "openBegins": sum(map(len, opened.values()))}


def epoch_from(value: Any) -> float | None:
    if isinstance(value, dict):
        for key in ("browserEpochMs", "epochMs", "epochTimeMs"):
            if finite(value.get(key)) and value[key] > 1e12:
                return value[key]
        for child in value.values():
            answer = epoch_from(child)
            if answer is not None:
                return answer
    elif isinstance(value, list):
        for child in value:
            answer = epoch_from(child)
            if answer is not None:
                return answer
    elif isinstance(value, str) and value.startswith("{") and ("EpochMs" in value or "epochMs" in value):
        try:
            return epoch_from(json.loads(value))
        except ValueError:
            return None
    return None


def read_anchors(path: pathlib.Path | None) -> list[dict]:
    if path is None:
        return []
    obj = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(obj, dict):
        obj = next((obj[k] for k in ("marks", "phaseMarks", "performanceMarks", "traceMarks", "traceAnchors") if isinstance(obj.get(k), list)), [])
    return [item for item in obj if isinstance(item, dict) and item.get("name") and epoch_from(item) is not None]


def thread_usage(events: list[dict], pid: int, tid: int, start_us: float | None = None, end_us: float | None = None) -> dict:
    wall, thread, count, partial = [], [], 0, 0
    for e in events:
        if e.get("pid") != pid or e.get("tid") != tid or e.get("ph") != "X":
            continue
        if not finite(e.get("ts")) or not finite(e.get("dur")) or e["dur"] < 0:
            continue
        lo, hi = e["ts"], e["ts"] + e["dur"]
        if start_us is not None and end_us is not None:
            if hi <= start_us or lo >= end_us:
                continue
            if lo < start_us or hi > end_us:
                partial += 1
                continue  # CPU can't be prorated from wall overlap.
        count += 1
        wall.append((lo, hi))
        if finite(e.get("tts")) and finite(e.get("tdur")) and e["tdur"] >= 0:
            thread.append((e["tts"], e["tts"] + e["tdur"]))
    return {
        "pid": pid, "tid": tid, "completeXEventCount": count,
        "threadClockEventCount": len(thread), "boundaryCrossingEventsExcluded": partial,
        "coveredThreadCpuMs": union_length(thread) / 1000 if thread else None,
        "coveredSchedulingWallMs": union_length(wall) / 1000 if wall else None,
        "cpuScope": "union of trace tts/tdur intervals from complete X events on this thread; covered lower bound, excludes uncaptured work",
        "wallScope": "union of complete event ts/dur intervals; contains waiting/descheduling and is not CPU time",
        "nesting": "thread-time and wall-time unions avoid double-counting nested events",
        "cpuPercent": None,
    }


def analyze(trace_path: pathlib.Path, *, mode="unspecified", renderer_pid=None, anchors_path=None, trial=None) -> dict:
    raw = trace_path.read_bytes()
    data = json.loads(raw)
    events = data.get("traceEvents", []) if isinstance(data, dict) else data
    if not isinstance(events, list):
        raise ValueError("traceEvents must be an array")
    names = collections.Counter(e.get("name", "") for e in events)
    categories = collections.Counter(e.get("cat", "") for e in events)
    threads = {(e.get("pid"), e.get("tid")): e.get("args", {}).get("name")
               for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
    renderer_threads = [{"pid": pid, "tid": tid, "name": name}
                        for (pid, tid), name in threads.items() if name and "RendererMain" in name]
    marks = [e for e in events if str(e.get("name", "")).startswith("wm-") and "user_timing" in e.get("cat", "")]
    marker_pids = sorted({e.get("pid") for e in marks})
    binding = "explicit-renderer-pid" if renderer_pid is not None else None
    if renderer_pid is None and len(marker_pids) == 1:
        renderer_pid, binding = marker_pids[0], "wm-user-timing-mark-renderer"
    elif renderer_pid is None:
        binding = "unavailable-no-unique-target-renderer-mark"
    selected_marks = sorted([e for e in marks if renderer_pid is None or e.get("pid") == renderer_pid], key=lambda e: e.get("ts", 0))
    marker_summary = [{"name": e["name"], "pid": e.get("pid"), "tid": e.get("tid"), "traceTsUs": e.get("ts")}
                      for e in selected_marks]

    external_anchors = read_anchors(anchors_path) + ((trial or {}).get("phaseMarks") or [])
    by_name = collections.defaultdict(list)
    for anchor in external_anchors:
        by_name[anchor["name"]].append(anchor)
    anchor_matches, offsets = [], []
    for mark in selected_marks:
        epoch_ms = epoch_from(mark.get("args", {}))
        if epoch_ms is None and by_name[mark["name"]]:
            epoch_ms = epoch_from(by_name[mark["name"]].pop(0))
        if epoch_ms is not None and finite(mark.get("ts")):
            offset = epoch_ms - mark["ts"] / 1000
            offsets.append(offset)
            anchor_matches.append({"name": mark["name"], "traceTsUs": mark["ts"], "browserEpochMs": epoch_ms, "offsetMs": offset})
    offset = statistics.median(offsets) if offsets else None
    residual = max((abs(o - offset) for o in offsets), default=None)
    alignment = {
        "status": "measured-anchor-map" if offset is not None else "unavailable",
        "traceClock": "trace ts in monotonic microseconds; not epoch milliseconds",
        "mapping": "browserEpochMs = traceTsUs/1000 + anchorOffsetMs",
        "anchorOffsetMs": offset, "anchorCount": len(anchor_matches),
        "maxAnchorOffsetResidualMs": residual, "anchors": anchor_matches,
        "unavailableReason": None if offsets else "no paired wm trace marker and browser epoch anchor",
        "systemClockWasNotUsed": True,
    }

    reporter_pairs, reporter_pairing = pairs(events, {"PipelineReporter", "Chrome_FrameReporter"})
    viz_pairs, viz_pairing = pairs(events, {"SwapEndToPresentationCompositorFrame", "SubmitCompositorFrameToPresentationCompositorFrame"})
    viz_end = {(p["pid"], p["token"], p["end"]["ts"]): p["end"]["ts"] for p in viz_pairs}
    per_pid = collections.defaultdict(list)
    for p in reporter_pairs:
        args = p["begin"].get("args", {}).get("frame_reporter", {})
        state = args.get("state", "missing")
        per_pid[p["pid"]].append({
            "state": state, "startUs": p["begin"]["ts"], "endUs": p["end"]["ts"],
            "displayId": args.get("display_trace_id"), "frameSequence": args.get("frame_sequence"),
            "layerTreeHostId": args.get("layer_tree_host_id"), "frameSource": args.get("frame_source"),
            "presentStageEndUs": viz_end.get((p["pid"], p["token"], p["end"]["ts"])),
            "latencyMs": p["durationMs"],
        })
    reporter_summaries = []
    for pid, rows in sorted(per_pid.items()):
        presented = [r for r in rows if r["state"] in PRESENTED_STATES and r["presentStageEndUs"] is not None]
        presented_ts = [r["presentStageEndUs"] for r in presented]
        reporter_summaries.append({
            "pid": pid, "pairedReporters": len(rows), "states": dict(collections.Counter(r["state"] for r in rows)),
            "presentationStageValidatedReporters": len(presented),
            "distinctDisplayTraceIds": len({r["displayId"] for r in presented if r["displayId"] is not None}),
            "duplicatesAtSamePresentationTimestamp": len(presented_ts) - len(set(presented_ts)),
            "presentationFeedback": cadence(presented_ts, "renderer compositor PipelineReporter PRESENTED_ALL/PARTIAL plus paired presentation stage endpoints; not physical scanout"),
            "presentedReporterLatencyMs": stats([r["latencyMs"] for r in presented]),
        })
    presentation = None
    if renderer_pid is not None:
        rows = per_pid.get(renderer_pid, [])
        presented_ts = [r["presentStageEndUs"] for r in rows
                        if r["state"] in PRESENTED_STATES and r["presentStageEndUs"] is not None]
        if len(set(presented_ts)) >= 2:
            presentation = {
                **cadence(presented_ts, "bound target renderer browser-reported compositor presentation feedback"),
                "rendererPid": renderer_pid, "rendererBinding": binding, "browserMode": mode,
                "headlessInterpretation": "virtual/synthetic browser display feedback; no physical monitor claim" if mode == "headless" else None,
                "timestampDeduplication": "all/partial reporters sharing an identical presentation timestamp count once",
                "qualityLimit": "PARTIAL means compositor presented partial updated content; no proof every map business revision was shown",
            }
    display_events = [e for e in events if e.get("name") == "Display::FrameDisplayed" and finite(e.get("ts"))]
    display_feedback = {
        **cadence([e["ts"] for e in display_events], "display/GPU-process feedback for captured browser; event args do not bind it to this map"),
        "processCounts": dict(collections.Counter(e.get("pid") for e in display_events)),
        "cannotReplacePageBoundPresentationCadence": True,
    }
    submit_events = [e for e in events if e.get("name") == "EndActivateToSubmitCompositorFrame" and e.get("ph") == "e"
                     and (renderer_pid is None or e.get("pid") == renderer_pid) and finite(e.get("ts"))]
    submission = cadence([e["ts"] for e in submit_events], "compositor frame submission endpoint; not display or physical presentation")
    main_cpu = [thread_usage(events, t["pid"], t["tid"]) for t in renderer_threads
                if renderer_pid is None or t["pid"] == renderer_pid]
    windows = []
    for a, b in zip(selected_marks, selected_marks[1:]):
        if a.get("pid") != b.get("pid") or b.get("ts", 0) <= a.get("ts", 0):
            continue
        lo, hi = a["ts"], b["ts"]
        rows = per_pid.get(a.get("pid"), [])
        presented_ts = [r["presentStageEndUs"] for r in rows if r["state"] in PRESENTED_STATES
                        and r["presentStageEndUs"] is not None and lo <= r["presentStageEndUs"] < hi]
        windows.append({
            "startMarker": a["name"], "endMarker": b["name"], "startTraceTsUs": lo, "endTraceTsUs": hi,
            "durationMs": (hi - lo) / 1000,
            "startBrowserEpochMs": lo / 1000 + offset if offset is not None else None,
            "endBrowserEpochMs": hi / 1000 + offset if offset is not None else None,
            "presentationFeedback": cadence(presented_ts, "presentation feedback endpoints within adjacent wm-marker interval"),
            "rendererMainThread": [thread_usage(events, t["pid"], t["tid"], lo, hi) for t in renderer_threads if t["pid"] == a.get("pid")],
            "markerWindowScope": "adjacent marks; caller must interpret start/end marker names, no inferred scenario completion",
        })
    target_rows = per_pid.get(renderer_pid, []) if renderer_pid is not None else []
    point_groups = collections.defaultdict(list)
    for row in target_rows:
        if row["state"] in PRESENTED_STATES and row["presentStageEndUs"] is not None:
            point_groups[row["presentStageEndUs"]].append(row)
    presentation_points = [{
        "traceTsUs": ts, "browserEpochMs": ts / 1000 + offset if offset is not None else None,
        "reporterCount": len(rows), "stateCounts": dict(collections.Counter(r["state"] for r in rows)),
        "hasPresentedAll": any(r["state"] == "STATE_PRESENTED_ALL" for r in rows),
        "displayTraceIds": sorted({r["displayId"] for r in rows if r["displayId"] is not None}),
    } for ts, rows in sorted(point_groups.items())]
    profile_windows = []
    alignment_valid = offset is not None and len(anchor_matches) >= 2 and residual is not None and residual <= 2
    for window in ((trial or {}).get("profile") or {}).get("windows", []):
        begin_epoch, end_epoch = window.get("startEpochMs"), window.get("endEpochMs")
        if not finite(begin_epoch) or not finite(end_epoch) or end_epoch <= begin_epoch:
            continue
        name = window.get("name", "unnamed")
        score_eligible = "quality" not in name and "preflight" not in name
        lo = (begin_epoch - offset) * 1000 if alignment_valid else None
        hi = (end_epoch - offset) * 1000 if alignment_valid else None
        points = [point for point in presentation_points if lo <= point["traceTsUs"] < hi] if lo is not None else []
        feedback = cadence([point["traceTsUs"] for point in points],
                           "browser-reported target renderer presentation feedback within exact profiler window")
        feedback["browserFeedbackCadenceHz"] = feedback.pop("browserObservedCallbacksPerSecond")
        feedback["scoringEligible"] = score_eligible and alignment_valid
        profile_windows.append({
            "name": name, "windowId": window.get("windowId"), "startEpochMs": begin_epoch, "endEpochMs": end_epoch,
            "durationMs": end_epoch - begin_epoch, "startTraceTsUs": lo, "endTraceTsUs": hi,
            "clockAlignmentValid": alignment_valid, "scoringEligible": score_eligible,
            "presentationFeedback": feedback, "presentationPoints": points,
            "rendererMainThread": [thread_usage(events, t["pid"], t["tid"], lo, hi) for t in renderer_threads
                                   if t["pid"] == renderer_pid] if lo is not None else [],
            "unavailableReason": None if alignment_valid else "requires at least two matching browser epoch anchors; maximum residual <=2ms",
            "physicalPresentationFps": None,
        })
    if presentation is not None:
        presentation["browserObservedCallbacksPerSecond"] = None
        presentation["scoringEligible"] = False
        presentation["wholeTraceCadenceUnavailableReason"] = "whole trace contains preparation/idle/quality; score only exact profileWindows"
    for item in reporter_summaries:
        item["presentationFeedback"]["browserObservedCallbacksPerSecond"] = None
        item["presentationFeedback"]["scoringEligible"] = False
    display_feedback["browserObservedCallbacksPerSecond"] = None
    submission["browserObservedCallbacksPerSecond"] = None
    return {
        "schema": "geo-pulse/whole-map-trace-analysis-1.0", "tracePath": str(trace_path.resolve()),
        "traceSHA256": hashlib.sha256(raw).hexdigest(), "traceBytes": len(raw), "eventCount": len(events), "browserMode": mode,
        "analyzerSHA256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        "nameCounts": {name: count for name, count in names.items() if any(term.lower() in name.lower() for term in RELEVANT_TERMS)},
        "topCategories": [{"category": name, "events": count} for name, count in categories.most_common(16)],
        "rendererThreads": renderer_threads, "targetRendererPid": renderer_pid, "rendererBinding": binding,
        "wmMarkers": marker_summary, "clockAlignment": alignment,
        "reporterPairing": reporter_pairing, "presentationStagePairing": viz_pairing,
        "reportersByProcess": reporter_summaries, "presentationCadence": presentation,
        "presentationCadenceUnavailableReason": None if presentation else "no uniquely bound renderer with at least two state-and-stage-validated presentation timestamps",
        "displayFeedbackCadence": display_feedback, "compositorSubmissionCadence": submission,
        "rendererMainSchedulingAndCpu": main_cpu, "markerWindows": windows,
        "presentationPoints": presentation_points, "profileWindows": profile_windows,
        "phaseWindowAlignmentValid": alignment_valid,
        "physicalPresentationFps": None, "physicalPresentationLatencyMs": None,
        "physicalUnavailableReason": "CDP browser feedback does not certify physical display scanout; headless feedback is virtual",
        "recommendedPresentationCategories": RECOMMENDED_CATEGORIES,
        "optionalCpuCategories": ["toplevel", "devtools.timeline"],
        "removeForMinimalPresentationTrace": ["cc", "gpu", "viz", "disabled-by-default-cc.debug"],
        "limitations": [
            "No rAF/draw/begin-frame event is promoted to presentation.",
            "Reporter timings are browser compositor feedback, not native WebGL GPU query time.",
            "STATE_PRESENTED_PARTIAL is kept and reported, not silently removed.",
            "Complete trace X events with tts/tdur provide covered thread CPU; uncaptured work and phase boundary-crossing events remain unmeasured.",
            "Main thread CPU excludes browser compositor, GPU and Worker thread CPU; CPU percentages are not inferred.",
            "Trace instrumentation overhead is part of this diagnostic pass; compare performance using the separately identified profiler pass.",
            "Marker-to-epoch mapping requires matching anchors; trace ts is never assumed equal to browser performance epoch.",
        ],
        "interpretationSource": "https://github.com/chromium/chromium/blob/main/cc/metrics/compositor_frame_reporter.cc",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--mode", choices=["headed", "headless", "unspecified"], default="unspecified")
    parser.add_argument("--renderer-pid", type=int)
    parser.add_argument("--markers-json", type=pathlib.Path, help="Optional wm mark names with browserEpochMs/epochMs anchors")
    parser.add_argument("--trial-json", type=pathlib.Path, help="Raw trial JSON providing profile.windows and phaseMarks")
    args = parser.parse_args()
    if args.out.resolve() == args.trace.resolve():
        raise ValueError("Output cannot overwrite source trace")
    trial = json.loads(args.trial_json.read_text(encoding="utf-8-sig")) if args.trial_json else None
    result = analyze(args.trace, mode=args.mode, renderer_pid=args.renderer_pid, anchors_path=args.markers_json, trial=trial)
    with args.out.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"out": str(args.out.resolve()), "events": result["eventCount"],
                      "targetRendererPid": result["targetRendererPid"],
                      "presentationCadenceMeasured": result["presentationCadence"] is not None,
                      "physicalPresentationFps": None}, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""The iPhone benchmarks' numbers (docs/perf/2026-10-31-iphone-benchmarks.md).

  bench-summary.py summarize <folder>         reads what Scripts/bench.sh left there, writes summary.json and summary.md
  bench-summary.py compare <before> <after>   prints a Markdown table of both folders' summaries, and before over after

Every number is the median over the benchmark's iterations: five launches or journeys, or the rounds PhoneBenchTests
times each core step. Lower is better for all of them but journey.completed, which counts only journeys that finished.
"""
import json
import re
import statistics
import sys
from pathlib import Path

MEASURED = re.compile(r"Test Case '-\[\S+ (\w+)\]' measured \[(.+?), (\S+?)\] average: ([-\d.]+), relative standard deviation: ([\d.]+)%, values: \[([^\]]*)\]")
CORE = re.compile(r"IOS-CORE (\S+) ([-\d.]+) (\S+)")
TESTS = {"testLaunchToThreadList": "launch"}
# What a view or a step does once per streamed word, read from the stream phase's counts.
PER_CHUNK = ["body.RootView", "body.MainTabs", "body.ThreadsView", "body.ThreadListSections", "body.ThreadListRow", "body.ThreadRowList",
             "body.ThreadRow", "body.ThreadView", "body.Conversation", "body.ThreadHero", "body.MessageView", "body.MarkdownText",
             "body.MarkdownBlockView", "body.FoldedRun", "body.StepLine", "body.WorkingLine", "body.ReplyDock", "body.FollowupStack",
             "textview.make", "textview.update", "textview.set", "markdown.blocks", "markdown.bytes", "time.timeline.rows.n"]
# What opening the long thread made and read once.
ON_OPEN = ["body.MessageView", "body.MarkdownBlockView", "body.FoldedRun", "body.StepLine", "textview.make", "markdown.blocks", "markdown.bytes"]
PHASES = ["launch", "list-scroll", "open", "thread-scroll", "stream"]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def app_metrics(folder):
    """The app's own reports: launch-<n>.json from XCTest's launches, journey-<n>.json from the app-driven journeys."""
    reports = {"launch": [], "journey": []}
    for path in sorted((folder / "app").glob("*.json")):
        match = re.match(r"(launch|journey)-(\d+)\.json$", path.name)
        if not match:
            continue
        try:
            reports[match.group(1)].append(json.loads(path.read_text()))
        except json.JSONDecodeError:
            continue
    rows = {}

    def put(name, values, unit):
        values = [v for v in values if v is not None]
        if values:
            rows[name] = {"value": median(values), "unit": unit, "n": len(values)}

    journeys = [r for r in reports["journey"] if r.get("phase") == "finished"]
    rows["journey.completed"] = {"value": len(journeys), "unit": "runs", "n": len(reports["journey"])}
    marks = [r.get("marks", {}) for r in journeys]
    phases = {name: [r.get("phases", {}).get(name) or {} for r in journeys] for name in PHASES}
    counts = {name: [p.get("counts", {}) for p in phases[name]] for name in PHASES}

    # Launch: the first frame with every thread, from the process's start, in XCTest's launches and the journeys.
    put("launch.app.first_list", [r.get("marks", {}).get("first-list") for r in reports["launch"] + journeys], "ms")
    put("launch.bytes.shell_full", [c.get("bytes.shell-full") for c in counts["launch"]], "B")
    put("launch.decode.shell_full", [ns_ms(c, "time.decode.shell-full.ns") for c in counts["launch"]], "ms")
    put("launch.apply.shell_full", [ns_ms(c, "time.apply.shell-full.ns") for c in counts["launch"]], "ms")
    put("launch.list_rebuild", [ns_ms(c, "time.list.focusThreads.ns") for c in counts["launch"]], "ms")

    for name in PHASES:
        put(f"{name}.app.footprint", [p.get("footprintMB") for p in phases[name]], "MB")
        if name == "launch":
            continue
        frames = [p.get("frames") or {} for p in phases[name]]
        put(f"{name}.app.cpu", [p.get("cpuMs") for p in phases[name]], "ms")
        put(f"{name}.app.hitch_time_ratio", [f.get("hitchMsPerSecond") for f in frames], "ms/s")
        put(f"{name}.app.hitches", [f.get("hitches") for f in frames], "count")
        put(f"{name}.app.longest_frame", [f.get("longestFrameMs") for f in frames], "ms")
    put("journey.app.peak_footprint", [r.get("peakFootprintMB") for r in journeys], "MB")
    for name in ["list-scroll", "thread-scroll"]:
        put(f"{name}.app.points", [p.get("scrolledPoints") for p in phases[name]], "pt")

    put("open.app.tap_to_drawn", [m["open-rendered"] - m["open-begin"] for m in marks if "open-rendered" in m and "open-begin" in m], "ms")
    for key in ON_OPEN:
        put(f"open.app.{key}", [c.get(key) for c in counts["open"]], "count")
    put("open.app.timeline_rows", [ns_ms(c, "time.timeline.rows.ns") for c in counts["open"]], "ms")
    put("open.decode.detail", [ns_ms(c, "time.decode.detail.ns") for c in counts["open"]], "ms")
    put("open.bytes.detail", [c.get("bytes.detail") for c in counts["open"]], "B")

    chunks = journeys[0].get("chunks", 200) if journeys else 200
    stream = phases["stream"]
    put("stream.wall_per_chunk", [p["wallMs"] / chunks for p in stream if "wallMs" in p], "ms")
    put("stream.cpu_per_chunk", [p["cpuMs"] / chunks for p in stream if "cpuMs" in p], "ms")
    for key in PER_CHUNK:
        put(f"stream.per_chunk.{key}", [c.get(key, 0) / chunks for c in counts["stream"]], "count")
    for kind in ["delta", "shell"]:
        put(f"stream.bytes_per_push.{kind}", [c[f"bytes.{kind}"] / c[f"frames.{kind}"] if c.get(f"frames.{kind}") else None for c in counts["stream"]], "B")
        put(f"stream.decode_per_push.{kind}", [ns_ms(c, f"time.decode.{kind}.ns", f"time.decode.{kind}.n") for c in counts["stream"]], "ms")
        put(f"stream.apply_per_push.{kind}", [ns_ms(c, f"time.apply.{kind}.ns", f"time.apply.{kind}.n") for c in counts["stream"]], "ms")
    put("stream.timeline_rows_per_chunk", [ns_ms(c, "time.timeline.rows.ns") / chunks if "time.timeline.rows.ns" in c else 0 for c in counts["stream"]], "ms")
    return rows


def ns_ms(counts, total, n=None):
    if total not in counts:
        return None
    value = counts[total] / 1_000_000
    if n:
        return value / max(1, counts.get(n, 1))
    return value


def summarize(folder):
    folder = Path(folder)
    metrics = {}
    log = folder / "test.log"
    if log.exists():
        for test, metric, unit, average, rsd, values in MEASURED.findall(log.read_text(errors="replace")):
            numbers = [float(v) for v in values.split(",") if v.strip()]
            metrics[f"{TESTS.get(test, test)}.xctest.{slug(metric)}"] = {"value": statistics.median(numbers) if numbers else float(average),
                                                                      "unit": unit, "rsd": float(rsd), "n": len(numbers)}
    metrics.update(app_metrics(folder))
    core = folder / "core.log"
    if core.exists():
        for name, value, unit in CORE.findall(core.read_text(errors="replace")):
            metrics[f"core.{name}"] = {"value": float(value), "unit": unit}
    source = (folder / "source.txt").read_text().strip() if (folder / "source.txt").exists() else ""
    (folder / "summary.json").write_text(json.dumps({"source": source, "metrics": metrics}, indent=2, sort_keys=True))
    lines = [f"Source: {source}", "", "| Metric | Median | Unit |", "| --- | ---: | --- |"]
    for name in sorted(metrics):
        lines.append(f"| {name} | {fmt(metrics[name]['value'])} | {metrics[name]['unit']} |")
    (folder / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


def fmt(value):
    if value is None:
        return "–"
    if abs(value) >= 100:
        return f"{value:,.0f}"
    if abs(value) >= 1:
        return f"{value:.2f}"
    return f"{value:.4f}"


def compare(before, after):
    old = json.loads((Path(before) / "summary.json").read_text())
    new = json.loads((Path(after) / "summary.json").read_text())
    print(f"Before: {old.get('source', '')}  \nAfter: {new.get('source', '')}\n")
    print("| Metric | Before | After | Unit | Before ÷ after |")
    print("| --- | ---: | ---: | --- | ---: |")
    for name in sorted(set(old["metrics"]) | set(new["metrics"])):
        a = old["metrics"].get(name, {}).get("value")
        b = new["metrics"].get(name, {}).get("value")
        unit = (new["metrics"].get(name) or old["metrics"].get(name))["unit"]
        ratio = f"{a / b:.2f}x" if a is not None and b not in (None, 0) else "–"
        print(f"| {name} | {fmt(a)} | {fmt(b)} | {unit} | {ratio} |")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "summarize":
        summarize(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "compare":
        compare(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)

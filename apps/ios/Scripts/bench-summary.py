#!/usr/bin/env python3
"""The iPhone benchmarks' numbers (docs/perf/2026-10-31-iphone-benchmarks.md).

  bench-summary.py summarize <folder>         reads what Scripts/bench.sh left there, writes summary.json and summary.md
  bench-summary.py compare <before> <after>   prints a Markdown table of both folders' summaries, and before over after
  bench-summary.py budget <folder>            fails when a work count in the folder's summary is over its budget
  bench-summary.py look <before> <after>      fails when the long thread's photos differ from the base's (bench.sh's look)

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
             "textview.make", "textview.update", "textview.set", "time.textview.measure.n",
             "markdown.blocks", "markdown.bytes", "time.timeline.rows.n"]
# What opening the long thread made and read once.
ON_OPEN = ["body.MessageView", "body.MarkdownBlockView", "body.FoldedRun", "body.StepLine", "textview.make", "time.textview.measure.n",
           "markdown.blocks", "markdown.bytes"]
PHASES = ["launch", "list-scroll", "open", "thread-scroll", "stream"]
# Work counts the climb has brought down, held there (#1702). Counts do not vary with the runner as times do, so each
# budget sits a little above what the change that set it measured. A budget only tightens; a raise needs its reason in
# the pull request.
BUDGETS = {
    # Earlier turns are made as they scroll into view (22 text views, 44 message bodies, 28 measures on open).
    "open.app.textview.make": 40,
    "open.app.body.MessageView": 60,
    "open.app.time.textview.measure.n": 60,
    # Each paragraph is measured once for its words, text size and width (0.36 a streamed word).
    "stream.per_chunk.time.textview.measure.n": 1.0,
}


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
    for name in ["open", "thread-scroll"]:
        put(f"{name}.app.textview_measure", [ns_ms(c, "time.textview.measure.ns") for c in counts[name]], "ms")
    put("stream.textview_measure_per_chunk", [ns_ms(c, "time.textview.measure.ns") / chunks if "time.textview.measure.ns" in c else 0 for c in counts["stream"]], "ms")
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


def budget(folder):
    metrics = json.loads((Path(folder) / "summary.json").read_text())["metrics"]
    over = []
    for name, limit in BUDGETS.items():
        value = metrics.get(name, {}).get("value")
        if value is None:
            over.append(f"{name}: not measured (budget {fmt(limit)})")
        elif value > limit:
            over.append(f"{name}: {fmt(value)}, over its budget of {fmt(limit)}")
        else:
            print(f"{name}: {fmt(value)} (budget {fmt(limit)})")
    if over:
        print("\n".join(over))
        sys.exit(1)


def look(before, after):
    """Each distance's photo from two launches of each build. A distance whose two base photos differ is not compared,
    as something there changes from launch to launch; otherwise the change's photos must be the base's, byte for byte."""
    old, new = Path(before) / "look", Path(after) / "look"
    distances = sorted({p.name.split("-")[2] for p in old.glob("look-1-*.png")}, key=lambda d: int(d.split(".")[0]))
    if not distances:
        print("The base took no photos of the long thread, so the look was not compared.")
        return
    print("| Distance above the end | The base's two launches | The change's two launches | The change against the base |")
    print("| ---: | --- | --- | --- |")
    differs = []
    for name in distances:
        a1, a2, b1, b2 = (folder / f"look-{run}-{name}" for folder in (old, new) for run in (1, 2))
        if not all(p.exists() for p in (a1, a2, b1, b2)):
            differs.append(name)
            print(f"| {name[:-4]} pt | {'–' if not a1.exists() or not a2.exists() else 'taken'} | missing | not compared |")
            continue
        base_same, change_same = a1.read_bytes() == a2.read_bytes(), b1.read_bytes() == b2.read_bytes()
        if not base_same:
            verdict = "not compared: the base differs between launches"
        elif b1.read_bytes() == a1.read_bytes() or b2.read_bytes() == a1.read_bytes():
            verdict = "the same"
        else:
            verdict = "different"
            differs.append(name)
        print(f"| {name[:-4]} pt | {'the same' if base_same else 'different'} | {'the same' if change_same else 'different'} | {verdict} |")
    if differs:
        print(f"\nThe change looks different from the base at {', '.join(d[:-4] + ' pt' for d in differs)}: the photos are in the artifact.")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "summarize":
        summarize(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "compare":
        compare(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == "budget":
        budget(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "look":
        look(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)

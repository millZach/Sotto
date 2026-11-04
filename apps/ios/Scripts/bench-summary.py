#!/usr/bin/env python3
"""The iPhone benchmarks' numbers (docs/perf/2026-10-31-iphone-benchmarks.md).

  bench-summary.py summarize <folder>         reads what Scripts/bench.sh left there, writes summary.json and summary.md
  bench-summary.py compare <before> <after>   prints a Markdown table of both folders' summaries, and before over after
  bench-summary.py budget <folder>            fails when a work count in the folder's summary is over its budget
  bench-summary.py look <before> <after>      fails when the long thread's photos differ from the base's (bench.sh's look)
  bench-summary.py place <folder>             fails when the Threads list loses its place (bench.sh's place)

Every number is the median over the benchmark's iterations: five launches or journeys, or the rounds PhoneBenchTests
times each core step. Lower is better for all of them but journey.completed, which counts only journeys that finished.
"""
import json
import re
import statistics
import struct
import sys
import zlib
from pathlib import Path

MEASURED = re.compile(r"Test Case '-\[\S+ (\w+)\]' measured \[(.+?), (\S+?)\] average: ([-\d.]+), relative standard deviation: ([\d.]+)%, values: \[([^\]]*)\]")
CORE = re.compile(r"IOS-CORE (\S+) ([-\d.]+) (\S+)")
TESTS = {"testLaunchToThreadList": "launch"}
# What a view or a step does once per streamed word, read from the stream phase's counts.
PER_CHUNK = ["body.RootView", "body.MainTabs", "body.ThreadsView", "body.ThreadListSections", "body.ThreadListRow", "body.ThreadRowList",
             "body.ThreadRow", "body.ThreadView", "body.Conversation", "body.ThreadHero", "body.MessageView", "body.MarkdownText",
             "body.MarkdownBlockView", "body.FoldedRun", "body.StepLine", "body.WorkingLine", "body.ReplyDock", "body.FollowupStack",
             "textview.make", "textview.update", "textview.set", "time.textview.measure.n",
             "markdown.blocks", "markdown.bytes", "time.timeline.rows.n",
             "body.EnvironmentUnderList", "body.EnvironmentUnderThread"]
# What opening the long thread made and read once.
ON_OPEN = ["body.MessageView", "body.MarkdownBlockView", "body.FoldedRun", "body.StepLine", "textview.make", "time.textview.measure.n",
           "markdown.blocks", "markdown.bytes"]
PHASES = ["launch", "list-scroll", "open", "thread-scroll", "stream", "reply-box", "reply-box-stream", "back"]
# The Threads page's hold while a thread covers it (`ThreadsView.held`), counted over each whole journey: the page coming
# into sight, holds taken, holds taken while the page could still show, and frames that could have shown an old row.
WORST_PER_CHUNK = ["body.ThreadListSections", "body.ThreadListRow"]
# What scrolling the Threads page runs again: nothing it shows changes, so none of these should run in any journey.
WORST_LIST_SCROLL = ["body.SheetPage", "body.ThreadListSections", "body.ThreadListRow"]
PAGE = ["page.shown", "page.holds", "page.held_in_window", "page.stale_frames"]
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
    # The small reply box lives inside the dock: going small and back draws no part of the conversation (ADR-0184).
    "reply-box.app.body.Conversation": 0,
    "reply-box.app.body.MessageView": 0,
    "reply-box.app.textview.update": 0,
    # The Threads page holds its list while the long thread covers it (0.27 list bodies a streamed word before).
    "stream.worst_per_chunk.body.ThreadListSections": 0,
    "stream.worst_per_chunk.body.ThreadListRow": 0,
    # The fade under the status bar redraws alone, so scrolling the list runs neither its page nor its rows (#2100). The
    # page ran twice a scroll before, and in about one journey in six that drew the whole list again, a frame of 240 to 590 ms.
    "list-scroll.worst.body.SheetPage": 0,
    "list-scroll.worst.body.ThreadListSections": 0,
    # Its rows are made as they scroll in, once each (#2120): 12,000 points of rows, and no more than that.
    "list-scroll.worst.body.ThreadListRow": 450,
    # The launch makes the rows on screen and not all 300 (#2120): about 18, one hidden row a section to measure, and room for
    # one drawing again in the launch, which #2120 did not stop.
    "launch.worst.body.ThreadListRow": 60,
    # The Threads page lets go of its held list before the first frame that shows it again, in every journey.
    "journey.page.stale_frames": 0,
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

    # Twenty moves of the reply box, alone and over a stream, with what they drew.
    for key in ["body.Conversation", "body.MessageView", "body.ReplyDock", "textview.update"]:
        put(f"reply-box.app.{key}", [c.get(key, 0) if c else None for c in counts["reply-box"]], "count")
    put("reply-box.app.moves", [p.get("replyBoxMoves") for p in phases["reply-box"]], "count")
    put("reply-box-stream.app.moves", [p.get("replyBoxMoves") for p in phases["reply-box-stream"]], "count")

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
    # The same 200 words over the moves, to set against `stream`: moving the box adds no drawing per word and no time.
    box_stream = phases["reply-box-stream"]
    put("reply-box-stream.wall_per_chunk", [p["wallMs"] / chunks for p in box_stream if "wallMs" in p], "ms")
    put("reply-box-stream.cpu_per_chunk", [p["cpuMs"] / chunks for p in box_stream if "cpuMs" in p], "ms")
    for key in PER_CHUNK:
        put(f"reply-box-stream.per_chunk.{key}", [c.get(key, 0) / chunks for c in counts["reply-box-stream"]], "count")
    # The worst journey's, for the counts budgeted at zero, where the median would hide one journey that drew.
    for key in WORST_PER_CHUNK:
        values = [c.get(key, 0) / chunks for c in counts["stream"]]
        if values:
            rows[f"stream.worst_per_chunk.{key}"] = {"value": max(values), "unit": "count", "n": len(values)}
    for key in WORST_LIST_SCROLL:
        values = [c.get(key, 0) for c in counts["list-scroll"]]
        if values:
            rows[f"list-scroll.worst.{key}"] = {"value": max(values), "unit": "count", "n": len(values)}
    values = [c.get("body.ThreadListRow", 0) for c in counts["launch"]]
    if values:
        rows["launch.worst.body.ThreadListRow"] = {"value": max(values), "unit": "count", "n": len(values)}
    for kind in ["delta", "shell"]:
        put(f"stream.bytes_per_push.{kind}", [c[f"bytes.{kind}"] / c[f"frames.{kind}"] if c.get(f"frames.{kind}") else None for c in counts["stream"]], "B")
        put(f"stream.decode_per_push.{kind}", [ns_ms(c, f"time.decode.{kind}.ns", f"time.decode.{kind}.n") for c in counts["stream"]], "ms")
        put(f"stream.apply_per_push.{kind}", [ns_ms(c, f"time.apply.{kind}.ns", f"time.apply.{kind}.n") for c in counts["stream"]], "ms")
    for name in ["open", "thread-scroll"]:
        put(f"{name}.app.textview_measure", [ns_ms(c, "time.textview.measure.ns") for c in counts[name]], "ms")
    put("stream.textview_measure_per_chunk", [ns_ms(c, "time.textview.measure.ns") / chunks if "time.textview.measure.ns" in c else 0 for c in counts["stream"]], "ms")
    put("stream.timeline_rows_per_chunk", [ns_ms(c, "time.timeline.rows.ns") / chunks if "time.timeline.rows.ns" in c else 0 for c in counts["stream"]], "ms")

    # The page's hold, in the journeys whose page came back into sight in their back phase; the worst journey, since one
    # old row is one too many.
    went_back = [i for i, p in enumerate(phases["back"]) if p and counts["back"][i].get("page.shown", 0)]
    if went_back:
        for key in PAGE:
            values = [sum(counts[name][i].get(key, 0) for name in PHASES) for i in went_back]
            rows[f"journey.{key}"] = {"value": max(values), "unit": "count", "n": len(values)}
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
    as something there changes from launch to launch; otherwise both of the change's photos must be the base's, byte for
    byte."""
    old, new = Path(before) / "look", Path(after) / "look"
    distances = sorted({p.name.split("-")[2] for p in old.glob("look-1-*.png")}, key=lambda d: int(d.split(".")[0]))
    if not distances:
        print("The base took no photos of the long thread, so the look was not compared.")
        return
    print("| Distance above the end | The base's two launches | The change's two launches | The change against the base |")
    print("| ---: | --- | --- | --- |")
    differs = []
    for name in distances:
        base1, base2, change1, change2 = (folder / f"look-{run}-{name}" for folder in (old, new) for run in (1, 2))
        if not all(p.exists() for p in (base1, base2, change1, change2)):
            differs.append(name)
            print(f"| {name[:-4]} pt | {'–' if not base1.exists() or not base2.exists() else 'taken'} | missing | not compared |")
            continue
        base_same, change_same = base1.read_bytes() == base2.read_bytes(), change1.read_bytes() == change2.read_bytes()
        if not base_same:
            verdict = "not compared: the base differs between launches"
        elif change1.read_bytes() == base1.read_bytes() and change2.read_bytes() == base1.read_bytes():
            verdict = "the same"
        else:
            verdict = "different"
            differs.append(name)
        print(f"| {name[:-4]} pt | {'the same' if base_same else 'different'} | {'the same' if change_same else 'different'} | {verdict} |")
    if differs:
        print(f"\nThe change looks different from the base at {', '.join(d[:-4] + ' pt' for d in differs)}: the photos are in the artifact.")
        sys.exit(1)


def png_rows(path):
    """An 8-bit photo's pixel rows, and its bytes a pixel."""
    data = path.read_bytes()
    at, compressed, width, height, channels = 8, [], 0, 0, 0
    while at < len(data):
        size, kind = struct.unpack(">I4s", data[at:at + 8])
        body = data[at + 8:at + 8 + size]
        at += 12 + size
        if kind == b"IHDR":
            width, height, depth, colour = struct.unpack(">IIBB", body[:10])
            channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour] * (depth // 8)
        elif kind == b"IDAT":
            compressed.append(body)
    raw, stride, rows, above, at = zlib.decompress(b"".join(compressed)), width * channels, [], bytearray(width * channels), 0
    for _ in range(height):
        kind, row = raw[at], bytearray(raw[at + 1:at + 1 + stride])
        at += 1 + stride
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            up, corner = above[x], above[x - channels] if x >= channels else 0
            if kind == 1:
                row[x] = (row[x] + left) & 255
            elif kind == 2:
                row[x] = (row[x] + up) & 255
            elif kind == 3:
                row[x] = (row[x] + ((left + up) >> 1)) & 255
            elif kind == 4:
                guess = left + up - corner
                near = min((abs(guess - left), 0, left), (abs(guess - up), 1, up), (abs(guess - corner), 2, corner))
                row[x] = (row[x] + near[2]) & 255
        rows.append(bytes(row))
        above = row
    return rows, channels


def same_words(first, second):
    """Whether two photos at the top of the list show the same rows. It reads between the Working lights and the ages, and
    below the note above the rows, in the journeys' 440-point phone. The ages tick and the lights breathe; the wash behind them
    moves a little from launch to launch, which no letter's edge is near."""
    (one, channels), (other, _) = png_rows(first), png_rows(second)
    for y in range(180, 850):
        a, b = one[y][56 * channels:340 * channels], other[y][56 * channels:340 * channels]
        if a != b and max(abs(p - q) for p, q in zip(a, b)) > 32:
            return False
    return True


def blank_band(path):
    """The tallest run of pixel rows that are one colour across the content's width, between the bar and the tabs."""
    rows, channels = png_rows(path)
    tallest = run = 0
    for row in rows[100:880]:
        sums = [sum(row[x * channels:x * channels + 3]) for x in range(19, 408)]
        run = run + 1 if max(sums) - min(sums) <= 9 else 0
        tallest = max(tallest, run)
    return tallest


def place(folder):
    """The lazy list against the same build's whole list. For each of bench.sh's place journeys: the top is the top, with the
    same rows on it, closing the thread keeps the offset and the photo, the height never moves, every stop away from the top
    looks the same as the whole list's, byte for byte, and no photo during the fast scrolls has a taller gap than the whole
    list's, give or take 12 points."""
    folder = Path(folder) / "place"
    wrong = []
    print("| Rows' fonts | Rows made, lazy | Rows made, whole | Height, lazy | Height, whole | Kept its place |")
    print("| --- | ---: | ---: | ---: | ---: | --- |")
    for fonts in ["figtree", "other"]:
        reports = {arm: json.loads((folder / f"{arm}-{fonts}.json").read_text()) for arm in ["lazy", "whole"]}
        if any(r.get("phase") != "finished" for r in reports.values()):
            wrong.append(f"{fonts}: a journey did not finish")
            continue
        phase = {arm: r["phases"]["place"] for arm, r in reports.items()}
        stops = {arm: {k[5:]: v for k, v in p.items() if k.startswith("stop-")} for arm, p in phase.items()}
        before = len(wrong)
        for arm in ["lazy", "whole"]:
            top = phase[arm]["top"]
            for name in ["start", "top-again", "end-top"]:
                if abs(stops[arm][name]["offset"] - top) > 0.5:
                    wrong.append(f"{fonts}, {arm}: {name} stands at {stops[arm][name]['offset']}, not the top, {top}")
            if stops[arm]["before-open"]["offset"] != stops[arm]["after-close"]["offset"]:
                wrong.append(f"{fonts}, {arm}: closing the thread moved the list")
            if (folder / f"{arm}-{fonts}-before-open.png").read_bytes() != (folder / f"{arm}-{fonts}-after-close.png").read_bytes():
                wrong.append(f"{fonts}, {arm}: rows moved when the thread closed")
            heights = {round(stop["height"], 1) for stop in stops[arm].values()}
            if len(heights) != 1:
                wrong.append(f"{fonts}, {arm}: the height moved, {sorted(heights)}")
        tall = {arm: max(stop["height"] for stop in stops[arm].values()) for arm in stops}
        if abs(tall["lazy"] - tall["whole"]) > 0.5:
            wrong.append(f"{fonts}: the lazy list is {tall['lazy']} tall and the whole list {tall['whole']}")
        for name in ["far", "before-open", "after-close", "up-a-little"]:
            if (folder / f"lazy-{fonts}-{name}.png").read_bytes() != (folder / f"whole-{fonts}-{name}.png").read_bytes():
                wrong.append(f"{fonts}: the lazy list looks different at {name}")
        for name in ["start", "top-again", "end-top"]:
            if not same_words(folder / f"whole-{fonts}-start.png", folder / f"lazy-{fonts}-{name}.png"):
                wrong.append(f"{fonts}: the rows at the top are not the whole list's at {name}")
        gaps = {arm: max([blank_band(p) for p in folder.glob(f"{arm}-{fonts}-moving-*.png")], default=None) for arm in ["lazy", "whole"]}
        print(f"Tallest gap during the scrolls, {fonts}: lazy {gaps['lazy']} pt, whole {gaps['whole']} pt\n")
        if None in gaps.values():
            wrong.append(f"{fonts}: no photos were taken during the scrolls")
        elif gaps["lazy"] > gaps["whole"] + 12:
            wrong.append(f"{fonts}: the lazy list had a gap of {gaps['lazy']} pt during a scroll, the whole list {gaps['whole']} pt")
        made = {arm: phase[arm].get("counts", {}).get("body.ThreadListRow", 0) + reports[arm]["phases"]["launch"].get("counts", {}).get("body.ThreadListRow", 0) for arm in phase}
        print(f"| {fonts} | {fmt(made['lazy'])} | {fmt(made['whole'])} | {fmt(tall['lazy'])} | {fmt(tall['whole'])} | {'yes' if len(wrong) == before else 'no'} |")
    if wrong:
        print("\n" + "\n".join(wrong))
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
    elif len(sys.argv) == 3 and sys.argv[1] == "place":
        place(sys.argv[2])
    else:
        sys.exit(__doc__)

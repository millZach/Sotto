"""Scratch: the open arms' numbers, a line per journey, then medians per arm."""
import json, sys, glob, os, statistics
from collections import defaultdict
ARMS = ["base", "manual", "quiet", "tabs", "warm", "all"]
per = defaultdict(list)
for path in glob.glob(os.path.join(sys.argv[1], "*-*.json")):
    name = os.path.basename(path)[:-5]
    arm, rnd = name.rsplit("-", 1)
    if arm not in ARMS: continue
    try: d = json.load(open(path))
    except Exception: continue
    ph = d.get("phases", {}); m = d.get("marks", {})
    def f(p, *k):
        x = ph.get(p, {})
        for key in k: x = x.get(key, {}) if isinstance(x, dict) else {}
        return None if isinstance(x, dict) else x
    def since(a, b): return round(m[a] - m[b]) if a in m and b in m else None
    per[arm].append({
        "round": int(rnd), "end": d.get("phase"),
        "open": since("rendered-open", "open-begin"), "reopen1": since("rendered-reopen-1", "phase-reopen-1"),
        "reopen2": since("rendered-reopen-2", "phase-reopen-2"),
        "open_long": f("open", "frames", "longestFrameMs"), "open_cpu": f("open", "cpuMs"),
        "open_rows": f("open", "counts", "body.ThreadListRow") or 0, "open_tv": f("open", "counts", "body.ThreadsView") or 0,
        "stream_rows": f("stream", "counts", "body.ThreadListRow") or 0, "stream_tv": f("stream", "counts", "body.ThreadsView") or 0, "stream_tabs": f("stream", "counts", "body.MainTabs") or 0, "stream_root": f("stream", "counts", "body.RootView") or 0, "stream_win": f("stream", "counts", "body.WindowContent") or 0,
        "stream_cpu": f("stream", "cpuMs"),
        "reopen_rows": (f("reopen-1", "counts", "body.ThreadListRow") or 0) + (f("reopen-2", "counts", "body.ThreadListRow") or 0),
        "launch_rows": f("launch", "counts", "body.ThreadListRow"), "launch_long": f("launch", "frames", "longestFrameMs"),
        "launch_cpu": f("launch", "cpuMs"), "first_list": m.get("first-list"),
        "back_long": f("back-1", "frames", "longestFrameMs"),
    })
keys = ["open", "reopen1", "reopen2", "open_long", "open_cpu", "open_rows", "open_tv", "stream_rows", "stream_tv", "stream_tabs", "stream_root", "stream_win", "stream_cpu",
        "reopen_rows", "launch_rows", "launch_long", "launch_cpu", "first_list", "back_long"]
def fmt(v): return "–" if v is None else (f"{v:,.0f}" if isinstance(v, (int, float)) else str(v))
print("| arm | round | end | " + " | ".join(keys) + " |"); print("|" + " --- |" * (len(keys) + 3))
for arm in ARMS:
    for r in sorted(per[arm], key=lambda r: r["round"]):
        print(f"| {arm} | {r['round']} | {r['end']} | " + " | ".join(fmt(r[k]) for k in keys) + " |")
print("\n### Medians (finished journeys), and journeys whose list drew rows during the open or stream\n")
print("| arm | n | " + " | ".join(keys) + " | list drew |"); print("|" + " --- |" * (len(keys) + 3))
for arm in ARMS:
    rows = [r for r in per[arm] if r["end"] == "finished"]
    if not rows: continue
    med = {k: statistics.median([r[k] for r in rows if isinstance(r[k], (int, float))] or [0]) for k in keys}
    drew = sum(1 for r in rows if r["open_rows"] > 50 or r["stream_rows"] > 50)
    print(f"| {arm} | {len(rows)} | " + " | ".join(fmt(med[k]) for k in keys) + f" | {drew} |")
json.dump(per, open(os.path.join(sys.argv[1], "arms.json"), "w"))

"""Scratch: the list variants' scroll, open and back, side by side."""
import json, sys, glob, os
from collections import defaultdict
rows = defaultdict(list)
for path in sorted(glob.glob(os.path.join(sys.argv[1], "*-*.json"))):
    variant, rnd = os.path.basename(path)[:-5].rsplit("-", 1)
    try:
        d = json.load(open(path))
    except Exception as e:
        print(path, "unreadable", e); continue
    ph = d.get("phases", {}); m = d.get("marks", {})
    def g(p, *keys):
        x = ph.get(p, {})
        for k in keys: x = x.get(k, {}) if isinstance(x, dict) else {}
        return x if not isinstance(x, dict) else None
    rows[variant].append({
        "round": rnd, "phase": d.get("phase"),
        "scroll_hitches": g("list-scroll", "frames", "hitches"), "scroll_ms_s": g("list-scroll", "frames", "hitchMsPerSecond"),
        "scroll_longest": g("list-scroll", "frames", "longestFrameMs"), "scroll_cpu": g("list-scroll", "cpuMs"),
        "scroll_rows": g("list-scroll", "counts", "body.ThreadListRow"),
        "scroll2_hitches": g("list-scroll-2", "frames", "hitches"), "scroll2_ms_s": g("list-scroll-2", "frames", "hitchMsPerSecond"),
        "scroll2_cpu": g("list-scroll-2", "cpuMs"),
        "tap_to_drawn": (m["open-rendered"] - m["open-begin"]) if "open-rendered" in m and "open-begin" in m else None,
        "open_cpu": g("open", "cpuMs"), "back_cpu": g("back", "cpuMs"), "back_longest": g("back", "frames", "longestFrameMs"),
        "launch_mb": g("launch", "footprintMB"), "launch_rows": g("launch", "counts", "body.ThreadListRow"),
    })
keys = ["scroll_hitches", "scroll_ms_s", "scroll_longest", "scroll_cpu", "scroll_rows", "scroll2_hitches", "scroll2_ms_s", "scroll2_cpu",
        "tap_to_drawn", "open_cpu", "back_cpu", "back_longest", "launch_mb", "launch_rows"]
print("| variant | round | phase | " + " | ".join(keys) + " |")
print("|" + " --- |" * (len(keys) + 3))
def f(v): return "–" if v is None else (f"{v:,.1f}" if isinstance(v, float) else str(v))
for variant in ["whole", "lazy", "fixed", "chunks", "chunksfixed", "plain"]:
    for r in sorted(rows.get(variant, []), key=lambda r: r["round"]):
        print(f"| {variant} | {r['round']} | {r['phase']} | " + " | ".join(f(r[k]) for k in keys) + " |")
print(json.dumps(rows), file=open(os.path.join(sys.argv[1], "variants.json"), "w"))

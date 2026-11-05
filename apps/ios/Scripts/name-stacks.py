#!/usr/bin/env python3
"""[DEBUG-9e1c] Scratch: names a BenchSampler file's stacks with bench-sample.py's atos naming, on the runner while the
app's images are still there, and writes {phase: [[count, [name, ...]], ...]} plus each address's image, for reading
elsewhere. Usage: name-stacks.py <bench-sample.py> <samples.json> <out.json>"""
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("bench_sample", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
data = json.load(open(sys.argv[2]))
named = mod.names(data.get("addresses", []))
images = [os.path.basename(a.get("image", "")) or "?" for a in data.get("addresses", [])]
out = {"names": named, "images": images, "phases": {p["phase"]: p["stacks"] for p in data.get("phases", [])},
       "samples": {p["phase"]: p["samples"] for p in data.get("phases", [])},
       "longFrames": [{"phase": f["phase"], "ms": f["ms"], "stacks": f["stacks"]} for f in data.get("longFrames", [])]}
json.dump(out, open(sys.argv[3], "w"))

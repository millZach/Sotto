#!/usr/bin/env python3
"""Where the iPhone app's main thread spent each phase of the benchmarks' traced journey (docs/perf/2026-10-31-iphone-benchmarks.md).

  bench-sample.py <samples.json>    prints a Markdown summary for each phase

The samples come from the app's own sampler (`BenchSampler` in Sotto/Bench.swift, `--bench-sample`): each phase's
distinct main-thread stacks with how often each was seen, about once a millisecond, and for every address the image it
lies in, the image's load address and the nearest exported symbol. `atos` names each address from its image's symbols;
an address it cannot name keeps the exported symbol, or its image and offset. Each phase then ranks functions by the
samples they were on the stack for (once per sample, however deep the recursion) and at the top of, and the app's own
functions by the samples they were on the stack for and by the samples they were the innermost app frame of: the app
code whose call the frameworks were working for.
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

TOP_UNDER, TOP_OWN, TOP_IMAGES, TOP_APP = 50, 25, 12, 40
APP_IMAGES = {"Sotto", "Sotto.debug.dylib"}
SHOWN = ["open", "thread-scroll", "stream"]


def names(addresses):
    """One readable name per address."""
    result = []
    by_image = defaultdict(list)
    for index, entry in enumerate(addresses):
        image = entry.get("image", "")
        fallback = re.sub(r" \+ \d+$", "", entry.get("symbol") or "") or f"{os.path.basename(image) or '?'}+0x{int(entry['address'], 16) - int(entry.get('base', '0'), 16):x}"
        result.append(f"{fallback} ({os.path.basename(image)})" if image else fallback)
        if image and os.path.isfile(image) and "base" in entry:
            by_image[(image, entry["base"])].append(index)
    for (image, base), indices in by_image.items():
        for start in range(0, len(indices), 4000):
            chunk = indices[start:start + 4000]
            try:
                out = subprocess.run(["xcrun", "atos", "-o", image, "-l", "0x" + base] + ["0x" + addresses[i]["address"] for i in chunk],
                                     capture_output=True, text=True, timeout=300).stdout.splitlines()
            except (OSError, subprocess.SubprocessError):
                continue
            if len(out) != len(chunk):
                continue
            for i, line in zip(chunk, out):
                line = line.strip()
                # atos answers an address it cannot name with the address itself.
                if line and not line.startswith("0x"):
                    result[i] = re.sub(r" \([^()]*:\d+\)$", "", line)
    # One name per function: the offset into it only splits the same function across rows.
    return [re.sub(r" \+ \d+$", "", name) for name in result]


def main(path):
    data = json.load(open(path))
    readable = names(data.get("addresses", []))
    images = [os.path.basename(entry.get("image", "")) or "?" for entry in data.get("addresses", [])]

    def clip(name):
        name = name.replace("|", "\\|").replace("`", "'")
        return name if len(name) <= 150 else name[:147] + "..."

    print("## Where the main thread went\n")
    print("Sampled in the app about once a millisecond (`BenchSampler`); the sampler slows the app, so read shares, not times.\n")
    for phase in data.get("phases", []):
        if phase["phase"] not in SHOWN:
            continue
        samples = phase["samples"]
        under, own, by_image, app_under, app_inner = Counter(), Counter(), Counter(), Counter(), Counter()
        whole = 0
        for count, stack in phase["stacks"]:
            if not stack:
                continue
            functions = [readable[i] for i in stack]
            own[functions[0]] += count
            for function in set(functions):
                under[function] += count
            for image in set(images[i] for i in stack):
                by_image[image] += count
            app = [readable[i] for i in stack if images[i] in APP_IMAGES and not readable[i].startswith("main ")]
            for function in set(app):
                app_under[function] += count
            if app:
                app_inner[app[0]] += count
            if any(readable[i].startswith("main ") for i in stack):
                whole += count

        def share(n):
            return f"{100 * n / samples:.0f}%" if samples else "–"

        print(f"### {phase['phase']}\n\n{samples:,} samples of the main thread; {share(whole)} of them walked all the way to `main`.\n")
        print("| On the stack | Function |\n| ---: | --- |")
        for function, n in under.most_common(TOP_UNDER):
            print(f"| {share(n)} | `{clip(function)}` |")
        print("\n| At the top | Function |\n| ---: | --- |")
        for function, n in own.most_common(TOP_OWN):
            print(f"| {share(n)} | `{clip(function)}` |")
        print("\n| On the stack | The app's own function |\n| ---: | --- |")
        for function, n in app_under.most_common(TOP_APP):
            print(f"| {share(n)} | `{clip(function)}` |")
        print("\n| Innermost | The app's own function |\n| ---: | --- |")
        for function, n in app_inner.most_common(TOP_APP):
            print(f"| {share(n)} | `{clip(function)}` |")
        print("\n| On the stack | Image |\n| ---: | --- |")
        for image, n in by_image.most_common(TOP_IMAGES):
            print(f"| {share(n)} | `{clip(image)}` |")
        print()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

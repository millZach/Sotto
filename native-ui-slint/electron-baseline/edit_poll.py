#!/usr/bin/env python3
"""edit_poll.py <css-file> <region "x,y WxH"> <runs> <out.json>

Edit-to-screen under Vite HMR: for each run, capture the region (inside the composer's padding, so it shows only the
composer's background), note the time, rewrite the composer's background colour in the stylesheet, then capture the
region with grim every ~30 ms until its pixels change. The figure is the start of the first changed capture minus the
write; the start of the capture before it bounds it from below. The edit is then reverted (and the revert waited for)
before the next run."""
import json
import subprocess
import sys
import time

css, region, runs, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
ORIGINAL = '.thread-prompt { display: grid; grid-template-columns: auto minmax(0, 1fr); padding: 14px 16px 10px; border: 1px solid transparent; border-radius: var(--tt-radius-card); background: var(--tt-card); }'
EDITED = ORIGINAL.replace('background: var(--tt-card);', 'background: #ff00ff;')
INTERVAL = 0.030


def grab():
    return subprocess.run(['grim', '-g', region, '-t', 'ppm', '-'], check=True, capture_output=True).stdout


def write(text_from, text_to):
    with open(css, encoding='utf-8') as f:
        text = f.read()
    assert text.count(text_from) == 1, 'the composer rule is not in the stylesheet as expected'
    t0 = time.time_ns()
    with open(css, 'w', encoding='utf-8') as f:
        f.write(text.replace(text_from, text_to))
    return t0


def wait_change(baseline, t0, timeout=30):
    previous_start = t0
    captures = 0
    durations = []
    while True:
        start = time.time_ns()
        frame = grab()
        durations.append((time.time_ns() - start) / 1e6)
        captures += 1
        if frame != baseline:
            return {'ms': (start - t0) / 1e6, 'lower_bound_ms': (previous_start - t0) / 1e6, 'captures': captures,
                    'grim_ms_median': sorted(durations)[len(durations) // 2]}
        if (start - t0) / 1e9 > timeout:
            raise SystemExit('no change on screen within %d s' % timeout)
        previous_start = start
        time.sleep(max(0, INTERVAL - (time.time_ns() - start) / 1e9))


results = []
for i in range(runs):
    time.sleep(3)
    base = grab()
    t0 = write(ORIGINAL, EDITED)
    forward = wait_change(base, t0)
    time.sleep(2)
    edited = grab()
    t1 = write(EDITED, ORIGINAL)
    back = wait_change(edited, t1)
    results.append({'run': i + 1, 'edit_to_screen': forward, 'revert_to_screen': back})
    print(json.dumps(results[-1]), flush=True)
with open(out, 'w') as f:
    json.dump({'poll_interval_ms': INTERVAL * 1000, 'region': region, 'runs': results}, f, indent=1)

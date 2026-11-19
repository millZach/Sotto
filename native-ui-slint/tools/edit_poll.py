#!/usr/bin/env python3
"""edit_poll.py <file> <from> <to> <region "x,y WxH"> <runs> <out.json>

Edit to screen with Slint's live preview, by the same method as electron-baseline/edit_poll.py: capture the region,
note the time, rewrite <from> as <to> in <file>, then capture the region with grim every ~30 ms until its pixels
change. The figure is the start of the first changed capture minus the write; the start of the capture before it
bounds it from below. The edit is reverted (and the revert waited for) before the next run."""
import json, subprocess, sys, time

path, before, after, region, runs, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6]
INTERVAL = 0.030

def grab():
    return subprocess.run(['grim', '-g', region, '-t', 'ppm', '-'], check=True, capture_output=True).stdout

def write(a, b):
    text = open(path, encoding='utf-8').read()
    assert text.count(a) == 1, f'{a!r} is not in {path} exactly once'
    t0 = time.time_ns()
    open(path, 'w', encoding='utf-8').write(text.replace(a, b))
    return t0

def wait_change(baseline, t0, timeout=60):
    previous = t0; captures = 0; grabs = []
    while True:
        start = time.time_ns(); frame = grab(); grabs.append((time.time_ns() - start) / 1e6); captures += 1
        if frame != baseline:
            return {'ms': (start - t0) / 1e6, 'lower_bound_ms': (previous - t0) / 1e6, 'captures': captures, 'grim_ms_median': sorted(grabs)[len(grabs) // 2]}
        if (start - t0) / 1e9 > timeout:
            raise SystemExit(f'no change on screen within {timeout} s')
        previous = start
        time.sleep(max(0, INTERVAL - (time.time_ns() - start) / 1e9))

results = []
for i in range(runs):
    time.sleep(3)
    base = grab(); t0 = write(before, after); forward = wait_change(base, t0)
    time.sleep(2)
    edited = grab(); t1 = write(after, before); back = wait_change(edited, t1)
    results.append({'run': i + 1, 'edit_to_screen': forward, 'revert_to_screen': back})
    print(json.dumps(results[-1]), flush=True)
json.dump({'poll_interval_ms': INTERVAL * 1000, 'region': region, 'file': path, 'runs': results}, open(out, 'w'), indent=1)

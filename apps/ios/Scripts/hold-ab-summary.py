#!/usr/bin/env python3
"""Sets the two sides of hold-ab.sh side by side from its logs. Usage: hold-ab-summary.py <report folder>"""
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

folder = Path(sys.argv[1])
cases = {'with': defaultdict(list), 'without': defaultdict(list)}
timings = {'with': defaultdict(list), 'without': defaultdict(list)}
missed = {'with': defaultdict(int), 'without': defaultdict(int)}
errors = []
rounds = defaultdict(int)
for log in sorted(folder.glob('*.log')):
    match = re.fullmatch(r'(with|without)-(\d+)\.log', log.name)
    if not match:
        continue
    side = match[1]
    rounds[side] += 1
    seen = set()
    for line in log.read_text(errors='replace').splitlines():
        case = re.search(r"Test Case '-\[\S+ (\w+)\]' (passed|failed) \(([\d.]+) seconds\)", line)
        if case:
            cases[side][case[1]].append((case[2], float(case[3])))
        error = re.search(r'error: -\[\S+ (\w+)\] : (.{0,110})', line)
        if error:
            errors.append(f'{log.stem} {error[1]}: {error[2]}')
        timing = re.search(r'HOLDAB (\S+) seen=(\d) looks=(\d+) tap=([\d.]+) total=([\d.]+)', line)
        # Each is printed and logged as an activity: the same text twice.
        if timing and timing[0] not in seen:
            seen.add(timing[0])
            timings[side][timing[1]].append(float(timing[5]))
            if timing[2] == '0':
                missed[side][timing[1]] += 1


def percentile(values, share):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * share))]


print(f"Rounds: with the hold {rounds['with']}, without {rounds['without']}\n")
print('| Switch, seconds | With: n, median, p90, worst, never seen | Without: n, median, p90, worst, never seen |')
print('| --- | --- | --- |')
for name in sorted(set(timings['with']) | set(timings['without'])):
    row = []
    for side in ('with', 'without'):
        values = timings[side][name]
        row.append(f'{len(values)}, {statistics.median(values):.2f}, {percentile(values, 0.9):.2f}, {max(values):.2f}, {missed[side][name]}' if values else 'none')
    print(f'| {name} | {row[0]} | {row[1]} |')
print('\n| Journey | With: failed of runs, median s | Without: failed of runs, median s |')
print('| --- | --- | --- |')
for name in sorted(set(cases['with']) | set(cases['without'])):
    row = []
    for side in ('with', 'without'):
        runs = cases[side][name]
        row.append(f"{sum(r[0] == 'failed' for r in runs)} of {len(runs)}, {statistics.median(r[1] for r in runs):.0f}" if runs else 'none')
    print(f'| {name} | {row[0]} | {row[1]} |')
print('\nFailures:')
for error in errors or ['none']:
    print('-', error)
totals = {side: (sum(r[0] == 'failed' for runs in cases[side].values() for r in runs), sum(len(runs) for runs in cases[side].values())) for side in cases}
print(f"\nTotal so far: with {totals['with'][0]} failed of {totals['with'][1]}, without {totals['without'][0]} failed of {totals['without'][1]}")

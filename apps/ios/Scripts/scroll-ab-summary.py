#!/usr/bin/env python3
"""Sets the two builds' list-scroll phases side by side for scroll-ab.sh. Usage: scroll-ab-summary.py <report folder>"""
import itertools
import json
import re
import statistics
import sys
from pathlib import Path

folder = Path(sys.argv[1])
METRICS = [('longestFrameMs', 'Longest frame', 'ms'), ('hitchMsPerSecond', 'Hitch time', 'ms/s'), ('hitches', 'Hitches', 'count')]
reports = {}
unfinished = []
for file in sorted(folder.glob('*-*-*.json')):
    match = re.fullmatch(r'(before|merge)-(\d+)-(\d)\.json', file.name)
    if not match:
        continue
    try:
        report = json.loads(file.read_text())
        if report.get('phase') != 'finished':
            raise ValueError(report.get('phase'))
        frames = report['phases']['list-scroll']['frames']
    except (ValueError, KeyError) as error:
        unfinished.append(f'{file.name} ({error})')
        continue
    reports.setdefault((match[1], int(match[2])), []).append(frames)

rounds = sorted({round_ for _, round_ in reports})
print('## Threads list scroll, on main and with the fade on its own view\n')
print(f'{len(rounds)} rounds of five journeys a side, taking turns on one runner. A block is the benchmark\'s own median of five.\n')
for key, name, unit in METRICS:
    print(f'### {name} ({unit})\n')
    print('| Round | Before | Merge | Merge minus before |\n| ---: | ---: | ---: | ---: |')
    differences = []
    for round_ in rounds:
        before = reports.get(('before', round_))
        merge = reports.get(('merge', round_))
        if not before or not merge:
            continue
        a, b = (statistics.median(r[key] for r in side) for side in (before, merge))
        differences.append(b - a)
        print(f'| {round_} | {a:,.1f} | {b:,.1f} | {b - a:+,.1f} |')
    every = {side: [r[key] for (s, _), rows in reports.items() if s == side for r in rows] for side in ('before', 'merge')}
    print()
    for side, values in every.items():
        if values:
            print(f'- {side}: n {len(values)}, median {statistics.median(values):,.1f}, lowest {min(values):,.1f}, highest {max(values):,.1f}')
    if differences:
        mean = statistics.fmean(differences)
        signs = list(itertools.product((1, -1), repeat=len(differences)))
        extreme = sum(abs(statistics.fmean(s * d for s, d in zip(sign, differences))) >= abs(mean) - 1e-9 for sign in signs)
        print(f'- merge minus before, per round: mean {mean:+,.1f}, median {statistics.median(differences):+,.1f}, '
              f'merge slower in {sum(d > 0 for d in differences)} of {len(differences)}, exact sign-flip p = {extreme / len(signs):.3f}')
    print()
if unfinished:
    print('Left out, not finished: ' + ', '.join(unfinished))

#!/usr/bin/env python3
"""
The provider processes under a running Sotto host: each one's age, memory, and the CPU it used over a minute.

    python3 scripts/perf-bench/host-children.py <host pid> [seconds]

Linux only. It reads /proc and prints names, ages and sizes, never a command line.
"""
import os
import re
import sys
import time

host = int(sys.argv[1])
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 60
hz = os.sysconf('SC_CLK_TCK')


def children():
    found = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            stat = open(f'/proc/{pid}/stat').read()
            rest = stat[stat.rindex(')') + 2:].split()
            if int(rest[1]) != host:
                continue
            rss = int(re.search(r'VmRSS:\s+(\d+)', open(f'/proc/{pid}/status').read()).group(1))
            found[int(pid)] = {'name': stat[stat.index('(') + 1:stat.rindex(')')], 'ticks': int(rest[11]) + int(rest[12]), 'start': int(rest[19]), 'rss': rss}
        except (OSError, ValueError, AttributeError):
            continue
    return found


before = children()
time.sleep(seconds)
after = children()
uptime = float(open('/proc/uptime').read().split()[0])
total = 0
for pid, process in sorted(after.items(), key=lambda item: -item[1]['rss']):
    earlier = before.get(pid)
    used = (process['ticks'] - earlier['ticks']) / hz if earlier else None
    total += process['rss']
    print(f"{process['name']:12} age {(uptime - process['start'] / hz) / 60:6.0f} min  memory {process['rss'] / 1024:5.0f} MB  CPU in {seconds:.0f} s: {'new' if used is None else f'{used:.2f} s'}")
print(f"{len(after)} processes, {total / 1024:.0f} MB")

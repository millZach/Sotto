#!/usr/bin/env python3
"""memory.py <electron-main-pid> <out.json>: PSS and RSS (kB, /proc/<pid>/smaps_rollup) of every process in the
Electron app's tree, grouped by Chromium process type. Children that are not Electron (the fake Claude CLI, any git or
shell it ran) are listed but left out of the total."""
import json
import os
import sys


def ppid_map():
    children = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open(f'/proc/{name}/stat') as f:
                stat = f.read()
        except OSError:
            continue
        ppid = int(stat[stat.rindex(')') + 2:].split()[1])
        children.setdefault(ppid, []).append(int(name))
    return children


def rollup(pid):
    out = {}
    with open(f'/proc/{pid}/smaps_rollup') as f:
        for line in f:
            parts = line.split()
            if parts[0] in ('Rss:', 'Pss:', 'Pss_Anon:', 'Pss_File:', 'Pss_Shmem:', 'Private_Clean:', 'Private_Dirty:', 'Swap:', 'SwapPss:'):
                out[parts[0][:-1].lower()] = int(parts[1])
    return out


def kind(cmd, exe, main_pid, pid):
    if pid == main_pid:
        return 'main (browser)'
    if not exe.endswith('/electron') and 'electron' not in os.path.basename(exe):
        return None
    for arg in cmd:
        if arg.startswith('--type='):
            t = arg[7:]
            if t == 'utility':
                sub = next((a.split('=', 1)[1] for a in cmd if a.startswith('--utility-sub-type=')), '?')
                return f'utility ({sub})'
            if t == 'zygote':
                return 'zygote' + (' (no sandbox)' if '--no-zygote-sandbox' in cmd else '')
            return {'gpu-process': 'gpu'}.get(t, t)
    return 'electron (other)'


def main():
    main_pid, out = int(sys.argv[1]), sys.argv[2]
    children = ppid_map()
    queue, tree = [main_pid], []
    while queue:
        pid = queue.pop(0)
        tree.append(pid)
        queue.extend(children.get(pid, []))
    procs, excluded = [], []
    for pid in tree:
        try:
            cmd = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
            # Chromium rewrites its children's titles into one space-joined string, so split on spaces too.
            cmd = [a for c in cmd if c for a in c.decode(errors='replace').split(' ') if a]
            exe = os.readlink(f'/proc/{pid}/exe')
            mem = rollup(pid)
        except OSError:
            continue
        k = kind(cmd, exe, main_pid, pid)
        entry = {'pid': pid, 'type': k, **mem}
        if k is None:
            # Only the program's file name: a provider's arguments can hold what a thread said.
            entry['program'] = ' '.join(os.path.basename(c) for c in cmd[:2])
            excluded.append(entry)
        else:
            procs.append(entry)
    by_type = {}
    for p in procs:
        t = by_type.setdefault(p['type'], {'count': 0, 'pss_kib': 0, 'rss_kib': 0})
        t['count'] += 1
        t['pss_kib'] += p.get('pss', 0)
        t['rss_kib'] += p.get('rss', 0)
    result = {
        'total_pss_kib': sum(p.get('pss', 0) for p in procs),
        'total_rss_kib': sum(p.get('rss', 0) for p in procs),
        'process_count': len(procs),
        'by_type': by_type,
        'processes': procs,
        'excluded_non_electron_children': excluded,
    }
    with open(out, 'w') as f:
        json.dump(result, f, indent=1)


main()

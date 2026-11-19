"""PSS of a process tree, by process type (CEF's --type switch, or 'browser' for the app itself)."""
import glob, json, sys
def tree(pid):
    out, todo = [], [pid]
    while todo:
        p = todo.pop(); out.append(p)
        for f in glob.glob(f'/proc/{p}/task/*/children'):
            try: todo += [int(c) for c in open(f).read().split()]
            except OSError: pass
    return out
rows = []
for p in tree(int(sys.argv[1])):
    try:
        args = open(f'/proc/{p}/cmdline').read().split('\0')
        pss = next(int(l.split()[1]) for l in open(f'/proc/{p}/smaps_rollup') if l.startswith('Pss:'))
    except (OSError, StopIteration): continue
    kind = next((a.split('=', 1)[1] for a in args if a.startswith('--type=')), 'browser (the app)')
    sub = next((a.split('=', 1)[1] for a in args if a.startswith('--utility-sub-type=')), '')
    rows.append({'pid': p, 'type': kind + (f' {sub}' if sub else ''), 'pss_mb': round(pss / 1024, 1)})
print(json.dumps({'total_mb': round(sum(r['pss_mb'] for r in rows), 1), 'processes': rows}, indent=1))

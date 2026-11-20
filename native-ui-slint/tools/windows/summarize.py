# Summarises a folder written by tools/windows/bench.ps1: each run, then the range over runs, per renderer.
#   python tools/windows/summarize.py <folder>
import glob, json, os, re, statistics, sys

folder = sys.argv[1]


def pct(v, q):
    s = sorted(v)
    return s[round((len(s) - 1) * q)]


def runs_txt():
    path = os.path.join(folder, 'runs.txt')
    if not os.path.exists(path):
        return {}
    raw = open(path, 'rb').read()
    text = raw.decode('utf-16') if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else raw.decode('utf-8', 'replace')
    out = {}
    for line in text.splitlines():
        m = re.match(r'(\S+) cpu_at_start=(\d+)% free_gb=([\d.]+) mem: processes: (\d+), working set: ([\d.]+) MB, private bytes: ([\d.]+) MB', line.strip())
        if m:
            out[m[1]] = dict(cpu=int(m[2]), free=float(m[3]), procs=int(m[4]), ws=float(m[5]), priv=float(m[6]))
            a = re.search(r'app alone: processes: \d+, working set: ([\d.]+) MB, private bytes: ([\d.]+) MB', line)
            if a:
                out[m[1]].update(ws_app=float(a[1]), priv_app=float(a[2]))
    return out


meta = runs_txt()
names = sorted({re.sub(r'-run\d+\.json$', '', os.path.basename(p)) for p in glob.glob(os.path.join(folder, '*-run*.json')) if not p.endswith('.raw.json')})
for r in names:
    print(f'## {r}')
    rows = []
    for path in sorted(glob.glob(os.path.join(folder, f'{r}-run*.json'))):
        if path.endswith('.raw.json'):
            continue
        run = os.path.basename(path)[:-5]
        d = json.load(open(path))
        raw = json.load(open(path + '.raw.json'))
        fi, rt, ty = raw['frame_interval_ms'], raw['render_ms'], raw['typing_ms']
        m = meta.get(run, {})
        row = dict(n=len(fi), med=pct(fi, .5), p95=pct(fi, .95), p99=pct(fi, .99), worst=max(fi), over33=sum(x > 33.3 for x in fi),
                   r_med=pct(rt, .5), r_p99=pct(rt, .99), r_worst=max(rt), stream_s=d['stream_ms'] / 1000, launch=d['launch_ms'],
                   ws=m.get('ws', float('nan')), priv=m.get('priv', float('nan')), procs=m.get('procs', 0), cpu=m.get('cpu', -1), free=m.get('free', float('nan')),
                   ws_app=m.get('ws_app', float('nan')), priv_app=m.get('priv_app', float('nan')))
        if ty:
            row.update(t_n=len(ty), t_med=pct(ty, .5), t_p95=pct(ty, .95), t_worst=max(ty))
        rows.append(row)
        t = f" | key to frame n {row['t_n']} med {row['t_med']:.1f} p95 {row['t_p95']:.1f} worst {row['t_worst']:.1f}" if ty else ''
        print(f"{run}: cpu {row['cpu']}% free {row['free']} GB | frames {row['n']} over {row['stream_s']:.1f} s: med {row['med']:.1f} p95 {row['p95']:.1f} p99 {row['p99']:.1f} worst {row['worst']:.1f} >33.3 {row['over33']}"
              f" | work med {row['r_med']:.2f} p99 {row['r_p99']:.2f} worst {row['r_worst']:.1f} | memory {row['procs']} proc ws {row['ws']:.1f} MB priv {row['priv']:.1f} MB (app alone ws {row['ws_app']:.1f} priv {row['priv_app']:.1f}){t}")
    if rows:
        rng = lambda k: f"{min(x[k] for x in rows):.1f}-{max(x[k] for x in rows):.1f}"
        print(f"range: med {rng('med')} p95 {rng('p95')} p99 {rng('p99')} worst {rng('worst')} >33.3 {rng('over33')} | work med {rng('r_med')} p99 {rng('r_p99')} worst {rng('r_worst')} | ws {rng('ws')} priv {rng('priv')}")
    print()

#!/usr/bin/env python3
# summarize.py <dir>: each bench run, then the median of runs, the way the Slint half's tools/summarize.py does.
# Frame interval here is between the ends of consecutive frames' paint (Slint: AfterRendering to AfterRendering);
# the interval between frame starts, GPUI's Windows figure, is shown beside it.
import json, statistics, sys, glob, os, re
folder = sys.argv[1]
def pct(v, q):
    s = sorted(v); return s[round((len(s) - 1) * q)]
rows = []
for path in sorted(glob.glob(f'{folder}/gpui-[0-9].json')):
    d = json.load(open(path)); raw = json.load(open(path[:-5] + '.raw.json'))
    fe = raw['frame_end_interval_ms']; fs = raw['frame_interval_ms']; w = raw['frame_work_ms']; k = raw['key_to_paint_ms']
    load = open(path + '.load').read().split()[1:4]
    r = dict(load=' '.join(load), n=len(fe) + 1, f_med=pct(fe, .5), f_p95=pct(fe, .95), f_p99=pct(fe, .99), f_max=max(fe),
             over33=sum(x > 33.3 for x in fe), s_med=pct(fs, .5), s_p99=pct(fs, .99), s_max=max(fs), s_over33=sum(x > 33.3 for x in fs),
             w_med=pct(w, .5), w_p95=pct(w, .95), w_p99=pct(w, .99), w_max=max(w),
             k_n=len(k), k_med=pct(k, .5), k_p95=pct(k, .95), k_max=max(k), pss=d['pss_mib'], rss=d['rss_mib'], first=d['first_paint_ms'])
    rows.append(r)
    print(f"{os.path.basename(path)} load {r['load']} | frames {r['n']} end-interval med {r['f_med']:.1f} p95 {r['f_p95']:.1f} p99 {r['f_p99']:.1f} max {r['f_max']:.1f} >33.3 {r['over33']}"
          f" (start-interval med {r['s_med']:.1f} p99 {r['s_p99']:.1f} max {r['s_max']:.1f} >33.3 {r['s_over33']}) | work med {r['w_med']:.2f} p95 {r['w_p95']:.2f} p99 {r['w_p99']:.2f} max {r['w_max']:.1f}"
          f" | typing n {r['k_n']} med {r['k_med']:.2f} p95 {r['k_p95']:.2f} max {r['k_max']:.2f} | PSS {r['pss']:.1f} RSS {r['rss']:.1f} MiB | first paint {r['first']:.0f} ms")
med = {k: statistics.median([x[k] for x in rows]) for k in rows[0] if k != 'load'}
print('median of runs: ' + ', '.join(f'{k} {v:.2f}' for k, v in med.items()))
lf = f'{folder}/launch.txt'
if os.path.exists(lf):
    ms = [float(m) for m in re.findall(r'launch_ms=([0-9.]+)', open(lf).read())]
    print(f'launch runs {ms} -> median of runs 2..n {statistics.median(ms[1:]):.1f} ms (first run {ms[0]:.1f})')

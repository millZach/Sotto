# Summarises the bench runs in a folder: each run, then the median of runs, per renderer.
import json, statistics, sys, glob, os, re
folder = sys.argv[1]
def pct(v, q):
    s = sorted(v); return s[round((len(s) - 1) * q)]
for r in ['femtovg', 'skia-opengl']:
    runs = sorted(glob.glob(f'{folder}/{r}-[0-9].json'))
    if not runs: continue
    print(f'## {r}')
    rows = []
    for path in runs:
        d = json.load(open(path)); raw = json.load(open(path + '.raw.json'))
        fi = raw['frame_interval_ms']; rt = raw['render_ms']; ty = raw['typing_ms']
        load = open(path + '.load').read().split()[1:4]
        row = dict(
            load=' '.join(load), n=len(fi), f_med=pct(fi, .5), f_p95=pct(fi, .95), f_p99=pct(fi, .99), f_max=max(fi),
            f_mean=statistics.mean(fi), over25=sum(x > 25 for x in fi), over33=sum(x > 33.3 for x in fi),
            r_med=pct(rt, .5), r_p95=pct(rt, .95), r_p99=pct(rt, .99), r_max=max(rt),
            t_n=len(ty), t_med=pct(ty, .5), t_p95=pct(ty, .95), t_p99=pct(ty, .99), t_max=max(ty),
            pss=d['memory_after_stream']['pss_kib'] / 1024, rss=d['memory_after_stream']['rss_kib'] / 1024, launch=d['launch_ms'])
        rows.append(row)
        print(f"{os.path.basename(path)} load {row['load']} | frames n {row['n']} med {row['f_med']:.1f} p95 {row['f_p95']:.1f} p99 {row['f_p99']:.1f} max {row['f_max']:.1f} mean {row['f_mean']:.2f} >25 {row['over25']} >33.3 {row['over33']} | render med {row['r_med']:.2f} p95 {row['r_p95']:.2f} p99 {row['r_p99']:.2f} max {row['r_max']:.1f} | typing n {row['t_n']} med {row['t_med']:.1f} p95 {row['t_p95']:.1f} p99 {row['t_p99']:.1f} max {row['t_max']:.1f} | PSS {row['pss']:.1f} RSS {row['rss']:.1f} MiB")
    med = {k: statistics.median([x[k] for x in rows]) for k in rows[0] if k != 'load'}
    print('median of runs: ' + ', '.join(f'{k} {v:.2f}' for k, v in med.items()))
    lf = f'{folder}/launch-{r}.txt'
    if os.path.exists(lf):
        ms = [float(m) for m in re.findall(r'launch_ms=([0-9.]+)', open(lf).read())]
        print(f'launch runs {ms} -> median of runs 2..n {statistics.median(ms[1:]):.1f} ms (first run {ms[0]:.1f})')

"""Question 6: start the component when a pane shows, stop it when the last closes. Spawns the pane process the way
Sotto's main would, and measures: time to first paint (cold: CEF's files evicted from the page cache first; warm),
the process tree's memory (PSS) while one page shows, after the browser closes with CEF still up, and after the
process exits (nothing of it may remain). Run with: python -I lifecycle.py <dist> <run-dir> <url> [runs] [extra-switches]
"""
import json, os, subprocess, sys, time, glob

dist, run, url = sys.argv[1], sys.argv[2], sys.argv[3]
runs = int(sys.argv[4]) if len(sys.argv) > 4 else 5
extra = sys.argv[5] if len(sys.argv) > 5 else ''
os.makedirs(run, exist_ok=True)

def tree(pid):
    out, todo = [], [pid]
    while todo:
        p = todo.pop(); out.append(p)
        for f in glob.glob(f'/proc/{p}/task/*/children'):
            try: todo += [int(c) for c in open(f).read().split()]
            except OSError: pass
    return out

def pss_kb(pids):
    total = 0
    for p in pids:
        try:
            for line in open(f'/proc/{p}/smaps_rollup'):
                if line.startswith('Pss:'): total += int(line.split()[1])
        except OSError: pass
    return total

def ours():
    found = []
    for d in glob.glob('/proc/[0-9]*'):
        try:
            exe = os.readlink(f'{d}/exe')
        except OSError: continue
        if exe.startswith(os.path.realpath(dist)): found.append(int(d.split('/')[-1]))
    return found

def evict():
    n = 0
    for f in glob.glob(f'{os.path.realpath(dist)}/*') + glob.glob(os.path.realpath(f'{dist}/libcef.so')) + glob.glob(f'{os.path.realpath(os.path.join(dist, "locales"))}/*'):
        f = os.path.realpath(f)
        if os.path.isfile(f):
            fd = os.open(f, os.O_RDONLY)
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED); os.close(fd); n += 1
    return n

results = []
assert not ours(), 'a pane process is already running from this folder'
for i in range(runs * 2):
    cold = i % 2 == 0
    if cold: evict()
    home = f'{run}/home{i}'; os.makedirs(home, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k != 'DBUS_SESSION_BUS_ADDRESS'}
    env.update(HOME=home, XDG_CONFIG_HOME=f'{home}/.config', XDG_CACHE_HOME=f'{home}/.cache', WP_MODE='pane', WP_URL=url,
               WP_RUN_DIR=home, WP_CACHE=f'{home}/cache', WP_SWITCHES=f'ozone-platform=headless;{extra}')
    t0 = time.monotonic()
    p = subprocess.Popen(['./webpane'], cwd=dist, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f'{home}/stderr.log', 'w'), text=True)
    line = p.stdout.readline()
    first = (time.monotonic() - t0) * 1000
    time.sleep(3)
    pids = tree(p.pid); showing = pss_kb(pids); nprocs = len(pids)
    p.stdin.write('close\n'); p.stdin.flush()
    closed_line = p.stdout.readline()
    time.sleep(2)
    pids_closed = tree(p.pid); closed = pss_kb(pids_closed)
    t1 = time.monotonic()
    p.stdin.write('quit\n'); p.stdin.flush()
    p.wait(timeout=30)
    stop_ms = (time.monotonic() - t1) * 1000
    time.sleep(0.5)
    left = ours()
    r = dict(run=i, cold=cold, first_paint_wall_ms=round(first), runner_line=line.strip(), processes_showing=nprocs, pss_showing_mb=round(showing / 1024, 1),
             processes_after_close=len(pids_closed), pss_after_close_mb=round(closed / 1024, 1), stop_ms=round(stop_ms), exit=p.returncode, processes_left_after_exit=left)
    print(json.dumps(r), flush=True); results.append(r)
json.dump(results, open(f'{run}/lifecycle.json', 'w'), indent=1)

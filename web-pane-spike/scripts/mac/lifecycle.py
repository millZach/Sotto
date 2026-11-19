"""Question 7 on macOS: start the component when a pane shows, stop it when the last closes. Spawns `pane` mode the
way Sotto's window would and measures time to first paint (cold: `sudo purge` empties the file cache first; warm),
the process tree's physical footprint (Activity Monitor's Memory) while one page shows, after the browser closes
with CEF still up, the stop time, and what of the bundle is left after exit.
Usage: python3 -I lifecycle.py <app> <run-dir> <url> [pairs]"""
import ctypes, json, os, subprocess, sys, time

app, run, url = sys.argv[1], sys.argv[2], sys.argv[3]
pairs = int(sys.argv[4]) if len(sys.argv) > 4 else 4
os.makedirs(run, exist_ok=True)
libc = ctypes.CDLL('/usr/lib/libSystem.dylib')

def footprint_kb(pid):
    buf = ctypes.create_string_buffer(512)  # rusage_info_v2: 16-byte uuid, then u64s; ri_phys_footprint is the 8th
    if libc.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(2), buf) != 0: return 0
    return int.from_bytes(buf.raw[16 + 7 * 8:16 + 8 * 8], 'little') // 1024

def table():
    out = subprocess.run(['/bin/ps', '-A', '-o', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2: rows.append((int(parts[0]), int(parts[1]), parts[2] if len(parts) > 2 else ''))
    return rows

def tree(pid):
    rows, found, i = table(), [pid], 0
    while i < len(found):
        found += [p for p, pp, _ in rows if pp == found[i]]; i += 1
    return found

def ours():
    root = os.path.realpath(app)
    # Processes whose executable is inside the bundle; not every command that names the bundle (the driver does).
    return [(p, c[:120]) for p, _, c in table() if c.startswith(root + '/Contents/')]

results = []
left = ours()
if left:
    print(json.dumps({'note': 'processes from the bundle were already running and were ended first', 'left': left}), flush=True)
    for pid, _ in left: subprocess.run(['kill', '-9', str(pid)])
    time.sleep(1)
for i in range(pairs * 2):
    cold = i % 2 == 0
    if cold: subprocess.run(['sudo', 'purge'], check=False)
    home = f'{run}/run{i}'; os.makedirs(home, exist_ok=True)
    env = dict(os.environ, WP_MODE='pane', WP_URL=url, WP_RUN_DIR=home, WP_CACHE=f'{home}/cache', WP_NO_SANDBOX='1')
    t0 = time.monotonic()
    p = subprocess.Popen([f'{app}/Contents/MacOS/webpane'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f'{home}/stderr.log', 'w'), text=True)
    line = p.stdout.readline()
    first = (time.monotonic() - t0) * 1000
    time.sleep(3)
    pids = tree(p.pid); showing = sum(footprint_kb(x) for x in pids)
    p.stdin.write('close\n'); p.stdin.flush()
    p.stdout.readline()
    time.sleep(2)
    pids_closed = tree(p.pid); closed = sum(footprint_kb(x) for x in pids_closed)
    t1 = time.monotonic()
    p.stdin.write('quit\n'); p.stdin.flush()
    try: p.wait(timeout=30)
    except subprocess.TimeoutExpired: p.kill(); p.wait()
    stop_ms = (time.monotonic() - t1) * 1000
    time.sleep(1)
    r = dict(run=i, cold=cold, first_paint_wall_ms=round(first), runner_line=line.strip(), processes_showing=len(pids), footprint_showing_mb=round(showing / 1024, 1),
             processes_after_close=len(pids_closed), footprint_after_close_mb=round(closed / 1024, 1), stop_ms=round(stop_ms), exit=p.returncode, left_after_exit=ours())
    print(json.dumps(r), flush=True); results.append(r)
json.dump(results, open(f'{run}/lifecycle.json', 'w'), indent=1)

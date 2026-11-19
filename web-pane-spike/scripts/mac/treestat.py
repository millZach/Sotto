"""Samples a process tree from outside: CPU used over a window (as a share of one core) and the physical footprint
at its end. Usage: python3 -I treestat.py <root-pid> <seconds> <out.json>"""
import ctypes, json, subprocess, sys, time
root, seconds, out = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
libc = ctypes.CDLL('/usr/lib/libSystem.dylib')

def footprint_kb(pid):
    buf = ctypes.create_string_buffer(512)
    if libc.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(2), buf) != 0: return 0
    return int.from_bytes(buf.raw[72:80], 'little') // 1024

def cpu_s(t):
    parts = t.replace('-', ':').split(':')
    s = 0.0
    for p in parts: s = s * 60 + float(p)
    return s

def snap():
    rows = {}
    for line in subprocess.run(['/bin/ps', '-A', '-o', 'pid=,ppid=,time=,comm='], capture_output=True, text=True).stdout.splitlines():
        f = line.split(None, 3)
        if len(f) >= 3: rows[int(f[0])] = (int(f[1]), cpu_s(f[2]), f[3] if len(f) > 3 else '')
    found, i = [root], 0
    while i < len(found):
        found += [p for p, (pp, _, _) in rows.items() if pp == found[i]]; i += 1
    return {p: rows[p] for p in found if p in rows}

a = snap(); time.sleep(seconds); b = snap()
cpu = sum(b[p][1] - a.get(p, (0, b[p][1]))[1] for p in b)
procs = [{'name': b[p][2].split('/')[-1][:40], 'footprint_mb': round(footprint_kb(p) / 1024, 1), 'cpu_s': round(b[p][1] - a.get(p, (0, b[p][1]))[1], 2)} for p in b]
json.dump({'seconds': seconds, 'tree_cpu_percent_of_one_core': round(100 * cpu / seconds, 1), 'processes': len(b), 'footprint_mb': round(sum(x['footprint_mb'] for x in procs), 1), 'by_process': procs}, open(out, 'w'), indent=1)

"""Runs one spike mode from the bundle with its own run folder, a hard timeout and its output kept, and prints the
exit. Usage: python3 -I run.py <app> <runs-dir> <mode> <run-name> <timeout-s> [VAR=value ...]
With WP_AS_GROUP=<group> in the environment the run is started through as_group.py under sudo, so pf can tell its
sockets from the runner's own (pf matches a socket's group)."""
import os, subprocess, sys, time, signal

app, runs, mode, name, timeout = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
run = os.path.join(runs, name)
os.makedirs(run, exist_ok=True)
env = dict(os.environ)
env.update(WP_MODE=mode, WP_RUN_DIR=run, WP_CACHE=os.path.join(run, 'cache'))
for kv in sys.argv[6:]:
    k, _, v = kv.partition('=')
    env[k] = v
exe = os.path.join(app, 'Contents', 'MacOS', 'webpane')
cmd = [exe]
group = env.pop('WP_AS_GROUP', '')
if group:
    here = os.path.dirname(os.path.abspath(__file__))
    pairs = [f'{k}={v}' for k, v in env.items() if k.startswith('WP_') or k in ('HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR')]
    cmd = ['sudo', '/usr/bin/env', '-i', *pairs, sys.executable, '-I', os.path.join(here, 'as_group.py'), os.environ.get('USER', 'runner'), group, exe]
t0 = time.monotonic()
with open(os.path.join(run, 'stdout.log'), 'w') as out, open(os.path.join(run, 'stderr.log'), 'w') as err:
    p = subprocess.Popen(cmd, env=env, stdout=out, stderr=err, stdin=subprocess.DEVNULL, start_new_session=True)
    open(os.path.join(run, 'pid'), 'w').write(str(p.pid))  # under sudo this is sudo's pid; the spike is its descendant
    try:
        code = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL) if not group else subprocess.run(['sudo', 'pkill', '-9', '-g', str(p.pid)])
        code = 'timeout'
print(f'{name}: exit {code} after {time.monotonic() - t0:.1f} s -> {run}', flush=True)

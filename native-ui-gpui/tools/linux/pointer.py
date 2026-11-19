#!/usr/bin/env python3
# pointer.py <step>...: drives a virtual pointer in the nested compositor B (the repository's
# scripts/omarchy-nested-pointer.c, built to $POINTER). Steps: "x,y" moves (B's layout pixels), "down", "up",
# "sleep:<s>". Needs a nested env sourced; the helper refuses to run against anything but B.
import os, subprocess, sys, time, json
env = os.environ
binary = env.get('POINTER', os.path.expanduser('~/.cache/sotto-tmp/gpui-linux/nested-pointer'))
live_wl = open(f"/proc/{subprocess.check_output(['pgrep','-x','quickshell']).split()[0].decode()}/environ",'rb').read().split(b'\0')
live_wl = [v.split(b'=',1)[1].decode() for v in live_wl if v.startswith(b'WAYLAND_DISPLAY=')][0]
live_sig = 'live-is-not-' + env['HYPRLAND_INSTANCE_SIGNATURE']
mon = json.loads(subprocess.check_output(['hyprctl', 'monitors', '-j']))[0]
lw, lh = int(mon['width'] / mon['scale']), int(mon['height'] / mon['scale'])
p = subprocess.Popen([binary, live_sig, env['HYPRLAND_INSTANCE_SIGNATURE'], live_wl, env['WAYLAND_DISPLAY']],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
assert p.stdout.readline().strip() == 'ready', 'pointer did not start'
def send(cmd):
    p.stdin.write(cmd + '\n'); p.stdin.flush(); assert p.stdout.readline().strip() == 'ok', cmd
# A new virtual pointer's first position reaches the compositor before the client's enter event, which then says
# (-1, -1); nudge it once so the client knows where it is before anything is pressed.
first = next((s for s in sys.argv[1:] if ',' in s), None)
if first:
    x, y = first.split(','); send(f'move {int(float(x)) + 1} {int(float(y))} {lw} {lh}'); time.sleep(0.05)
for step in sys.argv[1:]:
    if step.startswith('sleep:'): time.sleep(float(step[6:]))
    elif step in ('down', 'up'): send(step)
    else:
        x, y = step.split(','); send(f'move {int(float(x))} {int(float(y))} {lw} {lh}')
p.stdin.close(); p.wait()

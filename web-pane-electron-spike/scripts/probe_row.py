"""One line per probe run: did paint fire, with a texture, did descriptors cross, and the GPU process's first errors."""
import json, re, sys
run, name = sys.argv[1], sys.argv[2]
try: probe = json.load(open(f'{run}/probe.json'))
except Exception: probe = {}
last = None; first = None; gone = []
for line in open(f'{run}/helper.jsonl', errors='replace'):
    try: o = json.loads(line)
    except ValueError: continue
    if o.get('ev') in ('state', 'stopping'): last = o
    if o.get('ev', '').startswith('first'): first = o
    if o.get('ev') in ('child-gone', 'render-gone'): gone.append(o['d'].get('type', '') + ':' + o['d'].get('reason', ''))
errs = []
for line in open(f'{run}/helper.stderr', errors='replace'):
    if 'ERROR' in line and 'dbus' not in line:
        e = re.sub(r'^\[[^\]]*\]\s*', '', line.strip())[:150]
        if e not in errs: errs.append(e)
st = (last or {}).get('stats', {}); v = ((last or {}).get('state') or {}).get('video', {})
row = {'config': name, 'paints': st.get('paints'), 'with_texture': st.get('withTexture'), 'without_texture': st.get('withoutTexture'),
       'fds_received': probe.get('fds'), 'first': (first or {}).get('info') or (first or {}).get('ev'), 'formats': st.get('formats'),
       'video_time': v.get('currentTime'), 'child_gone': gone, 'errors': errs[:4], 'exit': probe.get('exit')}
json.dump(row, open(f'{run}/row.json', 'w'), indent=1)
print(json.dumps(row))

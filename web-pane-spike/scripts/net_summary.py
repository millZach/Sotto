"""Summarizes a network run: the hosts and URLs (path only, no query) the component asked for in its NetLog, the DNS
questions and connections in the pcap, and when each first happened. Summaries only; no bodies or headers."""
import json, sys, subprocess, re, collections
from urllib.parse import urlsplit
run = sys.argv[1]
t0 = None
try:
    raw = open(f'{run}/netlog.json', encoding='utf-8').read()
    if not raw.rstrip().endswith('}'):
        raw = raw.rstrip().rstrip(',') + ']}'
    log = json.loads(raw)
    types = {v: k for k, v in log['constants']['logEventTypes'].items()}
    base = int(log['constants'].get('timeTickOffset', 0))
    urls, hosts = collections.OrderedDict(), collections.OrderedDict()
    for e in log['events']:
        name = types.get(e['type'], str(e['type'])); p = e.get('params') or {}
        t = int(e['time']) if 'time' in e else 0
        t0 = t if t0 is None else min(t0, t)
        if name in ('URL_REQUEST_START_JOB',) and 'url' in p:
            u = urlsplit(p['url'])
            if u.hostname in ('127.0.0.1', 'localhost'): continue
            key = f"{p.get('method','GET')} {u.scheme}://{u.hostname}{u.path[:80]}"
            urls.setdefault(key, (t, 0)); urls[key] = (urls[key][0], urls[key][1] + 1)
        h = p.get('host') or (p.get('url') and urlsplit(p['url']).hostname) if name.startswith('HOST_RESOLVER') else None
        if isinstance(h, str):
            h = re.sub(r'^\w+://', '', h).split(':')[0].split('/')[0]
            if h and h not in ('127.0.0.1', 'localhost'): hosts.setdefault(h, t)
    print('NetLog requests (first seen s after start, count):')
    for k, (t, n) in urls.items(): print(f'  {(t - t0)/1000:7.1f}s  x{n:<3d} {k}')
    print('NetLog host lookups:')
    for h, t in hosts.items(): print(f'  {(t - t0)/1000:7.1f}s  {h}')
except FileNotFoundError:
    print('no netlog')
import os
out = subprocess.run(['tcpdump', '-nn', '-r', f'{run}/net.pcap', 'ip or ip6'], capture_output=True, text=True).stdout if os.path.exists(f'{run}/net.pcap') else ''  # no capture on Windows without elevation
dns, flows = collections.OrderedDict(), collections.Counter()
for line in out.splitlines():
    m = re.search(r'(A|AAAA|HTTPS|SVCB|PTR)\? (\S+)\.? ', line)
    if m: dns.setdefault(m.group(2).rstrip('.'), line[:8]); continue
    m = re.search(r' (IP6?) (\S+) > (\S+): (\w+)', line)
    if m:
        dst = m.group(3).rstrip(':'); proto = 'UDP' if 'UDP' in line else ('TCP' if 'Flags' in line else m.group(4))
        if dst.rsplit('.', 1)[-1] in ('443', '80', '53', '5353', '1900', '123', '3478') or proto == 'UDP':
            flows[f'{dst} {proto}'] += 1
print('DNS questions in the capture (first time):')
for n, t in dns.items(): print(f'  {t}  {n}')
print('Packets to service ports:')
for k, v in flows.most_common(40): print(f'  {v:5d}  {k}')

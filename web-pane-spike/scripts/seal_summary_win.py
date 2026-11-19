"""Summarizes a Windows seal run (scripts/seal.ps1): what each layer refused, what reached the loopback canary and the
canary on the second machine, the page's own verdicts, and from the NetLog every host the network service tried to
resolve or reach outside loopback. Summaries only; no bodies or headers. Run with: python -I -X utf8 <this> <run-dir>"""
import collections, json, sys
from urllib.parse import urlsplit

run = sys.argv[1]
d = json.load(open(f'{run}/seal.json', encoding='utf-8'))
print('layers:', d.get('seal'))
print('refused by layer:', dict(collections.Counter(r['layer'] for r in d['hub']['refused'])))
print('second load of the address:', d.get('second_load'))
tries = [c[4:] for c in d.get('console', []) if c.startswith('TRY ')]
print(f'page verdicts: {len(tries)} lines')
for name in ('canary-loopback', 'canary-forge'):
    hits = []
    for line in open(f'{run}/{name}.log', encoding='utf-8-sig'):
        try: e = json.loads(line)
        except ValueError: continue
        if e.get('event') in ('http', 'tcp', 'udp'): hits.append(e)
    print(f'{name}: {len(hits)} hits', dict(collections.Counter((e['event'], e.get('path') or e.get('port') or '') for e in hits)))
raw = open(f'{run}/netlog.json', encoding='utf-8').read()
if not raw.rstrip().endswith('}'): raw = raw.rstrip().rstrip(',') + ']}'
log = json.loads(raw)
types = {v: k for k, v in log['constants']['logEventTypes'].items()}
outside, lookups, proxied = collections.Counter(), collections.Counter(), 0
for e in log['events']:
    n = types.get(e['type'], ''); p = e.get('params') or {}
    if n == 'URL_REQUEST_START_JOB' and 'url' in p:
        u = urlsplit(p['url'])
        if u.hostname not in ('127.0.0.1', 'localhost') and u.scheme in ('http', 'https', 'ws', 'wss'): outside[f'{u.scheme}://{u.hostname}:{u.port or ""}'] += 1
    if n.startswith('HOST_RESOLVER') and 'host' in p:
        h = str(p['host'])
        if '127.0.0.1' not in h and 'localhost' not in h: lookups[h[:60]] += 1
    if n == 'SOCKS5_CONNECT' or n == 'SOCKS_CONNECT': proxied += 1
print('NetLog: requests the page started to non-loopback hosts (before any layer stopped them):', dict(outside))
print('NetLog: host lookups outside loopback:', dict(lookups))
print('NetLog: SOCKS connects to the dead proxy:', proxied)

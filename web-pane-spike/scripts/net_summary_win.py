"""Windows NetLog summary: requests outside loopback, host lookups, and the proxy auto-detection events."""
import collections, json, sys
from urllib.parse import urlsplit
run = sys.argv[1]
raw = open(f'{run}/netlog.json', encoding='utf-8').read()
if not raw.rstrip().endswith('}'): raw = raw.rstrip().rstrip(',') + ']}'
log = json.loads(raw); types = {v: k for k, v in log['constants']['logEventTypes'].items()}
t0 = min(int(e['time']) for e in log['events']); t1 = max(int(e['time']) for e in log['events'])
reqs, hosts, proxy = collections.OrderedDict(), collections.Counter(), collections.Counter()
for e in log['events']:
    n = types.get(e['type'], ''); p = e.get('params') or {}; t = (int(e['time']) - t0) / 1000
    if n == 'URL_REQUEST_START_JOB' and 'url' in p:
        u = urlsplit(p['url']); k = f"{p.get('method','GET')} {u.scheme}://{u.hostname}{':' + str(u.port) if u.port else ''}{u.path[:60]}"
        reqs.setdefault(k, [t, 0]); reqs[k][1] += 1
    if n.startswith('HOST_RESOLVER') and 'host' in p: hosts[str(p['host'])[:60]] += 1
    if 'WPAD' in n or 'PAC_FILE' in n or n == 'PROXY_CONFIG_CHANGED': proxy[n] += 1
cfg = [e['params'] for e in log['events'] if types.get(e['type']) == 'PROXY_CONFIG_CHANGED']
print(f'NetLog span: {(t1 - t0) / 1000:.0f} s')
print('Requests (first seen s after start, count):')
for k, (t, c) in reqs.items(): print(f'  {t:7.1f}s  x{c:<3d} {k}')
print('Host lookups:', dict(hosts))
print('System proxy config CEF read:', json.dumps(cfg[0]) if cfg else 'none')
print('Proxy auto-detection events:', dict(proxy))

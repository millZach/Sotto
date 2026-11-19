"""macOS run summaries. Counts and names only: no packet bodies, no NetLog bodies, no headers.
  summary.py net  <run-dir>                         NetLog requests and lookups, pktap packets by process, pf's log
  summary.py seal <run-dir> <t0> <t1> <canary-log>... what each layer refused, canary hits, pf drops, DNS names, NetLog
The run folder holds what ci.sh put there: netlog.json, pktap.txt (tcpdump -k NP), pflog.txt (tcpdump -e on pflog0),
pf-rules.txt (pfctl -vvsr), dns.txt (port 53/5353 lines)."""
import collections, json, os, re, sys
from urllib.parse import urlsplit

LOOPBACK = re.compile(r'^(127\.|::1$|fe80:|ff02:|0\.0\.0\.0)')

def netlog(run):
    path = f'{run}/netlog.json'
    if not os.path.exists(path): print('NetLog: none'); return
    raw = open(path, encoding='utf-8').read()
    if not raw.rstrip().endswith('}'): raw = raw.rstrip().rstrip(',') + ']}'
    try: log = json.loads(raw)
    except ValueError as e: print('NetLog unreadable:', e); return
    types = {v: k for k, v in log['constants']['logEventTypes'].items()}
    ev = log['events']
    if not ev: print('NetLog: no events'); return
    t0 = min(int(e['time']) for e in ev); t1 = max(int(e['time']) for e in ev)
    reqs, hosts, other = collections.OrderedDict(), collections.Counter(), collections.Counter()
    for e in ev:
        n = types.get(e['type'], ''); p = e.get('params') or {}; t = (int(e['time']) - t0) / 1000
        if n == 'URL_REQUEST_START_JOB' and 'url' in p:
            u = urlsplit(p['url'])
            k = f"{p.get('method','GET')} {u.scheme}://{u.hostname}{':' + str(u.port) if u.port else ''}{u.path[:60]}"
            reqs.setdefault(k, [t, 0]); reqs[k][1] += 1
        if n.startswith('HOST_RESOLVER') and 'host' in p: hosts[str(p['host'])[:60]] += 1
        if 'WPAD' in n or 'PAC_FILE' in n or 'DNS_OVER_HTTPS' in n or n.startswith('DOH'): other[n] += 1
    print(f'NetLog span: {(t1 - t0) / 1000:.0f} s')
    print('NetLog requests (first seen s, count):')
    for k, (t, c) in reqs.items(): print(f'  {t:7.1f}s  x{c:<3d} {k}')
    print('NetLog host lookups:', dict(hosts))
    print('NetLog proxy detection / DoH events:', dict(other))

PROC = re.compile(r'proc ([^:,()]+?):(\d+)')
EPROC = re.compile(r'eproc ([^:,()]+?):(\d+)')
FLOW = re.compile(r'\) (IP6?) (\S+)\.(\d+) > (\S+)\.(\d+): (\S+)')

def local_addresses():
    """This machine's own addresses: traffic to them stays on the machine (macOS routes it over lo0)."""
    import subprocess
    try: out = subprocess.run(['/sbin/ifconfig'], capture_output=True, text=True).stdout
    except OSError: out = ''
    found = set(re.findall(r'inet6? ([0-9a-f.:]+)', out))
    found |= set(os.environ.get('WP_LOCAL', '').split(','))
    return {a for a in found if a}

def pktap(run, name='pktap.txt'):
    path = f'{run}/{name}'
    if not os.path.exists(path): print(f'{name}: none'); return
    by_proc, flows, unattributed, total = collections.Counter(), collections.Counter(), 0, 0
    local = local_addresses()
    off_machine = collections.Counter()
    for line in open(path, errors='replace'):
        total += 1
        m = PROC.search(line); e = EPROC.search(line); f = FLOW.search(line)
        proc = m.group(1).strip() if m else None
        eproc = e.group(1).strip() if e else None
        who = proc or '?'
        if not ('webpane' in (proc or '') or 'webpane' in (eproc or '')):
            if not m: unattributed += 1
            continue
        by_proc[who + (f' (for {eproc})' if eproc and eproc != proc else '')] += 1
        if f:
            dst, port = f.group(4), f.group(5)
            src = f.group(2)
            far = dst if not LOOPBACK.match(dst) else (src if not LOOPBACK.match(src) else None)
            if far in local: far = src if src not in local and not LOOPBACK.match(src) else None
            if far:
                fport = port if far == dst else f.group(3)
                flows[(who, f.group(1), far, fport)] += 1
    print(f'{name}: {total} packet lines on the runner; packets from or for the spike\'s processes by process: {dict(by_proc)}')
    print(f'{name}: lines with no process attached: {unattributed}')
    print(f'{name}: this machine\'s addresses, counted as local: {sorted(local)}')
    print(f'{name}: the spike\'s packets to or from another machine (process, family, far address, far port): {len(flows)} flows, {sum(flows.values())} packets')
    for (who, fam, far, port), c in flows.most_common(40): print(f'  {c:6d}  {who:28s} {fam} {far} port {port}')

def pflog(run):
    path = f'{run}/pflog.txt'
    if not os.path.exists(path): print('pf log: none'); return
    acts = collections.Counter()
    for line in open(path, errors='replace'):
        m = re.search(r'(pass|block) (in|out) on (\S+): (?:IP6? )?(\S+)\.(\d+) > (\S+)\.(\d+):', line)
        if m: acts[(m.group(1), m.group(3), m.group(6), m.group(7))] += 1
    print(f'pf log (the spike\'s group): {sum(acts.values())} packets')
    for (a, ifn, dst, port), c in acts.most_common(40): print(f'  {c:6d}  {a} on {ifn} to {dst} port {port}')

def pfrules(run):
    path = f'{run}/pf-rules.txt'
    if os.path.exists(path):
        print('pf rules and counters:')
        for line in open(path): print('  ' + line.rstrip())

def net(run):
    netlog(run); pktap(run); pflog(run); pfrules(run)
    for extra in ('keychain.txt', 'extensions.txt'):
        if os.path.exists(f'{run}/{extra}'):
            print(f'{extra}:'); print(open(f'{run}/{extra}').read().rstrip())

def seal(run, t0, t1, canaries):
    if not os.path.exists(f'{run}/seal.json'): print('no seal.json: the run did not finish'); netlog(run); return
    d = json.load(open(f'{run}/seal.json', encoding='utf-8'))
    print('layers:', d.get('seal'))
    if 'error' in d: print('ERROR', d['error'])
    print('refused by layer:', dict(collections.Counter(r['layer'] for r in d.get('hub', {}).get('refused', []))))
    print('second load of the address:', d.get('second_load'))
    print('page verdicts:', len([c for c in d.get('console', []) if c.startswith('TRY ')]), 'lines; DONE seen:', any(c.startswith('DONE') for c in d.get('console', [])))
    for path in canaries:
        hits = []
        for line in open(path, errors='replace'):
            try: e = json.loads(line)
            except ValueError: continue
            if e.get('event') in ('http', 'tcp', 'udp') and t0 <= e.get('t', 0) <= t1 and (e.get('event') != 'http' or e.get('canary')): hits.append(e)
        print(f'canary {os.path.basename(path)}: {len(hits)} hits', dict(collections.Counter((e['event'], e.get('path') or e.get('port') or '') for e in hits)))
    names = collections.Counter()
    if os.path.exists(f'{run}/dns.txt'):
        for line in open(f'{run}/dns.txt', errors='replace'):
            for n in re.findall(r'(wpspike-[a-z0-9-]+\.example\.com)', line): names[n] += 1
    print('DNS questions on the machine naming the hostile page\'s hosts:', dict(names))
    netlog(run); pktap(run); pflog(run); pfrules(run)

if __name__ == '__main__':
    if sys.argv[1] == 'net': net(sys.argv[2])
    elif sys.argv[1] == 'seal': seal(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5:])

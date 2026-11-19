"""Summarizes a seal run: each attempt's outcome in the page, what each layer refused, what reached a canary, the DNS
questions asked, and every flow tcpdump saw on the namespace's link and loopback (summary, not packets)."""
import json, subprocess, sys, collections, re
run = sys.argv[1]
d = json.load(open(f'{run}/seal.json'))
print('layers:', d.get('seal'))
tries = [c[4:] for c in d.get('console', []) if c.startswith('TRY ')]
for t in tries: print('  page:', t[:150])
print('refused by layer:', dict(collections.Counter(r['layer'] for r in d['hub']['refused'])))
for r in d['hub']['refused']:
    if r['layer'] != 'dead-proxy': print('   ', r['layer'], r['what'][:110])
print('second load of the address:', d.get('second_load'))
def hits(name):
    out = []
    for line in open(f'{run}/{name}.log'):
        try: e = json.loads(line)
        except ValueError: continue
        if e.get('event') in ('http', 'tcp', 'udp', 'dns'): out.append(e)
    return out
for name in ('canary-loopback', 'canary-link', 'dns'):
    h = hits(name)
    print(f'{name}: {len(h)} hits', dict(collections.Counter((e["event"], e.get("path") or e.get("port") or e.get("name")) for e in h)))
for pcap in ('link', 'lo'):
    try: out = subprocess.run(['tcpdump', '-nn', '-r', f'{run}/{pcap}.pcap'], capture_output=True, text=True).stdout
    except FileNotFoundError: out = ''
    flows = collections.Counter()
    for line in out.splitlines():
        m = re.search(r' (IP6?) (\S+) > (\S+?):? (.*)', line)
        if not m: 
            if 'ARP' in line: flows['ARP'] += 1
            continue
        dst = m.group(3); proto = 'UDP' if 'UDP' in m.group(4) or re.search(r'\d+ (A|AAAA|PTR)\?', m.group(4)) else ('TCP' if 'Flags' in m.group(4) else m.group(4).split(' ')[0])
        flows[f'{m.group(2).rsplit(".",1)[0]} > {dst} {proto}'] += 1
    print(f'{pcap}.pcap flows:')
    for k, v in flows.most_common(25): print(f'   {v:4d}  {k}')

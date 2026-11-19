"""Prints a run's failed checks and command errors, and the counts."""
import json, sys
d = json.load(open(sys.argv[1]))
for r in d.get('rows', []):
    if 'check' in r: print('PASS' if r['pass'] else 'FAIL', r['check'], '' if r['pass'] else json.dumps(r['detail'])[:300])
    elif not r['ok']: print('CMDFAIL', r['method'], r['error'])
checks = [r for r in d.get('rows', []) if 'check' in r]
print(sum(r['pass'] for r in checks), 'of', len(checks), 'checks passed;', len({r['method'] for r in d.get('rows', []) if 'method' in r}), 'distinct commands')

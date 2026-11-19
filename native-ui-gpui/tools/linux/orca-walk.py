#!/usr/bin/env python3
# orca-walk.py <session dir>: each key from keys.log, then what Orca said before the next key (from its debug log).
import re, sys
d = sys.argv[1]
keys = [(l[:15], l[16:].strip()) for l in open(f'{d}/keys.log') if ' KEYS ' in l]
speech = [(m.group(1), m.group(2)) for m in re.finditer(r"^(\d\d:\d\d:\d\d\.\d{6}) - SPEECH OUTPUT: '(.*?)'", open(f'{d}/orca-debug.out', errors='replace').read(), re.M)]
print('(before the first key)'); i = 0
for t, s in speech:
    while i < len(keys) and keys[i][0] <= t:
        print(keys[i][1].replace('KEYS ', '> wtype ')); i += 1
    print('    "' + s + '"')
for k in keys[i:]: print(k[1].replace('KEYS ', '> wtype '))

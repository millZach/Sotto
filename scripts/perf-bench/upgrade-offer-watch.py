#!/usr/bin/env python3
"""
Whether each client that connects to a host's tailnet listener offers a WebSocket extension, such as compression.

For each upgrade request that reaches the listener on loopback it logs the time, the product names in the client's
User-Agent and the value of Sec-WebSocket-Extensions. Nothing else of the request is read or kept: no token, no address.

    sudo python3 scripts/perf-bench/upgrade-offer-watch.py <the listener's port> <seconds> <log file>

The port is `port` in the host's phone-access.json. Linux only.
"""
import socket, struct, sys, time
port=int(sys.argv[1]); seconds=float(sys.argv[2]); out=sys.argv[3]
s=socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(0x0800)); s.bind(('lo',0x0800)); s.settimeout(1)
end=time.time()+seconds; seen=set()
while time.time()<end:
    try: d,_=s.recvfrom(262144)
    except socket.timeout: continue
    if len(d)<40 or d[9]!=6: continue
    ihl=(d[0]&15)*4; sp,dp,seq=struct.unpack('>HHI',d[ihl:ihl+8])
    if dp!=port: continue
    p=d[ihl+((d[ihl+12]>>4)*4):]
    if not p.startswith(b'GET /v1/socket'): continue
    if (sp,seq) in seen: continue
    seen.add((sp,seq))
    ext='(none offered)'; agent='(no user agent)'
    for line in p.split(b'\r\n'):
        low=line.lower()
        if low.startswith(b'sec-websocket-extensions:'): ext=line.split(b':',1)[1].strip().decode('ascii','replace')[:160]
        if low.startswith(b'user-agent:'): agent=' '.join(part.split('/')[0] for part in line.split(b':',1)[1].strip().decode('ascii','replace').split())[:80]
    with open(out,'a') as f: f.write(f"{time.strftime('%H:%M:%S')} upgrade from {agent}: extensions {ext}\n")

#!/usr/bin/env python3
"""
Whether each client that connects to a host's tailnet listener offers a WebSocket extension, such as compression.

For each upgrade request that reaches the listener on loopback it logs the time, the product names in the client's
User-Agent and the value of Sec-WebSocket-Extensions. Nothing else of the request is read or kept: no token, no address.

    sudo python3 scripts/perf-bench/upgrade-offer-watch.py <the listener's port> <seconds> <log file>

The port is `port` in the host's phone-access.json. Linux only.
"""
import socket
import struct
import sys
import time

listener_port = int(sys.argv[1])
seconds = float(sys.argv[2])
log_path = sys.argv[3]

packets = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(0x0800))
packets.bind(('lo', 0x0800))
packets.settimeout(1)
deadline = time.time() + seconds
logged = set()
while time.time() < deadline:
    try:
        packet, _ = packets.recvfrom(262144)
    except socket.timeout:
        continue
    if len(packet) < 40 or packet[9] != 6:
        continue
    ip_header = (packet[0] & 15) * 4
    source_port, destination_port, sequence = struct.unpack('>HHI', packet[ip_header:ip_header + 8])
    if destination_port != listener_port:
        continue
    payload = packet[ip_header + ((packet[ip_header + 12] >> 4) * 4):]
    if not payload.startswith(b'GET /v1/socket'):
        continue
    # Loopback can show a packet twice; a request is logged once.
    if (source_port, sequence) in logged:
        continue
    logged.add((source_port, sequence))
    offer = '(none offered)'
    products = '(no user agent)'
    for line in payload.split(b'\r\n'):
        name = line.lower()
        if name.startswith(b'sec-websocket-extensions:'):
            offer = line.split(b':', 1)[1].strip().decode('ascii', 'replace')[:160]
        if name.startswith(b'user-agent:'):
            agent = line.split(b':', 1)[1].strip().decode('ascii', 'replace')
            products = ' '.join(product.split('/')[0] for product in agent.split())[:80]
    with open(log_path, 'a') as log:
        log.write(f"{time.strftime('%H:%M:%S')} upgrade from {products}: extensions {offer}\n")

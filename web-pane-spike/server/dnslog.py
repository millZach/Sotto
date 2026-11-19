"""A DNS logger for the seal and network captures: records every question it is asked and answers REFUSED.
Nothing is forwarded anywhere. Run with: python -I dnslog.py --bind 10.99.0.1"""
import argparse, json, socket, struct, sys, threading, time

def qname(data, i=12):
    labels = []
    while i < len(data) and data[i]:
        n = data[i]; labels.append(data[i + 1:i + 1 + n].decode('latin-1')); i += n + 1
    qtype = struct.unpack('>H', data[i + 1:i + 3])[0] if i + 3 <= len(data) else 0
    return '.'.join(labels), qtype

def answer(data):
    # Same id, QR=1, RCODE=5 (REFUSED), question echoed.
    return data[:2] + b'\x81\x05' + data[4:6] + b'\x00\x00\x00\x00\x00\x00' + data[12:]

def udp(bind):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((bind, 53))
    while True:
        data, peer = s.recvfrom(4096)
        name, qtype = qname(data)
        print(json.dumps({'event': 'dns', 'proto': 'udp', 'name': name, 'qtype': qtype, 'peer': peer[0], 't': round(time.time(), 3)}), flush=True)
        s.sendto(answer(data), peer)

def tcp(bind):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((bind, 53)); s.listen(16)
    while True:
        c, peer = s.accept()
        try:
            data = c.recv(4096)[2:]
            name, qtype = qname(data)
            print(json.dumps({'event': 'dns', 'proto': 'tcp', 'name': name, 'qtype': qtype, 'peer': peer[0], 't': round(time.time(), 3)}), flush=True)
            a = answer(data); c.sendall(struct.pack('>H', len(a)) + a)
        except OSError:
            pass
        c.close()

p = argparse.ArgumentParser(); p.add_argument('--bind', required=True); a = p.parse_args()
threading.Thread(target=tcp, args=(a.bind,), daemon=True).start()
udp(a.bind)

#!/usr/bin/env python3
"""
What a running Sotto host sends one connected client, tallied by message type.

Reads the host's side of one loopback WebSocket connection (a desktop paired over SSH arrives on the host's loopback
listener) straight off the `lo` interface, follows the TCP stream, splits it into WebSocket messages, inflates the
compressed ones, and counts frames and bytes by `event`. For shell pushes it also counts bytes by field name.

It keeps counts, sizes and field names only. No message text is written anywhere, and nothing is saved but the JSON
tally printed at the end. It needs root for the packet socket and nothing installed:

    ss -Htnp state established | grep MainThread          # find the host's port and the client's port
    sudo python3 scripts/perf-bench/host-wire-tally.py --host-port 43299 --client-port 58518 --seconds 120

Linux only. A host with no client on loopback (a phone on the tailnet listener) needs `--interface tailscale0`.
"""
import argparse
import json
import socket
import struct
import sys
import time
import zlib
from collections import defaultdict

MAX_MESSAGE = 16 * 1024 * 1024 + 16


def size(value):
    return len(json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))


class Tally:
    def __init__(self):
        self.events = defaultdict(lambda: {'frames': 0, 'wireBytes': 0, 'jsonBytes': 0, 'maxJsonBytes': 0})
        self.shell_state = defaultdict(int)
        self.shell_host = defaultdict(int)
        self.shell_top = defaultdict(int)
        self.record_fields = defaultdict(int)
        self.summary_fields = defaultdict(int)
        self.changed_records = 0
        self.changed_per_push = defaultdict(int)
        self.shells_with_order = 0
        self.shells_with_models = 0
        self.shell_threads_changed = set()
        self.delta_threads = set()
        self.delta_parts = defaultdict(int)
        self.watcher_fields = defaultdict(int)
        self.per_second = defaultdict(int)
        self.resyncs = 0
        self.undecoded = 0
        self.control = defaultdict(int)

    def message(self, text_bytes, wire_bytes, compressed):
        try:
            message = json.loads(text_bytes)
        except Exception:
            self.undecoded += 1
            return False
        if not isinstance(message, dict):
            self.undecoded += 1
            return False
        name = message.get('event')
        if name is None:
            name = 'reply' if 'id' in message else 'other'
        entry = self.events[name]
        entry['frames'] += 1
        entry['wireBytes'] += wire_bytes
        entry['jsonBytes'] += len(text_bytes)
        entry['maxJsonBytes'] = max(entry['maxJsonBytes'], len(text_bytes))
        entry['compressedFrames'] = entry.get('compressedFrames', 0) + (1 if compressed else 0)
        self.per_second[int(time.time())] += wire_bytes
        if name == 'shell':
            self.shell(message)
        elif name == 'detail-delta':
            delta = message.get('delta') or {}
            self.delta_threads.add(message.get('threadId'))
            for key, value in delta.items():
                self.delta_parts[key] += size(value)
        elif name == 'watcher-state' or name == 'watcher-room':
            for key, value in message.items():
                if key != 'event':
                    if isinstance(value, dict):
                        for inner, inner_value in value.items():
                            self.watcher_fields[f'{key}.{inner}'] += size(inner_value)
                    else:
                        self.watcher_fields[key] += size(value)
        return True

    def shell(self, message):
        for key, value in message.items():
            if key != 'event':
                self.shell_top[key] += size(value)
        state = message.get('state') or {}
        for key, value in state.items():
            if key != 'host':
                self.shell_state[key] += size(value)
        host = state.get('host') or {}
        for key, value in host.items():
            self.shell_host[key] += size(value)
        if host.get('models'):
            self.shells_with_models += 1
        threads = message.get('threads') or {}
        changed = threads.get('changed') or []
        self.changed_records += len(changed)
        self.changed_per_push[min(len(changed), 10)] += 1
        if threads.get('order'):
            self.shells_with_order += 1
        for record in changed:
            if not isinstance(record, dict):
                continue
            self.shell_threads_changed.add(record.get('id'))
            for key, value in record.items():
                self.record_fields[key] += size(value)
                if key == 'summary' and isinstance(value, dict):
                    for inner, inner_value in value.items():
                        self.summary_fields[inner] += size(inner_value)

    def report(self, seconds, started):
        def top(table, limit=25):
            return dict(sorted(table.items(), key=lambda item: -item[1])[:limit])
        # Every second of the run, the idle ones too, so the median is the run's and not only its busy seconds'.
        rates = sorted(self.per_second.get(second, 0) for second in range(int(started), int(started) + max(1, int(seconds))))
        total_wire = sum(entry['wireBytes'] for entry in self.events.values())
        total_json = sum(entry['jsonBytes'] for entry in self.events.values())
        return {
            'seconds': seconds,
            'wireBytes': total_wire,
            'jsonBytes': total_json,
            'wireBytesPerSecond': round(total_wire / seconds),
            'wireBytesPerSecondMedian': rates[len(rates) // 2] if rates else 0,
            'wireBytesPerSecondMax': rates[-1] if rates else 0,
            'events': dict(sorted(self.events.items(), key=lambda item: -item[1]['wireBytes'])),
            'control': dict(self.control),
            'shell': {
                'bytesByTopField': top(self.shell_top),
                'bytesByStateField': top(self.shell_state),
                'bytesByHostField': top(self.shell_host),
                'changedRecords': self.changed_records,
                'pushesByChangedRecordCount': dict(sorted(self.changed_per_push.items())),
                'distinctThreadsChanged': len(self.shell_threads_changed),
                'pushesWithOrder': self.shells_with_order,
                'pushesWithModels': self.shells_with_models,
                'bytesByRecordField': top(self.record_fields),
                'bytesBySummaryField': top(self.summary_fields),
            },
            'detailDelta': {'distinctThreads': len(self.delta_threads), 'bytesByField': top(self.delta_parts)},
            'watcher': {'bytesByField': top(self.watcher_fields)},
            'resyncs': self.resyncs,
            'undecoded': self.undecoded,
        }


class Stream:
    """One direction of a TCP connection, in order, split into WebSocket messages."""

    def __init__(self, tally):
        self.tally = tally
        self.expected = None
        self.buffer = bytearray()
        self.pending = {}
        self.fragments = None
        self.confirmed = False

    def segment(self, seq, payload):
        if not payload:
            return
        if self.expected is None:
            if not plausible(payload):
                return
            self.expected = seq
        offset = (seq - self.expected) & 0xFFFFFFFF
        if offset >= 0x80000000:
            behind = 0x100000000 - offset
            if behind >= len(payload):
                return
            payload = payload[behind:]
        elif offset > 0:
            if len(self.pending) < 4096:
                self.pending[seq] = payload
            return
        self.buffer += payload
        self.expected = (self.expected + len(payload)) & 0xFFFFFFFF
        while self.expected in self.pending:
            more = self.pending.pop(self.expected)
            self.buffer += more
            self.expected = (self.expected + len(more)) & 0xFFFFFFFF
        if not self.parse():
            self.tally.resyncs += 1
            self.expected = None
            self.buffer = bytearray()
            self.pending = {}
            self.fragments = None

    def parse(self):
        while True:
            if len(self.buffer) < 2:
                return True
            first, second = self.buffer[0], self.buffer[1]
            opcode = first & 0x0F
            if first & 0x30 or second & 0x80 or opcode not in (0, 1, 2, 8, 9, 10):
                return False
            length = second & 0x7F
            header = 2
            if length == 126:
                if len(self.buffer) < 4:
                    return True
                length = struct.unpack('>H', self.buffer[2:4])[0]
                header = 4
            elif length == 127:
                if len(self.buffer) < 10:
                    return True
                length = struct.unpack('>Q', self.buffer[2:10])[0]
                header = 10
            if length > MAX_MESSAGE:
                return False
            if len(self.buffer) < header + length:
                return True
            payload = bytes(self.buffer[header:header + length])
            del self.buffer[:header + length]
            wire = header + length
            fin = bool(first & 0x80)
            if opcode >= 8:
                self.tally.control[{8: 'close', 9: 'ping', 10: 'pong'}[opcode]] += 1
                continue
            if opcode == 0:
                if self.fragments is None:
                    return False
                self.fragments['parts'].append(payload)
                self.fragments['wire'] += wire
            else:
                self.fragments = {'parts': [payload], 'wire': wire, 'compressed': bool(first & 0x40)}
            if not fin:
                continue
            whole, self.fragments = self.fragments, None
            data = b''.join(whole['parts'])
            if whole['compressed']:
                try:
                    data = zlib.decompressobj(-15).decompress(data + b'\x00\x00\xff\xff')
                except Exception:
                    return False
            if not self.tally.message(data, whole['wire'], whole['compressed']) and not self.confirmed:
                return False
            self.confirmed = True


def plausible(payload):
    """Whether a segment could start a WebSocket frame from a host: unmasked, a known opcode, no RSV2 or RSV3."""
    if len(payload) < 2:
        return False
    first, second = payload[0], payload[1]
    return not (first & 0x30) and not (second & 0x80) and (first & 0x0F) in (1, 9, 10) and bool(first & 0x80 or (first & 0x0F) == 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host-port', type=int, required=True)
    parser.add_argument('--client-port', type=int, required=True)
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--interface', default='lo')
    options = parser.parse_args()
    packets = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(0x0800))
    packets.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 64 * 1024 * 1024)
    packets.bind((options.interface, 0x0800))
    packets.settimeout(0.5)
    tally = Tally()
    stream = Stream(tally)
    started = None
    deadline = time.time() + options.seconds + 30
    while time.time() < deadline:
        try:
            data, _ = packets.recvfrom(262144)
        except socket.timeout:
            if started and time.time() - started >= options.seconds:
                break
            continue
        # A packet seen twice (some loopback setups show it leaving and arriving) is dropped below by its sequence number.
        if len(data) < 40 or data[0] >> 4 != 4 or data[9] != 6:
            continue
        ip_header = (data[0] & 0x0F) * 4
        total = struct.unpack('>H', data[2:4])[0] or len(data)
        source, destination, seq = struct.unpack('>HHI', data[ip_header:ip_header + 8])
        if source != options.host_port or destination != options.client_port:
            continue
        tcp_header = (data[ip_header + 12] >> 4) * 4
        payload = data[ip_header + tcp_header:max(total, ip_header + tcp_header)] if total <= len(data) else data[ip_header + tcp_header:]
        stream.segment(seq, payload)
        if started is None and stream.confirmed:
            started = time.time()
            tally.per_second.clear()
        if started and time.time() - started >= options.seconds:
            break
    elapsed = (time.time() - started) if started else 0
    if not started:
        print(json.dumps({'error': 'never found the start of a message; is the client connected and the host sending?'}))
        sys.exit(1)
    print(json.dumps(tally.report(round(elapsed, 1), started), indent=1))


if __name__ == '__main__':
    main()

"""Quick probe without the Rust window: start the Electron helper on one end of a SOCK_SEQPACKET pair, receive frame
records and their descriptors, ack each, and report what arrived. Usage: python -I probe.py <electron> <helper-dir>
<run-dir> <seconds> [electron switches...]"""
import array, hashlib, mmap, fcntl, json, os, socket, struct, subprocess, sys, threading, time
electron, helper, run, secs = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
extra = sys.argv[5:]
os.makedirs(run, exist_ok=True)
ours, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
env = dict(os.environ, WPE_SPAWNED_MS=str(int(time.time() * 1000)), WPE_SOCK_FD=str(theirs.fileno()))
for k in ('WPE_FORMAT', 'WPE_VIEW'):
    if k in os.environ: env[k] = os.environ[k]
p = subprocess.Popen([electron, helper, f'--user-data-dir={run}/profile', *extra], stdin=subprocess.PIPE, stdout=open(f'{run}/helper.jsonl', 'w'),
                     stderr=open(f'{run}/helper.stderr', 'w'), env=env, pass_fds=(theirs.fileno(),))
theirs.close()
frames, fds, first = 0, 0, None
samples = []
def cpu_sample(fd, stride, w, h, size):
    # A linear dmabuf maps: read a 32x20 grid of pixels, bracketed by DMA_BUF_IOCTL_SYNC.
    try:
        m = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ)
    except OSError as e:
        return {'mmap_error': str(e)}
    try:
        try: fcntl.ioctl(fd, 0x40086200, struct.pack('<Q', 1 | 4))  # SYNC_START | READ
        except OSError: pass
        px = []
        for gy in range(20):
            for gx in range(32):
                o = (gy * h // 20 + h // 40) * stride + (gx * w // 32 + w // 64) * 4
                px.append(m[o:o + 4])
        try: fcntl.ioctl(fd, 0x40086200, struct.pack('<Q', 2 | 4))
        except OSError: pass
        raw = b''.join(px)
        nonblack = sum(1 for p in px if max(p[0], p[1], p[2]) > 16)
        return {'nonblack': nonblack, 'of': len(px), 'allzero': raw.count(0) == len(raw), 'hash': hashlib.sha1(raw).hexdigest()[:10], 'p0': list(px[0])}
    finally:
        m.close()
rec = {}
def reader():
    global frames, fds, first
    while True:
        try: data, anc, _, _ = ours.recvmsg(64, socket.CMSG_SPACE(4))
        except OSError: return
        if not data: return
        f = struct.unpack('<16I', data)
        fd = None
        for lvl, typ, d in anc:
            if lvl == socket.SOL_SOCKET and typ == socket.SCM_RIGHTS: fd = array.array('i', d[:4])[0]
        frames += 1
        if fd is not None:
            fds += 1
            if first is None:
                first = {'w': f[1], 'h': f[2], 'stride': f[3], 'modifier': hex(f[6] | f[7] << 32), 'format': f[8], 'size': f[10], 'planes': f[12], 'fd_target': os.readlink(f'/proc/self/fd/{fd}')}
            if fds % 30 == 0 and len(samples) < 12:
                samples.append(cpu_sample(fd, f[3], f[1], f[2], f[10] | f[11] << 32))
            os.close(fd)
        try: p.stdin.write(f'A {f[9]}\n'.encode()); p.stdin.flush()
        except OSError: return
t = threading.Thread(target=reader, daemon=True); t.start()
time.sleep(secs)
p.stdin.close()
try: p.wait(10)
except subprocess.TimeoutExpired: p.kill(); p.wait()
ours.close()
res = {'frames': frames, 'fds': fds, 'first': first, 'cpu_samples': samples, 'exit': p.returncode, 'args': extra, 'format': os.environ.get('WPE_FORMAT', 'argb')}
json.dump(res, open(f'{run}/probe.json', 'w'), indent=1)
print(json.dumps(res))

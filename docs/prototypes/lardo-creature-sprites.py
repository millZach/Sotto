"""Lardo sprite generator (prototype tooling). Rasterizes a pose skeleton onto the creature's 40x32 grid,
outlines and shades it, and prints letter rows. Letters: k outline, n hair, s skin, h highlight, d shade,
t thong, u thong shade, w teeth, e eye, r angry flush, c chunk (composer), C chunk edge."""
import json, math, struct, sys, zlib

W, H = 40, 32
CX = 20.5  # column 20 is the centre line


def blank():
    return [[None] * W for _ in range(H)]


def cells():
    for y in range(H):
        for x in range(W):
            yield x, y, x + 0.5, y + 0.5


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    L = vx * vx + vy * vy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / L))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy)), t


class Sprite:
    def __init__(self):
        self.g = blank()
        self.locked = set()  # cells set by detail, not reshaded

    def put(self, x, y, ch, lock=False):
        if 0 <= x < W and 0 <= y < H:
            self.g[y][x] = ch
            if lock:
                self.locked.add((x, y))

    def capsule(self, a, b, r0, r1=None, ch='s'):
        r1 = r0 if r1 is None else r1
        for x, y, px, py in cells():
            d, t = seg_dist(px, py, *a, *b)
            if d <= r0 + (r1 - r0) * t:
                self.g[y][x] = ch

    def circle(self, c, r, ch='s'):
        self.capsule(c, c, r, r, ch)

    def ellipse(self, c, rx, ry, ch='s'):
        for x, y, px, py in cells():
            if ((px - c[0]) / rx) ** 2 + ((py - c[1]) / ry) ** 2 <= 1:
                self.g[y][x] = ch

    def poly(self, pts, ch='s'):
        n = len(pts)
        for x, y, px, py in cells():
            inside = False
            for i in range(n):
                (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
                if (y1 > py) != (y2 > py) and px < (x2 - x1) * (py - y1) / (y2 - y1) + x1:
                    inside = not inside
            if inside:
                self.g[y][x] = ch

    def finish(self, outline=True):
        g = self.g
        filled = lambda x, y: 0 <= x < W and 0 <= y < H and g[y][x] not in (None, 'k')
        # shading on skin and thong that detail did not set
        out = [row[:] for row in g]
        for y in range(H):
            for x in range(W):
                ch = g[y][x]
                if ch not in ('s', 't') or (x, y) in self.locked:
                    continue
                up, left = filled(x, y - 1), filled(x - 1, y)
                right, down = filled(x + 1, y), filled(x, y + 1)
                if ch == 's':
                    if not right or not down:
                        out[y][x] = 'd'
                    elif not up or not left:
                        out[y][x] = 'h'
                else:
                    if not right or not down:
                        out[y][x] = 'u'
        if outline:
            for y in range(H):
                for x in range(W):
                    if out[y][x] is None and any(filled(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                        out[y][x] = 'k'
        return [''.join(c or '.' for c in row) for row in out]


def mirror_x(x):
    return 2 * CX - x


def sym(fn):
    """Call fn(sign) for both sides."""
    fn(-1)
    fn(1)


# ---------------------------------------------------------------- body parts

def legs(sp, lift=0, squat=0, stance=0.0, forward=None):
    """Thick quads, diamond calves. lift: 1 = viewer-left leg up a unit, -1 = right. forward: side whose leg steps forward (bent)."""
    def leg(s):
        up = (1 if (lift == -1 and s == -1) or (lift == 1 and s == 1) else 0)
        hip = (CX + s * 2.4, 21.5 + squat)
        knee = (CX + s * (3.3 + stance), 26.4 + squat * 0.5 - up)
        ankle = (CX + s * (3.2 + stance), 30.2 - up)
        sp.capsule(hip, knee, 2.5, 1.7)
        sp.circle((CX + s * (3.9 + stance * 0.5), 23.6 + squat), 2.0)  # quad sweep
        sp.capsule(knee, ankle, 1.45, 0.9)
        sp.circle((CX + s * (3.9 + stance), 27.9 + squat * 0.3 - up), 1.25)  # calf
        fx = CX + s * (3.2 + stance)
        for x in range(int(min(fx, fx + s * 2.2)), int(max(fx, fx + s * 2.2)) + 1):
            sp.put(x, int(30.6 - up), 's')
            sp.put(x, int(31.4 - up), 's')
    sym(leg)


def torso(sp, sh=7.2, waist=3.3, lats=0.0, vac=False, drop=0):
    y0 = 11.2 + drop
    w = waist - (0.9 if vac else 0)
    sp.poly([(CX - sh, y0), (CX + sh, y0), (CX + sh - 0.6 + lats, y0 + 3.8), (CX + w + 0.4, y0 + 8.6),
             (CX + w + 0.7, y0 + 10.3), (CX - w - 0.7, y0 + 10.3), (CX - w - 0.4, y0 + 8.6), (CX - sh + 0.6 - lats, y0 + 3.8)])
    sym(lambda s: sp.circle((CX + s * (sh - 0.4), y0 + 1.4), 2.2))  # delts
    if lats:
        sym(lambda s: sp.ellipse((CX + s * (sh - 1.8 + lats * 0.6), y0 + 4.0), 2.2, 2.8))
    sp.capsule((CX - 3, y0 - 0.4), (CX + 3, y0 - 0.4), 1.5)  # traps


def thong(sp, drop=0, back=False):
    y = 20.9 + drop
    if back:
        for x in range(int(CX - 3.6), int(CX + 3.6) + 1):
            sp.put(x, int(y), 't', True)
        sp.put(int(CX), int(y) + 1, 't', True)
        sp.put(int(CX), int(y) + 2, 'u', True)
        return
    sp.poly([(CX - 3.9, y - 0.4), (CX + 3.9, y - 0.4), (CX + 3.9, y + 0.7), (CX + 1.4, y + 2.6),
             (CX - 1.4, y + 2.6), (CX - 3.9, y + 0.7)], 't')


def head(sp, cy=7.0, cx=CX, face='grin', back=False, turn=0):
    sp.ellipse((cx, cy), 2.6, 3.0)
    sp.capsule((cx, cy + 2), (cx, cy + 4.2), 1.6)  # neck
    ix = int(cx)
    for x in range(ix - 2, ix + 3):  # hair, flat-top
        sp.put(x, int(cy - 3), 'n', True)
        sp.put(x, int(cy - 2), 'n', True)
    if back:
        for x in range(ix - 2, ix + 3):
            sp.put(x, int(cy - 1), 'n', True)
        return
    ey = int(cy)
    if turn:
        sp.put(ix + turn, ey, 'e', True)
        sp.put(ix + 2 * turn, ey, 'e', True) if False else None
        sp.put(ix + turn, ey + 2, 'w' if face != 'grit' else 'k', True)
        sp.put(ix + 2 * turn, ey + 2, 'w', True)
        return
    sp.put(ix - 1, ey, 'e', True)
    sp.put(ix + 1, ey, 'e', True)
    if face == 'grin':
        for x in range(ix - 1, ix + 2):
            sp.put(x, ey + 2, 'w', True)
    elif face == 'grit':  # clenched, brows down
        sp.put(ix - 1, ey - 1, 'k', True)
        sp.put(ix + 1, ey - 1, 'k', True)
        for x in range(ix - 1, ix + 2):
            sp.put(x, ey + 2, 'w', True)
        sp.put(ix, ey + 2, 'k', True)
    elif face == 'angry':
        sp.put(ix - 2, ey - 1, 'k', True)
        sp.put(ix - 1, ey - 1, 'k', True) if False else None
        sp.put(ix + 2, ey - 1, 'k', True)
        for x in range(ix - 1, ix + 2):
            sp.put(x, ey + 2, 'w', True)
            sp.put(x, ey + 1, 'r', True) if False else None
        sp.put(ix - 2, ey + 1, 'r', True)
        sp.put(ix + 2, ey + 1, 'r', True)
    elif face == 'o':  # vacuum, breath held
        sp.put(ix, ey + 2, 'k', True)


def arm(sp, s, shoulder, elbow, wrist, bicep=None, fist=1.25):
    sp.capsule(shoulder, elbow, 1.8, 1.4)
    if bicep:
        sp.circle(bicep[0], bicep[1])
    sp.capsule(elbow, wrist, 1.5, 1.1)
    sp.circle(wrist, fist)


def abs_detail(sp, drop=0, strong=False):
    ix = int(CX)
    for y in range(16 + drop, 20 + drop):
        sp.put(ix, y, 'd', True)
    for y in (17 + drop, 19 + drop) if not strong else (16 + drop, 18 + drop, 20 + drop):
        sp.put(ix - 1, y, 'd', True)
        sp.put(ix + 1, y, 'd', True)


def pec_detail(sp, drop=0):
    ix = int(CX)
    for y in range(12 + drop, 15 + drop):
        sp.put(ix, y, 'd', True)
    for dx in range(1, 5):
        sp.put(ix - dx, 14 + drop + (1 if dx > 3 else 0), 'd', True)
        sp.put(ix + dx, 14 + drop + (1 if dx > 3 else 0), 'd', True)
    sp.put(ix - 3, 12 + drop, 'h', True)
    sp.put(ix + 2, 12 + drop, 'h', True)


def back_detail(sp, drop=0):
    ix = int(CX)
    for y in range(12 + drop, 20 + drop):
        sp.put(ix, y, 'd', True)
    for dx in (3, 4):
        sp.put(ix - dx, 16 + drop, 'd', True)
        sp.put(ix + dx, 16 + drop, 'd', True)
    # glutes split under the band
    sp.put(ix, 22 + drop, 'd', True)


def oil(sp, pts):
    for x, y in pts:
        sp.put(x, y, 'h', True)


# ---------------------------------------------------------------- poses
SH = (7.0, 12.4)


def shoulders(s, drop=0):
    return (CX + s * SH[0], SH[1] + drop)


def p_front_double_biceps(pump=False, face='grin', back=False):
    sp = Sprite()
    legs(sp, stance=0.3)
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 12.0, 11.8), (CX + s * 9.4, 6.4),
                      bicep=((CX + s * 10.0, 9.8 - (0.5 if pump else 0)), 2.3 + (0.4 if pump else 0)), fist=1.4))
    torso(sp)
    thong(sp, back=back)
    head(sp, face=face, back=back)
    if back:
        back_detail(sp)
    else:
        pec_detail(sp)
        abs_detail(sp)
    oil(sp, [(int(CX - 9.6), 9), (int(CX + 9.6), 9)])
    return sp.finish()


def p_front_lat_spread(back=False):
    sp = Sprite()
    legs(sp, stance=0.4)
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 10.6, 16.2), (CX + s * 4.6, 19.6), fist=1.2))
    torso(sp, sh=7.6, lats=1.6)
    thong(sp, back=back)
    head(sp, face='grin' if not back else 'grin', back=back)
    if back:
        back_detail(sp)
    else:
        pec_detail(sp)
        abs_detail(sp)
    return sp.finish()


def p_most_muscular(face='grit', flush=False):
    sp = Sprite()
    legs(sp, stance=0.6, squat=0)
    sym(lambda s: arm(sp, s, shoulders(s, 0.4), (CX + s * 9.4, 17.0), (CX + s * 1.6, 19.2),
                      bicep=((CX + s * 9.0, 14.6), 1.9), fist=1.4))
    torso(sp, sh=7.4)
    sp.capsule((CX - 4, 10.4), (CX + 4, 10.4), 2.1)  # traps up
    thong(sp)
    head(sp, cy=7.6, face=face)
    pec_detail(sp)
    g = sp.finish()
    if flush:
        g = [row for row in g]
        # flush the face
        out = []
        for y, row in enumerate(g):
            r = list(row)
            for x in range(int(CX) - 2, int(CX) + 3):
                if y == 8 and r[x] in 'shd':
                    r[x] = 'r'
            out.append(''.join(r))
        g = out
    return g


def p_abdominal_thigh():
    sp = Sprite()
    # one leg forward: viewer-right leg out
    legs(sp, stance=0.2)
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 6.6, 4.2), (CX + s * 2.4, 4.8), fist=1.1))
    torso(sp, sh=7.0)
    thong(sp)
    head(sp, face='grit')
    abs_detail(sp, strong=True)
    pec_detail(sp)
    return sp.finish()


def p_vacuum(tremble=0):
    sp = Sprite()
    legs(sp, stance=0.2)
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 6.8, 6.4), (CX + s * 1.6, 2.4 + tremble), fist=1.2))
    torso(sp, sh=7.0, vac=True)
    thong(sp)
    head(sp, face='o')
    pec_detail(sp)
    # sucked-in belly: a shaded hollow
    ix = int(CX)
    for y in (17, 18):
        for x in range(ix - 1, ix + 2):
            sp.put(x, y, 'd', True)
    return sp.finish()


def p_side(kind='chest', facing=1, face='grin'):
    """Three-quarter view turned right (mirrored for left): chest pushed out toward the facing side."""
    sp = Sprite()
    # rear leg straight, front leg bent forward on its toes
    sp.capsule((CX - 1.8, 21.4), (CX - 2.6, 26.4), 2.6, 1.7)
    sp.circle((CX - 3.0, 23.6), 2.0)
    sp.capsule((CX - 2.6, 26.4), (CX - 2.6, 30.4), 1.45, 0.9)
    sp.circle((CX - 3.4, 28.0), 1.3)
    for x in range(int(CX - 4.2), int(CX - 1.2)):
        sp.put(x, 31, 's')
    sp.capsule((CX + 2.0, 21.4), (CX + 4.2, 26.0), 2.6, 1.7)
    sp.circle((CX + 4.0, 23.2), 2.1)
    sp.capsule((CX + 4.2, 26.0), (CX + 3.6, 30.4), 1.4, 0.9)
    sp.circle((CX + 3.0, 27.8), 1.25)
    for x in range(int(CX + 3), int(CX + 6)):
        sp.put(x, 31, 's')
    if kind == 'triceps':
        # rear arm reaches behind the back to clasp the front wrist
        arm(sp, -1, (CX - 5.4, 12.8), (CX - 7.2, 17.4), (CX - 4.0, 20.6), fist=1.1)
    else:
        arm(sp, -1, (CX - 5.4, 12.8), (CX - 7.6, 16.8), (CX - 3.4, 18.4), fist=1.2)
    sp.poly([(CX - 6.0, 11.2), (CX + 6.0, 11.2), (CX + 7.0, 13.6), (CX + 4.8, 18.0), (CX + 3.4, 20.2),
             (CX + 3.6, 21.6), (CX - 3.6, 21.6), (CX - 3.4, 19.4), (CX - 5.6, 15.4)])
    sp.circle((CX - 5.6, 12.6), 2.0)  # rear delt
    sp.capsule((CX - 3, 10.8), (CX + 2.4, 10.8), 1.5)  # traps
    if kind == 'chest':
        sp.circle((CX + 3.4, 13.8), 3.4)  # chest thrown out
        sp.circle((CX + 6.2, 12.6), 2.3)  # front delt
        # front arm: elbow down and out, forearm back across the abs, fist met by the rear hand
        arm(sp, 1, (CX + 6.6, 13.0), (CX + 9.2, 17.6), (CX + 0.6, 18.6), bicep=((CX + 8.8, 15.2), 2.3), fist=1.4)
    else:
        sp.circle((CX + 3.0, 14.0), 3.0)
        sp.circle((CX + 6.0, 12.6), 2.3)
        # front arm locked straight down the side; the triceps bulge faces the viewer's left (behind the arm)
        arm(sp, 1, (CX + 6.4, 13.2), (CX + 7.2, 18.0), (CX + 6.2, 21.6), fist=1.2)
        sp.ellipse((CX + 5.4, 16.0), 1.9, 2.7)  # triceps horseshoe
    thong_y = 20.9
    sp.poly([(CX - 3.8, thong_y - 0.4), (CX + 3.8, thong_y - 0.4), (CX + 3.8, thong_y + 0.7), (CX + 2.6, thong_y + 2.4),
             (CX + 0.2, thong_y + 2.2), (CX - 3.8, thong_y + 0.7)], 't')
    hx = CX + 0.6
    sp.ellipse((hx, 7.0), 2.6, 3.0)
    sp.capsule((hx - 0.2, 9), (hx - 0.6, 11.2), 1.6)
    ix = int(hx)
    for x in range(ix - 2, ix + 3):
        sp.put(x, 4, 'n', True)
        sp.put(x, 5, 'n', True)
    sp.put(ix - 2, 6, 'n', True)
    sp.put(ix - 2, 7, 'n', True)
    sp.put(ix, 7, 'e', True)
    sp.put(ix + 2, 7, 'e', True)
    sp.put(ix + 3, 8, 's', True)  # nose
    for x in (ix, ix + 1, ix + 2):
        sp.put(x, 9, 'w', True)
    if kind == 'chest':
        for x in range(int(CX + 1), int(CX + 6)):
            sp.put(x, 16, 'd', True)
        oil(sp, [(int(CX + 2), 12), (int(CX + 3), 12), (int(CX + 9), 14)])
    else:
        for y in range(14, 19):
            sp.put(int(CX + 4), y, 'd', True)
        oil(sp, [(int(CX + 2), 12), (int(CX + 6), 11)])
    rows = sp.finish()
    if facing < 0:
        rows = ['.' + row[::-1][:-1] for row in rows]
    return rows


def p_walk(step):
    sp = Sprite()
    legs(sp, lift=(1 if step == 0 else -1 if step == 2 else 0), stance=0.3)
    swing = (-1, 0, 1, 0)[step]
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 9.6, 16.4 + swing * s * 0.6), (CX + s * 9.4, 20.2 + swing * s * 0.6), fist=1.2))
    torso(sp, sh=7.4, lats=1.4)
    thong(sp)
    head(sp, face='grin')
    pec_detail(sp)
    abs_detail(sp)
    return sp.finish()


def p_grab():
    """Bent down, reaching to the composer's edge at his right."""
    sp = Sprite()
    legs(sp, squat=1.2, stance=1.0)
    arm(sp, -1, shoulders(-1, 1.6), (CX - 10, 18.8), (CX - 8.6, 22.2), fist=1.2)
    arm(sp, 1, shoulders(1, 1.6), (CX + 10.4, 18.0), (CX + 13.4, 26.6), fist=1.4)
    torso(sp, drop=1)
    thong(sp, drop=1)
    head(sp, cy=8.4, face='angry')
    pec_detail(sp, drop=1)
    return sp.finish()


def p_lift():
    """Chunk held overhead in both hands."""
    sp = Sprite()
    legs(sp, stance=0.6)
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 8.4, 7.0), (CX + s * 5.6, 2.4), bicep=((CX + s * 8.2, 9.4), 1.9), fist=1.2))
    torso(sp)
    thong(sp)
    head(sp, face='angry')
    pec_detail(sp)
    abs_detail(sp)
    return sp.finish()


def p_throw():
    """Follow-through: both arms flung forward and out, chunk gone."""
    sp = Sprite()
    legs(sp, stance=0.9)
    sym(lambda s: arm(sp, s, shoulders(s), (CX + s * 11.0, 13.2), (CX + s * 14.6, 10.2), fist=1.3))
    torso(sp)
    thong(sp)
    head(sp, face='angry')
    pec_detail(sp)
    abs_detail(sp)
    return sp.finish()


def mini(step):
    """A tiny Lardo on a 12 x 10 grid, flexing as he jogs: arms up, two-frame legs."""
    rows = [
        '....kkkk....',
        '....knnk....',
        'kk..kssk..kk',
        'ksk.kssk.ksk',
        'kssksssskssk',
        '.kssssssssk.',
        '..kssssssk..',
        '...kttttk...',
        '..ksk..ksk..' if step else '...kskksk...',
        '..kk....kk..' if step else '...kk..kk...',
    ]
    return rows


POSES = {
    'frontDoubleBiceps': p_front_double_biceps(),
    'frontDoubleBicepsPump': p_front_double_biceps(pump=True, face='grit'),
    'frontLatSpread': p_front_lat_spread(),
    'sideChest': p_side('chest'),
    'sideChestLeft': p_side('chest', facing=-1),
    'backDoubleBiceps': p_front_double_biceps(back=True),
    'backLatSpread': p_front_lat_spread(back=True),
    'sideTriceps': p_side('triceps'),
    'sideTricepsLeft': p_side('triceps', facing=-1),
    'abdominalThigh': p_abdominal_thigh(),
    'mostMuscular': p_most_muscular(),
    'mostMuscularAngry': p_most_muscular(face='angry', flush=True),
    'vacuum': p_vacuum(),
    'vacuumHold': p_vacuum(tremble=-0.6),
    'walk0': p_walk(0), 'walk1': p_walk(1), 'walk2': p_walk(2), 'walk3': p_walk(3),
    'grab': p_grab(), 'lift': p_lift(), 'throw': p_throw(),
    'mini0': mini(0), 'mini1': mini(1),
}

PAL = {
    'k': (40, 26, 22), 'n': (52, 34, 26), 's': (227, 181, 142), 'h': (246, 214, 186), 'd': (178, 126, 92),
    't': (122, 162, 247), 'u': (82, 112, 190), 'w': (245, 245, 240), 'e': (40, 26, 22), 'r': (226, 92, 80),
}


def png(path, sheet, scale):
    hgt, wid = len(sheet), len(sheet[0])
    raw = b''
    for row in sheet:
        line = b''.join(bytes(PAL.get(c, (30, 30, 46))) * scale for c in row)
        raw += (b'\x00' + line) * scale
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', wid * scale, hgt * scale, 8, 2, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)


if __name__ == '__main__':
    names = [n for n in POSES if not n.startswith('mini')]
    per = 6
    sheet = []
    for i in range(0, len(names), per):
        group = names[i:i + per]
        for y in range(H):
            sheet.append(' '.join(POSES[n][y] for n in group).ljust(per * 41))
        sheet.append(' ' * (per * 41))
    png('/tmp/lardo-work/sheet.png', sheet, 5)
    json.dump(POSES, open('/tmp/lardo-work/poses.json', 'w'))
    print('\n'.join(names))

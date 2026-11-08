"""Keeps the Duo captures' pictures and cuts their clips, for duo-captures.sh.

`duo-captures-collect.py <posture>` reads that posture's test log for `DUO-SHOT name time` marks and keeps the frame
grabbed nearest each one, and for `DUO-CLIP-START` / `DUO-CLIP-END` pairs cuts that stretch of the posture's video to a
small MP4 where the runner has ffmpeg, and otherwise leaves the marks beside the video. `--manifest` writes
out/manifest.json listing what was kept. `--cut <folder>` cuts the marked clips of a downloaded run on any computer.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path('.build-duo')
OUT = ROOT / 'out'


def collect(posture: str) -> None:
    log = (OUT / f'{posture}.log').read_text(errors='replace')
    frames = sorted((float(f.stem), f) for f in (ROOT / 'frames').glob('*.png'))
    seen = set()
    for name, at in re.findall(r'DUO-SHOT (\S+) ([0-9.]+)', log):
        if name in seen:
            continue
        seen.add(name)
        at = float(at)
        # The test holds still for five seconds after a mark. A frame is named for when its screenshot began, and one can
        # take a second or two, so keep one that began early enough to end before the page moves on.
        near = [(abs(t - (at + 1.5)), f) for t, f in frames if at + 0.5 <= t <= at + 3.0]
        if not near:
            print(f'{name}: no frame')
            continue
        shutil.copy(min(near)[1], OUT / 'shots' / f'{name}.png')
        print(f'{name}: kept')

    video = OUT / 'videos' / f'{posture}.mov'
    start_file = OUT / 'videos' / f'{posture}.start'
    starts = dict(re.findall(r'DUO-CLIP-START (\S+) ([0-9.]+)', log))
    ends = dict(re.findall(r'DUO-CLIP-END (\S+) ([0-9.]+)', log))
    if not starts:
        return
    if not (video.exists() and start_file.exists() and shutil.which('ffmpeg')):
        print(f'{posture}: clips not cut (video {video.exists()}, ffmpeg {bool(shutil.which("ffmpeg"))})')
        (OUT / 'clips' / f'{posture}-marks.json').write_text(json.dumps({'start': start_file.read_text().strip() if start_file.exists() else None,
                                                                         'clips': {k: [starts[k], ends.get(k)] for k in starts}}, indent=2))
        return
    cut_clips(video, float(start_file.read_text().strip()), {k: (starts[k], ends[k]) for k in starts if k in ends}, OUT / 'clips')


def cut_clips(video: Path, origin: float, clips: dict, into: Path) -> None:
    for name, (begin, end) in clips.items():
        a = max(0.0, float(begin) - origin)
        length = max(1.0, float(end) - float(begin))
        # Small enough to link from a pull request: 720 pixels high, H.264, no sound.
        result = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{a:.2f}', '-t', f'{length:.2f}', '-i', str(video),
                                 '-vf', 'scale=-2:720', '-an', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
                                 '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(into / f'{name}.mp4')], capture_output=True, text=True)
        print(f'{name}: {"cut" if result.returncode == 0 else "not cut: " + result.stderr.strip()[:200]}')


def cut_downloaded(folder: Path) -> None:
    for marks in sorted((folder / 'clips').glob('*-marks.json')):
        posture = marks.name.removesuffix('-marks.json')
        video = folder / 'videos' / f'{posture}.mov'
        if not video.exists():
            print(f'{posture}: no video')
            continue
        data = json.loads(marks.read_text())
        clips = {k: v for k, v in data['clips'].items() if v[1]}
        cut_clips(video, float(data['start']), clips, folder / 'clips')


def manifest() -> None:
    kept = {
        'shots': sorted(p.name for p in (OUT / 'shots').glob('*.png')),
        'clips': sorted(p.name for p in (OUT / 'clips').glob('*.mp4')),
    }
    (OUT / 'manifest.json').write_text(json.dumps(kept, indent=2))
    print(f"{len(kept['shots'])} pictures and {len(kept['clips'])} clips kept")


if __name__ == '__main__':
    if sys.argv[1] == '--manifest':
        manifest()
    elif sys.argv[1] == '--cut':
        cut_downloaded(Path(sys.argv[2]))
    else:
        collect(sys.argv[1])

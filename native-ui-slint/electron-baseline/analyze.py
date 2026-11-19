#!/usr/bin/env python3
"""analyze.py <run-dir>...: figures for each stream, launch or edit run, with the same statistics as the Slint build's
metrics.rs (percentile = sorted[round((n-1)*q)]). Prints JSON."""
import json
import os
import sys


def stats(values):
    if not values:
        return None
    s = sorted(values)
    p = lambda q: s[round((len(s) - 1) * q)]
    return {'n': len(s), 'median': round(p(0.5), 2), 'p95': round(p(0.95), 2), 'p99': round(p(0.99), 2), 'max': round(s[-1], 2),
            'mean': round(sum(s) / len(s), 2), 'over_16_7': sum(1 for x in s if x > 16.7), 'over_33_3': sum(1 for x in s if x > 33.3)}


def load(run, name):
    with open(os.path.join(run, name)) as f:
        return json.load(f)


def conditions(run):
    out = {}
    with open(os.path.join(run, 'conditions.txt')) as f:
        for line in f:
            k, v = line.rstrip('\n').split(' ', 1)
            out[k] = v
    return out


def stream(run):
    r = load(run, 'renderer.json')
    times = load(run, 'stream-times.json')
    origin = r['origin']
    start, end = times['startEpochMs'] - origin, times['endEpochMs'] - origin
    # Every rAF from the first chunk to the last (on the renderer's clock; the stream's ends are the fake CLI's
    # first and last write, converted through the shared epoch).
    pairs = [(ts, now) for ts, now in zip(r['raf'], r['rafNow']) if start <= now <= end]
    ts = [a for a, _ in pairs]
    nows = [b for _, b in pairs]
    intervals = [b - a for a, b in zip(ts, ts[1:])]
    callback_intervals = [b - a for a, b in zip(nows, nows[1:])]
    longtasks = [t for t in r['longtasks'] if 'start' in t and start <= t['start'] <= end]
    typing = [t['paint'] - t['key'] for t in r['typing']]
    typing_from_event = [t['paint'] - t['stamp'] for t in r['typing']]
    key_events = [e for e in r['events'] if e.get('name') == 'keydown']
    mem = load(run, 'memory.json')
    window_renderer = load(run, 'main.json').get('mainWindowRendererPid')
    main_window_renderer = next(({'pss_kib': p.get('pss'), 'rss_kib': p.get('rss')} for p in mem['processes'] if p['pid'] == window_renderer), None)
    return {
        'run': os.path.basename(run),
        'conditions': conditions(run),
        'stream_ms': round(times['endEpochMs'] - times['startEpochMs'], 1),
        'stream_ticks': times['ticks'],
        'tick_lateness_ms': times['tickLatenessMs'],
        'frame_interval_ms': stats(intervals),
        'frame_interval_callback_clock_ms': stats(callback_intervals),
        'longtasks': {'count': len(longtasks), 'total_ms': round(sum(t['duration'] for t in longtasks), 1),
                      'max_ms': round(max((t['duration'] for t in longtasks), default=0), 1)},
        'typing_ms': stats(typing),
        'typing_from_event_timestamp_ms': stats(typing_from_event),
        'keys_seen': r['keys'],
        'composer_text_length': r['composerTextLength'],
        'event_timing_keydown_ms': stats([e['duration'] for e in key_events]),
        'event_timing_all_names': sorted({e.get('name') for e in r['events'] if 'name' in e}),
        'event_timing_errors': [e['error'] for e in r['events'] if 'error' in e],
        'viewport': [r['innerWidth'], r['innerHeight'], r['devicePixelRatio']],
        'memory_5s_after': {'total_pss_kib': mem['total_pss_kib'], 'total_rss_kib': mem['total_rss_kib'],
                            'process_count': mem['process_count'], 'by_type': mem['by_type'], 'main_window_renderer': main_window_renderer,
                            'excluded': [{'program': e['program'], 'pss': e.get('pss'), 'rss': e.get('rss')} for e in mem['excluded_non_electron_children']]},
    }


def launch(run):
    l = load(run, 'launch.json')
    t0_ms = int(open(os.path.join(run, 't0_ns')).read()) / 1e6
    extra = {}
    edit = os.path.join(run, 'edit_t0_ns')
    if os.path.exists(edit):
        e0 = int(open(edit).read()) / 1e6
        extra = {'edit_to_first_raf_ms': round(l['rafCallbackEpochMs'] - e0, 1), 'edit_to_after_paint_ms': round(l['paintEpochMs'] - e0, 1),
                 'build_ms': int(open(os.path.join(run, 'build_ms')).read())}
    return {'run': os.path.basename(run), 'conditions': conditions(run), **extra,
            # The rAF callback's own clock; the frame timestamp rAF is given is the frame's begin time, which can come
            # before the DOM change that the frame then shows.
            'launch_to_first_raf_ms': round(l['rafCallbackEpochMs'] - t0_ms, 1),
            'launch_to_first_raf_frame_timestamp_ms': round(l['rafEpochMs'] - t0_ms, 1),
            'launch_to_after_paint_ms': round(l['paintEpochMs'] - t0_ms, 1),
            'launch_to_thread_in_dom_ms': round(l['foundEpochMs'] - t0_ms, 1),
            'viewport': [l['innerWidth'], l['innerHeight'], l['devicePixelRatio']]}


out = []
for run in sys.argv[1:]:
    base = os.path.basename(run.rstrip('/'))
    if base.startswith('stream'):
        out.append(stream(run))
    elif base.startswith(('launch', 'rebuild')):
        out.append(launch(run))
    elif base.startswith('hmr'):
        out.append({'run': base, 'conditions': conditions(run), **load(run, 'edit.json')})
print(json.dumps(out, indent=1))

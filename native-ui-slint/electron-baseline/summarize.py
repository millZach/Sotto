#!/usr/bin/env python3
"""summarize.py: runs analyze.py over the measured runs in runs/ and writes results.json (every run plus the median of
runs for each figure). Launch run 0 is the warm-up and is kept but not in the median."""
import json
import os
import statistics
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
runs = lambda prefix: sorted(os.path.join(here, 'runs', d) for d in os.listdir(os.path.join(here, 'runs')) if d.startswith(prefix))
analyse = lambda paths: json.loads(subprocess.run([sys.executable, os.path.join(here, 'analyze.py'), *paths], check=True, capture_output=True, text=True).stdout)
med = lambda xs: round(statistics.median(xs), 2)

stream = analyse(runs('stream-'))
launch = analyse(runs('launch-'))
hmr = analyse(runs('hmr-'))
rebuild = analyse(runs('rebuild-'))
counted_launch = [r for r in launch if r['run'] != 'launch-0']


def median_of(rows, *path):
    def get(r):
        for p in path:
            r = r[p]
        return r
    return med([get(r) for r in rows])


stat_keys = ['median', 'p95', 'p99', 'max', 'mean', 'over_16_7', 'over_33_3', 'n']
hmr_runs = [x for r in hmr for x in r['runs']]
result = {
    'subject': 'Electron Sotto (origin/main 61f9e269b, package 0.1.43, Electron 43.8.3 / Chromium 150) on forge, Wayland-native in a nested Hyprland at 1280x800, scale 1',
    'medians_of_runs': {
        'frame_interval_ms': {k: median_of(stream, 'frame_interval_ms', k) for k in stat_keys},
        'frame_interval_callback_clock_ms': {k: median_of(stream, 'frame_interval_callback_clock_ms', k) for k in stat_keys},
        'longtasks_during_stream': {k: median_of(stream, 'longtasks', k) for k in ['count', 'total_ms', 'max_ms']},
        'typing_ms': {k: median_of(stream, 'typing_ms', k) for k in stat_keys},
        'typing_from_event_timestamp_ms': {k: median_of(stream, 'typing_from_event_timestamp_ms', k) for k in stat_keys},
        'event_timing_keydown_duration_ms': {k: median_of(stream, 'event_timing_keydown_ms', k) for k in stat_keys},
        'memory_5s_after_stream': {
            'total_pss_mib': round(median_of(stream, 'memory_5s_after', 'total_pss_kib') / 1024, 1),
            'total_rss_mib': round(median_of(stream, 'memory_5s_after', 'total_rss_kib') / 1024, 1),
            'by_type_pss_mib': {t: round(med([r['memory_5s_after']['by_type'][t]['pss_kib'] for r in stream]) / 1024, 1) for t in stream[0]['memory_5s_after']['by_type']},
            'by_type_rss_mib': {t: round(med([r['memory_5s_after']['by_type'][t]['rss_kib'] for r in stream]) / 1024, 1) for t in stream[0]['memory_5s_after']['by_type']},
            'main_window_renderer_pss_mib': round(median_of(stream, 'memory_5s_after', 'main_window_renderer', 'pss_kib') / 1024, 1),
            'main_window_renderer_rss_mib': round(median_of(stream, 'memory_5s_after', 'main_window_renderer', 'rss_kib') / 1024, 1),
            'excluded_fake_provider_pss_mib': round(med([r['memory_5s_after']['excluded'][0]['pss'] for r in stream]) / 1024, 1),
        },
        'launch_to_first_raf_ms': median_of(counted_launch, 'launch_to_first_raf_ms'),
        'launch_to_after_paint_ms': median_of(counted_launch, 'launch_to_after_paint_ms'),
        'launch_to_thread_in_dom_ms': median_of(counted_launch, 'launch_to_thread_in_dom_ms'),
        'edit_to_screen_hmr_ms': med([x['edit_to_screen']['ms'] for x in hmr_runs]),
        'edit_to_screen_hmr_lower_bound_ms': med([x['edit_to_screen']['lower_bound_ms'] for x in hmr_runs]),
        'edit_to_first_frame_full_rebuild_ms': median_of(rebuild, 'edit_to_first_raf_ms'),
        'full_rebuild_build_only_ms': median_of(rebuild, 'build_ms'),
    },
    'binary_size': {
        'sotto_bin_package': {'version': '0.1.38-1 (Electron 43.1.0)', 'pacman_installed_size': '369.98 MiB', 'du_files_bytes': 387951880, 'du_files_human': '371M'},
        'source_build': {'version': '0.1.43 at 61f9e269b', 'out_bytes': 47747053, 'out_human': '47M',
                         'electron_dist_bytes': 331425769, 'electron_dist_human': '317M', 'electron_dist_version': '43.8.3'},
    },
    'runs': {'stream': stream, 'launch': launch, 'hmr': hmr, 'rebuild': rebuild},
}
with open(os.path.join(here, 'results.json'), 'w') as f:
    json.dump(result, f, indent=1)
print(json.dumps(result['medians_of_runs'], indent=1))

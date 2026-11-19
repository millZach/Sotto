"""One line per receiver run: frames, pixel samples (non-black, distinct), import cost, and the helper's controls."""
import glob, json, sys
run, name = sys.argv[1], sys.argv[2]
try: r = json.load(open(f'{run}/receiver.json'))
except Exception as e: print(json.dumps({'config': name, 'error': f'no receiver.json: {e}'})); sys.exit()
cap = None; tex = None
for f in glob.glob(f'{run}/helper0/helper.jsonl'):
    for line in open(f, errors='replace'):
        try: o = json.loads(line)
        except ValueError: continue
        if o.get('ev') == 'capture-page': cap = f"{o['nonblackSampled']}/{o['of']}"
        if o.get('ev') == 'first-texture': tex = o['info']
c = (r.get('cycles') or [{}])[0]
row = {'config': name, 'frames': r['frames'], 'fps': c.get('fps'), 'samples': r['pixel_samples'], 'samples_nonblack': r['samples_with_nonblack'],
       'distinct_hashes': r['distinct_sample_hashes'], 'import_us': r['import_and_copy_us'], 'import_errors': r['import_errors'][:2],
       'capture_page_nonblack': cap, 'pixel_format': tex and tex['pixelFormat'], 'modifier': tex and tex['modifier'],
       'zero_copy_flag': tex and tex['supportsZeroCopyWebGpuImport'], 'first_frame_ms': c.get('first_frame_in_window_ms'), 'helper_pss_mb': c.get('helper_pss_mb')}
json.dump(row, open(f'{run}/row.json', 'w'), indent=1)
print(json.dumps(row))

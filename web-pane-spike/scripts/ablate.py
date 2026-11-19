"""Question 5, one setting at a time: the hardened set with one item left out, 240 s each (no page), so each call
the baseline makes is tied to the setting that stops it. Runs four at a time; each in its own namespace."""
import subprocess, sys, os, time
here = os.path.dirname(os.path.abspath(__file__))
switches = [l.strip() for l in open(f'{here}/../config/hardened-switches.txt') if l.strip()]
features = next(s for s in switches if s.startswith('disable-features=')).split('=', 1)[1].split(',')
base = [s for s in switches if not s.startswith('disable-features=')]
def build(drop_switch=None, drop_features=()):
    sw = [s for s in base if s != drop_switch]
    f = [x for x in features if x not in drop_features]
    return ';'.join(sw + ['disable-features=' + ','.join(f)])
prefs = os.path.realpath(f'{here}/../config/hardened-prefs.json')
runs = [
    ('without-background-networking', build('disable-background-networking'), prefs),
    ('without-disable-component-update', build('disable-component-update'), prefs),
    ('without-component-url', build('component-updater=url-source=http://127.0.0.1:9/'), prefs),
    ('without-both-component', build('disable-component-update', ()).replace('component-updater=url-source=http://127.0.0.1:9/;', ''), prefs),
    ('without-time-feature', build(None, ('NetworkTimeServiceQuerying',)), prefs),
    ('without-aim-features', build(None, ('AimEnabled', 'AimServerEligibilityEnabled', 'AimServerRequestOnStartupEnabled')), prefs),
    ('without-prefs', build(), ''),
    ('without-optimization-features', build(None, ('OptimizationHints', 'OptimizationHintsFetching', 'OptimizationGuideModelDownloading', 'OptimizationTargetPrediction', 'OnDeviceModelService')), prefs),
]
dist = os.path.expanduser('~/.cache/sotto-tmp/wp-dist-net2')
for i in range(0, len(runs), 4):
    procs = []
    for name, sw, p in runs[i:i + 4]:
        env = dict(os.environ, DIST=dist, WP_PREFS=p)
        procs.append(subprocess.Popen([f'{here}/net.sh', f'ablate-{name}', '240', '1', sw], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(2)
    for pr in procs: pr.wait()
print('ABLATION DONE')

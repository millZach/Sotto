"""Builds docs/prototypes/sidebar-hover-row-prototype.html from the real app's dumped markup and CSS."""
import base64, json, re, sys

DUMP = '/tmp/sotto-511f-repro'
REPO = sys.argv[1]
dark = json.load(open(f'{DUMP}/dump-dark.json'))
light = json.load(open(f'{DUMP}/dump-light.json'))
html = dark['html']

# ---- CSS: split the dump into top-level rules, keep the sidebar's.
css = dark['css']
rules, depth, start = [], 0, 0
for i, ch in enumerate(css):
    if ch == '{': depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            rules.append(css[start:i + 1].strip()); start = i + 1
KEEP = re.compile(r':root|^html|\bhtml\b|^body|^\*|\[data-theme|\.thread-nav|\.threads-|\.thread-folder|\.thread-group|\.host-badge|\.watched-badge|watcher-owl|\.tt-visually-hidden|\.tt-focusable|provider-mark|\.watch-row-toggle')
kept = []
for rule in rules:
    head = rule.split('{', 1)[0]
    if head.startswith('@font-face') or head.startswith('@import'): continue
    if head.startswith('@media') and 'hover: none' in head: continue
    if head.startswith('@keyframes'): kept.append(rule); continue
    if head.startswith('@'):
        if KEEP.search(rule): kept.append(rule)
        continue
    if KEEP.search(head): kept.append(rule)
# Chromium serialises a border shorthand holding color-mix() as empty longhands; take those rules from source instead.
src = open(f'{REPO}/src/renderer/src/agents/threadSidebar.css', encoding='utf-8').read()
fixed = next(line for line in src.splitlines() if line.startswith(".thread-nav__row--details .thread-nav__ring[data-state='working']:not([data-unseen], [data-background])"))
kept = [fixed if ('thread-nav__ring[data-state="working"]:not([data-unseen], [data-background])' in r and ': ;' in r) else r for r in kept if not (': ;' in r and 'data-glass' in r)]
out_css = '\n'.join(kept)
# A forced hover for the featured row, so a phone (which cannot hover) shows the hovered row.
out_css = out_css.replace(':hover', ':is(:hover, [data-pv-hover])')
print('css bytes', len(out_css), 'rules', len(kept), file=sys.stderr)

font = base64.b64encode(open(f'{REPO}/src/shared/fonts/figtree-latin.woff2', 'rb').read()).decode()

def svg(after):
    i = html.find(after); s = html.find('<svg', i); e = html.find('</svg>', s) + 6
    return html[s:e]
ICON = {
    'codex': svg('data-provider="codex"><svg') if False else svg('<span class="thread-nav__mark" data-provider="codex">'),
    'claude': svg('<span class="thread-nav__mark" data-provider="claude">'),
    'server': svg('<span class="host-badge" data-kind="remote"'),
    'owl12': svg('<span class="watched-badge"'),
    'owl16': svg('watch-row-toggle'),
    'alarm': svg('aria-label="Snooze Footer links"'),
    'archive': svg('aria-label="Settle Footer links"'),
    'chevron': svg('thread-group__toggle'),
}
L = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
ICON['columns'] = f'<svg {L} class="lucide lucide-columns-2"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M12 3v18"></path></svg>'
ICON['more'] = f'<svg {L} class="lucide lucide-ellipsis"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>'

payload = {
    'css': out_css, 'icons': ICON,
    'rootStyle': {'dark': dict(dark['rootAttrs'])['style'], 'light': dict(light['rootAttrs'])['style']},
}
template = open('/tmp/sotto-511f-proto/template.html').read()
page = template.replace('/*FONT*/', font).replace('/*PAYLOAD*/', json.dumps(payload).replace('</', '<\\/'))
open(f'{REPO}/docs/prototypes/sidebar-hover-row-prototype.html', 'w', encoding='utf-8').write(page)
print('page bytes', len(page), file=sys.stderr)

# Builds index.html from parts.html, the shared base of ../composer-quiet-20/template.html and the real provider marks,
# with Figtree inlined (the sandbox serves no other files' fonts).
import base64, json, pathlib, re
here = pathlib.Path(__file__).parent
root = here / '../..'
base = (here / '../composer-quiet-20/template.html').read_text()
css = base[base.index('<style>') + 8:base.index('/* ================= 0 today')]
calm = '\n'.join(l for l in base.splitlines() if l.startswith('body.calm .fr') or l.startswith('@media (prefers-reduced-motion'))
js = base[base.index('<script>') + 9:base.index('const MK =')]
src = (root / 'src/renderer/src/agents/ProviderMark.tsx').read_text()
marks = {k: [vb, p] for k, vb, p in re.findall(r"(\w+): \{\s*viewBox: '([^']+)',\s*path: '([^']+)'", src) if k in ('claude', 'codex', 'grok')}
font = base64.b64encode((root / 'src/shared/fonts/figtree-latin.woff2').read_bytes()).decode()
page = (here / 'parts.html').read_text().replace('/*BASECSS*/', css).replace('/*CALMCSS*/', calm).replace('//PI', js).replace('/*MARKS*/', json.dumps(marks)).replace('__FIGTREE__', font)
(here / 'index.html').write_text(page)
(root / 'docs/prototypes/composer-pill-actions.html').write_text(page)

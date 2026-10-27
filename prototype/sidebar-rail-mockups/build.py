# Builds index.html from template.html with Figtree inlined (the sandbox serves no other files' fonts).
import base64, pathlib
here = pathlib.Path(__file__).parent
font = base64.b64encode((here / '../../src/shared/fonts/figtree-latin.woff2').read_bytes()).decode()
page = (here / 'template.html').read_text().replace('__FIGTREE__', font)
(here / 'index.html').write_text(page.replace('__PAGE__', 'all'))
(here / 'tray.html').write_text(page.replace('__PAGE__', 'tray'))
(here / 'watched.html').write_text(page.replace('__PAGE__', 'watched'))

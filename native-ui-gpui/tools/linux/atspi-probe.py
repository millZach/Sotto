#!/usr/bin/env python3
# atspi-probe.py tree <app> | listen <app> <seconds>: the tree with each node's AT-SPI interfaces, text and caret,
# or every event the app sends for a while (what Orca would hear).
import sys, gi, time
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib
mode, want = sys.argv[1], sys.argv[2]
def app():
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a and want in (a.get_name() or ''): return a
def walk(n, depth, out):
    if len(out) > 900: return
    ifaces = n.get_interfaces()
    line = '  ' * depth + f"{n.get_role_name()}: {(n.get_name() or '')[:70]!r} [{','.join(i for i in ifaces if i != 'Accessible')}]"
    if 'Text' in ifaces:
        t = n.get_text_iface(); c = t.get_character_count()
        line += f" text={Atspi.Text.get_text(t, 0, min(c, 70))!r} chars={c} caret={Atspi.Text.get_caret_offset(t)}"
    attrs = n.get_attributes() or {}
    if attrs: line += f' attrs={dict(list(attrs.items())[:4])}'
    out.append(line)
    for i in range(n.get_child_count()): walk(n.get_child_at_index(i), depth + 1, out)
if mode == 'tree':
    out = []; walk(app(), 0, out); print('\n'.join(out))
else:
    def on(e):
        src = e.source
        try: who = f'{src.get_role_name()} {(src.get_name() or "")[:40]!r}'
        except Exception: who = '?'
        try: app_name = src.get_application().get_name()
        except Exception: app_name = ''
        if want not in app_name: return
        print(f'{time.strftime("%H:%M:%S")} {e.type} detail1={e.detail1} detail2={e.detail2} any={str(e.any_data)[:60]!r} on {who}', flush=True)
    l = Atspi.EventListener.new(on)
    for t in ['object:text-changed', 'object:text-caret-moved', 'object:state-changed', 'object:property-change',
              'object:children-changed', 'object:text-selection-changed', 'focus:', 'object:active-descendant-changed']:
        l.register(t)
    GLib.timeout_add_seconds(int(sys.argv[3]), lambda: (Atspi.event_quit(), False)[1])
    Atspi.event_main()

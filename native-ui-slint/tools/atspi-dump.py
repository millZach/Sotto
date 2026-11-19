# Dumps the accessibility tree of the app (by name) as role and name, the way a screen reader sees it.
import sys, gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
want = sys.argv[1] if len(sys.argv) > 1 else 'sotto-slint'
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 400
desktop = Atspi.get_desktop(0)
count = 0
def walk(node, depth):
    global count
    if count >= limit: return
    try:
        role = node.get_role_name(); name = node.get_name() or ''
        desc = node.get_description() or ''
        states = node.get_state_set()
        flags = [s for s in ('focused', 'focusable', 'expandable', 'expanded', 'selected') if states.contains(getattr(Atspi.StateType, s.upper()))]
        text = ''
        try:
            t = node.get_text_iface()
            if t: text = t.get_text(0, min(80, t.get_character_count()))
        except Exception: pass
        val = ''
        try:
            v = node.get_value_iface()
        except Exception: v = None
        print('  ' * depth + f'{role}: {name[:90]!r}' + (f' desc={desc[:60]!r}' if desc else '') + (f' text={text!r}' if text and text != name else '') + (f' [{",".join(flags)}]' if flags else ''))
        count += 1
        for i in range(node.get_child_count()):
            walk(node.get_child_at_index(i), depth + 1)
    except Exception as e:
        print('  ' * depth + f'<error {e}>')
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app and want in (app.get_name() or ''):
        walk(app, 0)
        break
else:
    print('apps:', [desktop.get_child_at_index(i).get_name() for i in range(desktop.get_child_count())])

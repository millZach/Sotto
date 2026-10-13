"""Inert login1 fixture for scripts/verify-linux-shutdown-drain.mjs; never powers off anything."""
import json
import os
import sys
import time
from pathlib import Path

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

root = Path(sys.argv[1])
DBusGMainLoop(set_as_default=True)
bus = dbus.bus.BusConnection(os.environ['DBUS_SYSTEM_BUS_ADDRESS'])
name = dbus.service.BusName('org.freedesktop.login1', bus, do_not_queue=True)


def record(event, **fields):
    with (root / 'bus-events.jsonl').open('a') as stream:
        stream.write(json.dumps(dict(event=event, at=time.monotonic(), **fields)) + '\n')


class Login(dbus.service.Object):
    @dbus.service.method('org.freedesktop.login1.Manager', in_signature='ssss', out_signature='h')
    def Inhibit(self, what, who, why, mode):
        reader, writer = os.pipe()
        descriptor = dbus.types.UnixFd(writer)
        os.close(writer)
        record('inhibit', what=str(what), mode=str(mode))

        def closed(fd, condition):
            os.close(fd)
            record('released', what=str(what))
            return False

        GLib.io_add_watch(reader, GLib.IO_HUP, closed)
        return descriptor

    @dbus.service.signal('org.freedesktop.login1.Manager', signature='b')
    def PrepareForShutdown(self, shutting_down):
        pass


login = Login(bus, '/org/freedesktop/login1')
last_notice = ''


def notices():
    global last_notice
    path = root / 'notice'
    current = path.read_text() if path.exists() else ''
    if current and current != last_notice:
        last_notice = current
        record('notice')
        login.PrepareForShutdown(True)
    return True


GLib.timeout_add(20, notices)
record('service-ready')
GLib.MainLoop().run()

import QtQuick
import Quickshell.Io

// Disappear when the package goes away, including without a bar restart.
QtObject {
  id: root
  property string command: "sotto"
  property bool available: false
  property Process probe: Process {
    command: ["sh", "-c", "command -v -- \"$1\" >/dev/null 2>&1", "sotto-command-probe", root.command]
    onExited: function(code) { root.available = code === 0 }
  }
  property Timer timer: Timer { interval: 5000; repeat: true; running: true; onTriggered: if (!root.probe.running) root.probe.running = true }
  onCommandChanged: if (!probe.running) probe.running = true
  Component.onCompleted: probe.running = true
}

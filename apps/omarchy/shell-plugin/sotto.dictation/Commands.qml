import QtQuick
import Quickshell.Io
import "Model.mjs" as Model

// Runs `sotto dictation <verb>` as a process with its own arguments, never
// through a shell string. Each press gets its own process, so a quick
// Stop after Start is not lost behind the first.
Item {
  id: root
  visible: false

  // An absolute path or a name on the shell's PATH.
  property string command: "sotto"

  // The command could not start, or Sotto did not take it.
  signal failed(string verb, bool started)

  function run(verb, argument) {
    var argv = [Model.cleanCommand(root.command), "dictation", String(verb)]
    if (argument !== undefined) argv.push(String(argument))
    var process = runner.createObject(root, { command: argv, verb: String(verb) })
    if (process) process.running = true
  }

  Component {
    id: runner

    Process {
      id: process

      property string verb: ""
      property bool began: false
      property bool done: false

      function finish(ok) {
        if (done) return
        done = true
        if (!ok) root.failed(verb, began)
        destroy()
      }

      onStarted: began = true
      onExited: function(exitCode, exitStatus) { finish(exitCode === 0 && exitStatus === 0) }
      // A process that never started reports no exit, only that it stopped.
      onRunningChanged: if (!running && !began) finish(false)
    }
  }
}

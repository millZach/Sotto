// Node on Windows has no delivered POSIX SIGTERM. Exercise the installed handler through IPC;
// Unix tests send the operating-system signal directly.
// The IPC channel itself would keep the host alive after its stores have closed, so it must not
// count towards the event loop: the host's own keep-alive timer holds the process up until it stops.
process.channel?.unref()
process.on('message', message => {
  if (message === 'SIGTERM') {
    process.emit('SIGTERM')
    process.disconnect()
  }
})

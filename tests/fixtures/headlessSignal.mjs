// Node on Windows has no delivered POSIX SIGTERM. Exercise the installed handler through IPC;
// Unix tests send the operating-system signal directly.
process.on('message', message => {
  if (message === 'SIGTERM') {
    process.emit('SIGTERM')
    process.disconnect()
  }
})

import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { isAbsolute } from 'node:path'

const execFileSync = childProcess.execFileSync
// Model GNU tar's archive-name ambiguity even on machines whose tar is BSD tar.
childProcess.execFileSync = (file, args, options) => {
  if (file === 'tar') {
    const archive = args[args.findIndex(arg => arg === '-czf' || arg === '-xzf') + 1]
    if (!archive || isAbsolute(archive) || archive.includes(':')) throw new Error('Pass tar a local archive filename')
  }
  return execFileSync(file, args, options)
}
syncBuiltinESMExports()

// A stand-in for OpenSSH for a shell over SSH (ADR-0183): the desktop runs it under a real terminal with the arguments
// of `ssh -tt`, and it runs the remote command here the way sshd does, in a throwaway home. Each run records its arguments.
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
if (process.env.FAKE_SSH_RECORD) appendFileSync(process.env.FAKE_SSH_RECORD, JSON.stringify(args) + '\n')
const command = args.at(-1)
const child = process.platform === 'win32'
  ? spawn('cmd.exe', ['/d', '/c', command], { stdio: 'inherit', windowsVerbatimArguments: true })
  : spawn('/bin/sh', ['-c', command], { stdio: 'inherit' })
child.once('exit', (code, signal) => process.exit(signal ? 255 : code ?? 255))

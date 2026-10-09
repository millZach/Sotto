// Keep proof subprocesses in dedicated process groups, including reparented wl-copy owners.
import assert from 'node:assert/strict'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

export function createOwnedProofProcesses(report) {
  const groups = []
  const members = () => {
    const owned = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        // Zombies have exited; the parent or init owns their reaping.
        if (fields[0] !== 'Z' && groups.some(group => group.pid === Number(fields[2]))) owned.push(Number(name))
      } catch { /* The process exited while /proc was being read. */ }
    }
    return owned
  }
  const start = (name, executable, args, options = {}) => {
    const child = spawn(executable, args, { ...options, detached: true })
    child.once('error', error => { child.proofError = error })
    if (child.pid) groups.push({ name, pid: child.pid })
    return child
  }
  const stop = async () => {
    const signalGroups = signal => {
      for (const group of [...groups].reverse()) {
        try { process.kill(-group.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    signalGroups('SIGTERM')
    for (let i = 0; i < 30 && members().length; i++) await wait(50)
    if (members().length) signalGroups('SIGKILL')
    for (let i = 0; i < 30 && members().length; i++) await wait(50)
    for (const group of groups) report(`Stopped ${group.name} process group ${group.pid}`)
    const remaining = members()
    report(`Owned processes still running: ${JSON.stringify(remaining)}`)
    assert.deepEqual(remaining, [], 'Every proof-owned process must stop')
  }
  return { start, stop }
}

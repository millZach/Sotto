import { spawn } from 'node:child_process'

/**
 * A process working in `folder`, as a thread's idle provider client does (ADR-0038). Windows will not delete a folder
 * a process uses as its working folder.
 *
 * The holder is ready once its own code says it is running, not at the `spawn` event: that only says the process was
 * made, and one Windows has not finished starting, or one that has already ended, holds nothing (#1385). A holder that
 * ends before it is ready fails the setup. Release stops the process and waits for it to exit, and fails when the holder
 * had ended by itself, so a test whose folder stopped being held reports that rather than whatever its assertion saw.
 */
export async function holdFolder(folder: string): Promise<{ release(): Promise<void> }> {
  const holder = spawn(process.execPath, ['-e', "console.log('holding'); setInterval(() => {}, 1000)"], { cwd: folder, stdio: ['ignore', 'pipe', 'ignore'] })
  let ended = ''
  const exited = new Promise<void>(resolve => holder.once('exit', (code, signal) => { ended = signal ?? `exit code ${code}`; resolve() }))
  await new Promise<void>((resolve, reject) => {
    let said = ''
    holder.stdout.on('data', (chunk: Buffer) => { said += chunk.toString(); if (said.split(/\r?\n/u).includes('holding')) resolve() })
    holder.on('error', reject)
    void exited.then(() => reject(new Error(`The folder holder ended (${ended}) before it held ${folder}.`)))
  })
  return {
    release: async () => {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill()
      await exited
      // Only this kill ends the holder with SIGTERM. Any other end was its own, even one not yet heard when release began.
      if (ended !== 'SIGTERM') throw new Error(`The folder holder ended by itself (${ended}) before the test let it go, so ${folder} was not held for the whole test.`)
    },
  }
}

import { spawn } from 'node:child_process'
import { once } from 'node:events'

/**
 * A process working in `folder`, as a thread's idle provider client does (ADR-0038). Windows will not delete a folder
 * a process uses as its working folder. Release stops the process and waits for it to exit.
 */
export async function holdFolder(folder: string): Promise<{ release(): Promise<void> }> {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: folder, stdio: 'ignore' })
  const exited = once(holder, 'exit').then(() => undefined, () => undefined)
  await once(holder, 'spawn')
  return { release: async () => { holder.kill(); await exited } }
}

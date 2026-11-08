// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stopsWhenTold } from '../../fixtures/stopsWhenTold'

const directories: string[] = [], children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function script() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-stops-when-told-')); directories.push(root)
  const file = join(root, 'script.cjs'), stop = join(root, 'stop')
  await writeFile(file, `${stopsWhenTold(stop)} process.stdout.write('running')`)
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); children.push(child)
  await once(child.stdout, 'data')
  return { file, stop, child }
}

describe('a fixture script that ends itself when told', () => {
  it('ends once its stop file is written', async () => {
    const { stop, child } = await script()
    const exited = once(child, 'exit')
    await writeFile(stop, '')
    expect(await exited).toEqual([0, null])
  })
  it('ends once its own file is removed with the test folder', async () => {
    const { file, child } = await script()
    const exited = once(child, 'exit')
    await rm(file)
    expect(await exited).toEqual([0, null])
  })
})

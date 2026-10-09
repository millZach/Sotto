// @vitest-environment node
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const roots: string[] = []
export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-devin-policy-'))
  roots.push(root)
  const cwd = join(root, 'project', 'nested')
  await mkdir(cwd, { recursive: true })
  return { root, cwd, userData: join(root, 'sotto'), nativeConfig: join(root, 'native') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })


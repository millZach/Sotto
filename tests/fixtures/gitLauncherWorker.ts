/**
 * The Git launcher's worker (`src/main/agents/gitLauncherWorker.ts`) compiled the way the build compiles it, for a test
 * that runs launches on it. The test runner has no built file beside the launcher, so the shared launcher launches in
 * the test's own thread unless a test points it here (`useGitLauncher`). Transpiled with the bundler's own esbuild
 * into a `.cjs` file, since the worker imports only Node builtins, behind the same Git guard every test file has.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { transformWithEsbuild } from 'vite'

export async function builtGitLauncherWorker(): Promise<{ readonly path: string; dispose(): Promise<void> }> {
  const source = resolve('src/main/agents/gitLauncherWorker.ts')
  const { code } = await transformWithEsbuild(await readFile(source, 'utf8'), source, { loader: 'ts', format: 'cjs', target: 'node24' })
  // The worker thread has its own `node:child_process`, so the test harness's Git guard (`gitGuard.ts`) goes in with it.
  const guardSource = resolve('tests/fixtures/gitGuard.ts')
  const guard = (await transformWithEsbuild(await readFile(guardSource, 'utf8'), guardSource, { loader: 'ts', format: 'cjs', target: 'node24' })).code
  const guarded = `(() => { const module = { exports: {} }; const exports = module.exports;\n${guard}\nmodule.exports.installGitGuard() })();\n${code}`
  const root = await mkdtemp(join(tmpdir(), 'sotto-git-launcher-'))
  const path = join(root, 'gitLauncherWorker.cjs')
  await writeFile(path, guarded)
  return {
    path,
    dispose: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-git-launcher-')) throw new Error('Unexpected fixture directory')
      await rm(root, { recursive: true, force: true })
    },
  }
}

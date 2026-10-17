import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'

/**
 * The self-updating host entry (`selfUpdatingHost.ts`) built for Node into one CommonJS file, as a release's
 * `host/index.js` is. `directory` holds it as `index.js`; `source` is its text, for a release archive to carry.
 */
export async function buildSelfUpdatingHost(): Promise<{ readonly directory: string; readonly source: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-self-update-build-'))
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/selfUpdatingHost.ts'), target: 'node24', outDir: directory, emptyOutDir: true,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  return { directory, source: await readFile(join(directory, 'index.js'), 'utf8') }
}

/**
 * Stops every process a test started under `root`: the hosts, the restart that outlives the host that started it, and
 * anything else whose command line names the test's own folder. Leftover hosts from launch tests have been found running
 * for days. Never this test process itself.
 */
export async function stopEverythingIn(root: string): Promise<void> {
  const pids = await new Promise<number[]>(done => {
    if (process.platform === 'win32') {
      const filter = `$_.CommandLine -and $_.CommandLine.Contains('${root.replaceAll("'", "''")}')`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { ${filter} } | ForEach-Object { $_.ProcessId }`],
        { windowsHide: true, encoding: 'utf8' }, (_error, stdout) => done(String(stdout ?? '').split(/\s+/u).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)))
    } else {
      execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }, (_error, stdout) => done(String(stdout ?? '').split('\n')
        .filter(line => line.includes(root)).map(line => Number(line.trim().split(/\s+/u)[0])).filter(pid => Number.isInteger(pid) && pid > 0)))
    }
  })
  for (const pid of pids) if (pid !== process.pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

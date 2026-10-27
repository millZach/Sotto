import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
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

/** The release layout both update journeys start from, with SSH shims that record any unexpected use. */
export async function installSelfUpdatingHost(root: string, builtDirectory: string, version: string) {
  const install = join(root, 'sotto-host'), data = join(root, 'data'), bin = join(root, 'bin'), sshUsed = join(root, 'ssh-used')
  await mkdir(join(install, 'host'), { recursive: true }); await mkdir(bin); await mkdir(data)
  await copyFile(join(builtDirectory, 'index.js'), join(install, 'host', 'index.js'))
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'sotto-host', version }))
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\necho used > '${sshUsed}'\nexit 255\n`, { mode: 0o755 })
  await writeFile(join(bin, 'ssh.cmd'), `@echo used > "${sshUsed}"\r\n@exit /b 255\r\n`)
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  return { install, data, sshUsed, env: { ...process.env, [pathKey]: bin + delimiter + (process.env[pathKey] ?? '') } }
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
// The command line is the only way to find the restart and the host it starts, whose processes the test never sees. On
// Windows that is a PowerShell CIM query, which a busy runner can keep for most of the default 15 s hook deadline before the
// folder's removal retries for up to 11 s while a killed host lets go of its files. A clean-up that is not stuck never reaches
// this; a stuck one still fails the test.
export const CLEAN_UP_TIMEOUT_MS = 120_000

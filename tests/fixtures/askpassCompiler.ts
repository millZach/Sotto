import type { ChildProcess, execFile as ExecFile, ExecFileException } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

let directory: string | undefined
const compiled = new Map<string, string>()

/** Compile each immutable Windows helper once; every broker still owns and runs its own executable. */
export function cachedAskpassCompiler(execFile: typeof ExecFile): typeof ExecFile {
  const invoke = execFile as (file: string, ...args: unknown[]) => ChildProcess
  const wrapped = ((file: string, ...args: unknown[]): ChildProcess => {
    const [argv, options, callback] = args
    if (!file.endsWith('csc.exe') || !Array.isArray(argv) || typeof callback !== 'function') return invoke(file, ...args)
    const source = argv.at(-1) as string
    const output = (argv as string[]).find(arg => arg.startsWith('/out:'))?.slice(5)
    if (!output) return invoke(file, ...args)
    const key = createHash('sha256').update(file).update(JSON.stringify(argv.filter(arg => arg !== source && !arg.startsWith('/out:')))).update(readFileSync(source)).digest('hex')
    const cached = compiled.get(key)
    if (cached) {
      // Keep the child-process callback and ownership contract while avoiding another C# compilation.
      return invoke(process.execPath, ['-e', 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])', cached, output], options, callback)
    }
    return invoke(file, argv, options, (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (!error) {
        try {
          directory ??= mkdtempSync(join(tmpdir(), 'sotto-askpass-compiler-test-'))
          const path = join(directory, `${key}.exe`)
          copyFileSync(output, path)
          compiled.set(key, path)
        } catch (failure) { error = failure as ExecFileException }
      }
      callback(error, stdout, stderr)
    })
  }) as typeof ExecFile
  // execFile's promisified form returns both streams and exposes the child. Keep that contract for
  // every other caller of the mocked module too, while routing compilation through the cache.
  Object.defineProperty(wrapped, promisify.custom, { value: (file: string, ...args: unknown[]) => {
    let child: ChildProcess | undefined
    const result = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolveResult, reject) => {
      const run = wrapped as (file: string, ...args: unknown[]) => ChildProcess
      child = run(file, ...args, (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolveResult({ stdout, stderr })
      })
    })
    return Object.assign(result, { child })
  } })
  return wrapped
}

export async function disposeAskpassCompiler(): Promise<void> {
  compiled.clear()
  if (directory) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-askpass-compiler-test-')) throw new Error('Unexpected compiler fixture directory')
    await rm(directory, { recursive: true, force: true })
  }
  directory = undefined
}

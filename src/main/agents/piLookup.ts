import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { executableFile, findCli, withCliPath, type CliLookupOptions } from './cliLookup'

const packageSchema = z.object({ name: z.literal('@earendil-works/pi-coding-agent'), bin: z.object({ pi: z.string().min(1) }) })

/** Windows npm exposes a batch wrapper, not pi.exe. Resolve its own package entry and run it with Node, without a shell. */
export async function findPiExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<string | undefined> {
  const platform = lookup.platform ?? process.platform
  return findCli({ name: 'pi',
    within: folder => [join(folder, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), join(folder, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')],
    accept: async candidate => {
      if (!candidate.endsWith('package.json')) return executableFile(candidate, platform)
      try {
        const pkg = packageSchema.parse(JSON.parse(await readFile(candidate, 'utf8')))
        if (isAbsolute(pkg.bin.pi)) return undefined
        const entry = resolve(dirname(candidate), pkg.bin.pi)
        const path = relative(dirname(candidate), entry)
        if (path === '..' || path.startsWith(`..${sep}`)) return undefined
        return executableFile(entry, platform)
      } catch { return undefined }
    },
  }, { ...lookup, environment })
}

export async function piProgram(executable: string, env: NodeJS.ProcessEnv): Promise<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const environment = withCliPath(env, executable)
  if (!/\.[cm]?js$/iu.test(executable)) return { executable, args: [], env: environment }
  const node = await findCli({ name: 'node' }, { environment })
  if (!node) throw new Error('Pi needs Node 22.19 or newer. Install Node, then connect Pi again. Your threads are kept.')
  return { executable: node, args: [executable], env: withCliPath(environment, node) }
}

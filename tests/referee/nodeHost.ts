import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { bundleDesktopMain } from '../fixtures/desktopMainBundle'
import type { HostCommand } from './wire'

const HOST_ENTRY = resolve('src/host/index.ts')
const COMMAND_LINE_START = 'if (require.main === module) void runHeadlessCommandLine()'

/**
 * `src/host/index.ts` starts its own command line when it is the main module, which in a one-file bundle it is. The
 * referee host has a command line of its own, so that start is taken out; a change to the line fails the build here
 * rather than starting a second host on the same data folder.
 */
const withoutHostCommandLine: Plugin = {
  name: 'referee-without-host-command-line', enforce: 'pre',
  transform(code, id) {
    if (resolve(id.split('?')[0]!) !== HOST_ENTRY) return null
    if (!code.includes(COMMAND_LINE_START)) this.error(`src/host/index.ts no longer starts its command line with "${COMMAND_LINE_START}"; update tests/referee/nodeHost.ts.`)
    return code.replace(COMMAND_LINE_START, '')
  },
}

/** Builds the TypeScript referee host (`tests/fixtures/refereeNodeHost.ts`) into `folder` and answers its command line. */
export async function buildNodeRefereeHost(folder: string): Promise<HostCommand> {
  const outfile = join(folder, 'referee-node-host.cjs')
  await bundleDesktopMain('tests/fixtures/refereeNodeHost.ts', outfile, { plugins: [withoutHostCommandLine] })
  return [process.execPath, outfile, '--data', '{data}', '--provider', '{provider}']
}

/** SOTTO_REFEREE_HOST: the host's command line as a JSON array, with `{data}` and `{provider}` where it takes them. */
export function namedRefereeHost(): HostCommand | undefined {
  const text = process.env.SOTTO_REFEREE_HOST
  if (!text) return undefined
  const command = JSON.parse(text) as unknown
  if (!Array.isArray(command) || command.length === 0 || !command.every(part => typeof part === 'string')) throw new Error('SOTTO_REFEREE_HOST must be a JSON array of strings, such as ["sotto-host", "--data", "{data}", "--fake", "{provider}"].')
  return command
}

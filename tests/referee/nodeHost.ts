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

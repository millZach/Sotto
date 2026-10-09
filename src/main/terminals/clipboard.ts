import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TERMINAL_IMAGE_MAX_BYTES } from '../../shared/terminal'
import { fail } from '../tools/common'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** All terminals stage clipboard PNGs in the working folder, excluded from Git. Never logs the image or path. */
export async function saveTerminalImage(workingDirectory: string, dataUrl: string, now = Date.now()): Promise<string> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl)
  const bytes = match ? Buffer.from(match[1]!, 'base64') : null
  if (!bytes || bytes.length > TERMINAL_IMAGE_MAX_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return fail('invalid-request', 'Only a PNG image up to 10 MiB can be pasted into a terminal.')
  const folder = join(workingDirectory, '.sotto', 'clipboard')
  const stamp = new Date(now).toISOString().replace(/[-:]/gu, '').replace('T', '-').replace('.', '-').replace(/Z$/u, '')
  let path = join(folder, `${stamp}.png`)
  try {
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    for (let attempt = 2; ; attempt += 1) {
      try { await writeFile(path, bytes, { flag: 'wx' }); return path }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 100) throw error; path = join(folder, `${stamp}-${attempt}.png`) }
    }
  } catch { return fail('path-unavailable', 'The image could not be saved under this folder. Paste it again after restoring access.') }
}

/** A literal argument for the terminal's PowerShell or POSIX shell, even when the folder contains expansions. */
export const terminalImageInput = (path: string, platform: NodeJS.Platform = process.platform): string => platform === 'win32'
  ? `'${path.replace(/['\u2018-\u201b]/gu, quote => quote + quote)}'`
  : `'${path.replace(/'/gu, `'\\''`)}'`

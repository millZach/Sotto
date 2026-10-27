// npm run render: the film, rendered by Remotion from the takes, then the music bed laid under it.
// One command, the same MP4 every time for the same takes. Run `npm run capture` first.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dirname
const out = join(here, 'out')
mkdirSync(out, { recursive: true })
if (!existsSync(join(here, 'src', 'takes.json'))) throw new Error('No takes yet: run `npm run capture` first.')
const silent = join(out, 'film-silent.mp4')
const film = join(out, 'sotto-launch-1080x1920.mp4')
const remotion = join(here, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
execFileSync(process.execPath, [remotion, 'render', 'src/index.ts', 'Launch', silent, '--codec=h264', '--crf=15', '--pixel-format=yuv420p', '--x264-preset=slow', '--muted', '--concurrency=6'], { cwd: here, stdio: 'inherit' })
// The bed is a placeholder of silence until a licensed track replaces audio/PLACEHOLDER-music.mp3 (cue-sheet.md).
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', join(here, 'audio', 'PLACEHOLDER-music.mp3'),
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', film], { stdio: 'inherit' })
console.log(film)

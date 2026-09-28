// Puts each take's logged events on the footage's own clock. A take begins with the cursor jumping into the
// window's dark corner at a logged moment; the first frame that shows it there is that moment in the video.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VIDEO } from './lib/stage.mjs'

const TAKES = join(VIDEO, 'public', 'takes')

function syncFrame(file, point) {
  const size = 24
  const x = Math.max(0, point.x - 4), y = Math.max(0, point.y - size + 4)
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-t', '8', '-i', file,
    '-vf', `crop=${size}:${size}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const frames = []
  let time = 0
  for (const line of out.split(/\r?\n/u)) {
    const pts = /pts_time:([\d.]+)/u.exec(line); if (pts) time = Number(pts[1])
    const max = /YMAX=(\d+)/u.exec(line); if (max) frames.push({ time, max: Number(max[1]) })
  }
  const base = Math.min(...frames.slice(0, 20).map(f => f.max))
  const hit = frames.find(f => f.max > base + 120)
  if (!hit) throw new Error(`No sync mark found in ${file}`)
  return hit.time
}

export function sync() {
  const result = existsSync(join(VIDEO, 'src', 'takes.json')) ? JSON.parse(readFileSync(join(VIDEO, 'src', 'takes.json'), 'utf8')) : {}
  for (const name of readdirSync(TAKES).filter(n => n.endsWith('.events.json'))) {
    const take = name.replace(/\.events\.json$/u, '')
    const log = JSON.parse(readFileSync(join(TAKES, name), 'utf8'))
    const video = join(TAKES, `${take}.mp4`)
    const mark = log.events.find(e => e.name === 'sync')
    const sync = syncFrame(video, log.sync)
    result[take] = { sync, events: log.events.filter(e => e.name !== 'sync').map(({ at, ...rest }) => ({ ...rest, t: Number((sync + (at - mark.at) / 1000).toFixed(3)) })) }
    console.log(`${take}: sync at ${sync.toFixed(3)} s, ${result[take].events.length} events`)
  }
  writeFileSync(join(VIDEO, 'src', 'takes.json'), JSON.stringify(result, null, 2) + '\n')
}

if (process.argv[1]?.endsWith('sync.mjs')) sync()

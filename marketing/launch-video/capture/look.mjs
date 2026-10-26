// Opens the seed and screenshots each thread, to check the scene before recording.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './lib/stage.mjs'
import { launch, sleep } from './lib/rig.mjs'
import { restoreSeed } from './lib/snapshot.mjs'

restoreSeed()
const threads = JSON.parse(readFileSync(join(paths.root, 'threads.json'), 'utf8'))
const rig = await launch()
try {
  await sleep(3000)
  for (const [key, id] of Object.entries(threads)) {
    await rig.command({ type: 'select-thread', threadId: id })
    await sleep(1500)
    await rig.main.screenshot({ path: join(paths.root, 'tmp', `look-${key}.png`) })
  }
} finally { await rig.close() }

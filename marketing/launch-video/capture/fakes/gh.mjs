// The launch video's gh: the repository's fake GitHub CLI, with its state file at the stage's fixed place
// and the demo's repository name, a plain check name and the time of the call in what it prints.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve, dirname } from 'node:path'
process.env.FAKE_GH_STATE ??= join(process.env.SOTTO_VIDEO_ROOT ?? 'C:\\demo', 'fakes', 'gh-state.json')
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => write(String(chunk).replaceAll('sotto-fixture/owned', 'pantry-demo/pantry').replaceAll('"sotto-fixture"', '"pantry-demo"')
  .replaceAll('Owned build', 'Build and test').replaceAll('2026-09-23T00:00:00Z', new Date().toISOString().replace(/\.\d+Z$/u, 'Z')), ...rest)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
await import(pathToFileURL(join(repository, 'tests', 'fixtures', 'fakeGh.mjs')).href)

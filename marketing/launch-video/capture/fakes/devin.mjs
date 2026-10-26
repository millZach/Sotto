// The launch video's Devin: the repository's fake Devin CLI, reporting a model name a viewer would recognise
// instead of the fixture's placeholder.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve, dirname } from 'node:path'
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => write(String(chunk).replaceAll('"Fixture Devin"', '"SWE-1.5"'), ...rest)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
await import(pathToFileURL(join(repository, 'tests', 'fixtures', 'fakeDevinAgent.mjs')).href)

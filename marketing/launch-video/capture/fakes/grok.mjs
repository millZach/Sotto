// The launch video's Grok Build: the repository's fake Grok client, whose one-shot writing session lists the
// same model the threads run on (the fixture's own list names only its placeholder model).
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve, dirname } from 'node:path'
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => write(String(chunk).replaceAll('"fixture-model"', '"grok-4.7"').replaceAll('"Fixture Grok"', '"Grok 4.7"'), ...rest)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
await import(pathToFileURL(join(repository, 'tests', 'fixtures', 'fakeGrokThreadAgent.mjs')).href)

// @vitest-environment node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PRODUCT_EVENT_FEATURES, PRODUCT_EVENT_SCHEMAS } from '../../../../src/main/productEvents/schema'
import { PRODUCT_EVENTS_ENDPOINT } from '../../../../src/main/productEvents/productEvents'

const read = (path: string): string => readFileSync(path, 'utf8')
const page = read('docs/product-events.md')
const dialog = read('src/renderer/src/features/productEvents/ProductEventsDialog.tsx')
const notice = read('src/renderer/src/features/productEvents/ProductEventsNotice.tsx')
const row = read('src/renderer/src/features/settings/ProductEventsSettings.tsx')

/** Tracked text a promise could sit in, without decisions and evidence, which record what was true when they were written. */
function promises(): readonly string[] {
  const files = execFileSync('git', ['ls-files', 'README.md', 'docs/guide.md', 'docs/product-events.md', 'CONTEXT.md', 'src/renderer/src', 'src/main', 'src/host', 'apps/ios/README.md', 'workers/product-events/README.md'], { encoding: 'utf8' })
  return files.split('\n').filter(path => /\.(md|tsx?|css)$/.test(path))
}

describe('what Sotto says about product events', () => {
  it('names every event and every field on the docs page', () => {
    for (const [event, schema] of Object.entries(PRODUCT_EVENT_SCHEMAS)) {
      expect(page, event).toContain(`\`${event}\``)
      for (const field of Object.keys(schema.shape)) expect(page, `${event}.${field}`).toContain(`\`${field}\``)
    }
    for (const feature of PRODUCT_EVENT_FEATURES) expect(page, feature).toContain(`\`${feature}\``)
    for (const common of ['uuid', 'timestamp', 'distinct_id', 'appVersion', 'channel', 'surface', 'platform', 'arch', '$process_person_profile', '$geoip_disable']) expect(page, common).toContain(`\`${common}\``)
  })

  it('lists exactly the events there are in the dialog the notice and the switch open', () => {
    const shown = [...dialog.matchAll(/\['([a-z_.]+)', </g)].map(match => match[1])
    expect(shown.sort()).toEqual(Object.keys(PRODUCT_EVENT_SCHEMAS).sort())
  })

  it('names the endpoint where the README says which hosts Sotto contacts', () => {
    const host = new URL(PRODUCT_EVENTS_ENDPOINT).host
    expect(read('README.md')).toContain(`\`${host}\``)
    expect(page).toContain(`\`${host}\``)
  })

  it('says accounts are hashed and linked wherever it says what is sent', () => {
    for (const words of [page, read('README.md'), read('docs/guide.md'), notice, row]) expect(words).toContain('Hashed is not anonymous: those IDs link your computers to one person.')
  })

  it('calls them anonymous nowhere it describes them', () => {
    const words = [page, notice, row, dialog, read('README.md'), read('docs/guide.md'), read('src/renderer/src/features/help/HelpView.tsx'), read('src/renderer/src/features/onboarding/Onboarding.tsx')]
    for (const text of words) expect(text.replaceAll('Hashed is not anonymous', '')).not.toMatch(/anonymous|anonymi[sz]ed/i)
  })

  it('promises no analytics nowhere', () => {
    for (const path of promises()) {
      read(path).split('\n').forEach((line, index) => expect(line, `${path}:${index + 1}`).not.toMatch(/no analytics(?! but product events)|no telemetry|telemetry-free|collects nothing/i))
    }
  })
})

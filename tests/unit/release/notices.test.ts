import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NOTICE_COMPONENTS, verifyThirdPartyNotices } from '../../../scripts/verify-notices.mjs'

describe('third-party notice inventory', () => {
  it('matches every locked bundled component and preserves complete license families', async () => {
    await expect(verifyThirdPartyNotices()).resolves.toMatchObject({
      componentCount: NOTICE_COMPONENTS.length,
    })

    const notices = readFileSync(resolve('THIRD_PARTY_NOTICES.md'), 'utf8')
    for (const component of NOTICE_COMPONENTS) {
      expect(notices).toContain(`| \`${component.name}\`${component.nameSuffix ?? ''} | \`${component.version}\` |`)
      expect(notices).toContain(component.attribution)
    }
    for (const heading of [
      'Electron MIT license',
      'Lucide ISC and Feather MIT licenses',
      'Apache License 2.0',
      'Protocol Buffers BSD 3-Clause license',
      'ONNX Runtime MIT license',
    ]) expect(notices).toContain(`## ${heading}`)
  })
})

import { describe, expect, it } from 'vitest'

import { APP_NAME, DEFAULT_HOTKEY } from '../../../src/shared/constants'

describe('application constants', () => {
  it('uses the approved product name and shortcut', () => {
    expect(APP_NAME).toBe('Sotto')
    expect(DEFAULT_HOTKEY).toBe('CommandOrControl+Shift+Space')
  })
})

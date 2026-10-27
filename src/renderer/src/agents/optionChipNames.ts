import { msg } from '@lingui/core/macro'

import { wordsOf } from './interfaceWords'

/**
 * The option chips' accessible names, one per setting. Each says which setting a press changes, and the alert
 * under the chips finds the chip it hands focus back to by it, so the chips and the alert read the same strings.
 */
export const OPTION_CHIP_NAMES = wordsOf({ model: msg`Thread model`, effort: msg`Thread reasoning`, permissions: msg`Thread permissions`, fast: msg`Fast mode` })

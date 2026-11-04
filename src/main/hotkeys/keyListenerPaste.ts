import type { PasteProcessAdapter } from '../output/outputService'
import type { KeyListener } from './keyListener'

/** Only a known pre-dispatch refusal permits the existing paste adapter to try. */
export function createKeyListenerPasteAdapter(
  listener: () => KeyListener | null,
  fallback: PasteProcessAdapter,
): PasteProcessAdapter {
  return {
    async run(invocation) {
      const result = await listener()?.paste() ?? 'not-sent'
      return result === 'not-sent' ? fallback.run(invocation) : result === 'dispatched'
    },
  }
}

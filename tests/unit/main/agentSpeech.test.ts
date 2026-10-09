// @vitest-environment node
import { expect, it } from 'vitest'
import { synthesizeAgentSpeech } from '../../../src/main/agents/speech'

it('reports that Linux system speech is unavailable without trying another platform voice', async () => {
  await expect(synthesizeAgentSpeech('Read this reply', 'linux')).rejects.toThrow(
    'System speech is unavailable on Linux. Read the reply in the widget.',
  )
})

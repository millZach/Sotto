import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

import type { SubscriptionAccount, SubscriptionClient } from './subscriptionTypes'

const unavailable = 'Grok subscription reasoning is not available in this build. Choose ChatGPT or Claude for Sotto reasoning; Grok can still run your project agents through T3. Your Grok sign-in has not been checked.'

/**
 * Grok 1.0.5 cannot yet provide this module's text-only, subscription-only contract.
 * `--tools` controls model tools, not personal SessionStart/Stop hooks or MCP startup.
 * Per-model API keys also outrank cached session authentication. Do not infer
 * readiness from the existence of auth files or start ACP just to inspect auth.
 *
 * Sources checked 2026-09-09:
 * https://docs.x.ai/build/features/hooks
 * https://docs.x.ai/build/settings/reference
 * https://docs.x.ai/build/enterprise#authentication
 *
 * This unavailable adapter only checks executable metadata. It never launches
 * Grok, reads configuration/credentials, submits prompts, or falls back to an API.
 */
export class GrokSubscriptionClient implements SubscriptionClient {
  constructor(workingDirectory: string) {
    if (!isAbsolute(workingDirectory)) throw new Error('Grok reasoning requires an absolute isolated working directory.')
  }

  async status(): Promise<SubscriptionAccount> {
    const executable = process.platform === 'win32' ? 'grok.exe' : 'grok'
    const grokHome = process.env.GROK_HOME || join(homedir(), '.grok')
    const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
    const candidates = [join(grokHome, 'bin', executable), ...pathDirectories.map(directory => join(directory, executable))]
    let installed = false
    for (const candidate of new Set(candidates)) {
      if (!isAbsolute(candidate)) continue
      try {
        if (!(await stat(candidate)).isFile()) continue
        await access(candidate, constants.X_OK)
        installed = true
        break
      } catch { /* Check the next native executable; never run a shell wrapper. */ }
    }
    return {
      provider: 'grok', label: 'Grok subscription', installed, ready: false, models: [],
      detail: installed ? unavailable : `Grok CLI was not found. ${unavailable}`,
    }
  }

  readonly complete: SubscriptionClient['complete'] = async () => {
    throw new Error(unavailable)
  }
}

// @vitest-environment node
import { i18n } from '@lingui/core'
import { afterEach, describe, expect, it } from 'vitest'

import { MainInterfaceLanguage } from '../../../src/main/interfaceLanguage'

import { HOST_BUSY, hostVersionMismatch } from '../../../src/shared/hostProtocol'
import {
  CONNECT_FAILURES, english, englishOf, failureWords, SaidError, shown, WordedError, SSH_FAILURE_VARIANTS, sshFailureWords, sshFixWords, unsavedText, type FailureWords,
} from '../../../src/main/hosts/hostFailureWords'
import { classifySshExit, failureFix, SshFailure, type SshFailureCode } from '../../../src/main/hosts/sshFailure'

/**
 * A connect's failures as words (ADR-0123): the row's sentence, and Add host's, which the row's English made by rewriting
 * it before these were messages. English stays byte for byte what it was, so each Add host sentence is held to that
 * rewrite, and each SSH failure to the English the headless host still writes.
 */
const CODES: SshFailureCode[] = ['ssh-missing', 'ssh-too-old', 'ssh-unreachable', 'ssh-failed', 'auth-failed', 'host-key-changed', 'host-key-rejected',
  'identity-file-unreadable', 'connect-timeout', 'prompt-unanswered', 'node-missing', 'node-too-old', 'node-too-new', 'archive-missing', 'descriptor-invalid',
  'port-taken', 'host-busy', 'host-start-failed', 'host-timeout', 'host-not-running', 'boot-start-refused', 'boot-unit-failed', 'forward-failed',
  'forward-timeout', 'pairing-failed', 'permission-setup-failed', 'revoke-failed', 'admin-failed', 'stop-failed', 'update-failed', 'boot-failed',
  'request-busy', 'not-connected', 'cancelled', 'tailscale-unapproved']
const sample = (key: string): string[] => key === 'sameHost' ? ['forge'] : ['aheadForRestart', 'olderOwned', 'olderNotOwned', 'differentOwned', 'differentNotOwned'].includes(key) ? ['0.1.40'] : []
const holdsTo = (words: FailureWords, saved: string): void => {
  expect(english(words.saved)).toBe(saved)
  expect(english(words.unsaved)).toBe(unsavedText(saved))
}

afterEach(async () => {
  // Every test file reads English (tests/setup.ts); a test that changed it puts it back.
  await new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'] }).apply({ interfaceLanguage: 'en' })
  i18n.loadAndActivate({ locale: 'en', messages: {} })
})

describe('host failure words', () => {
  it('shows a failure in the interface language and says it to a model in English', async () => {
    await new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'], override: 'en-XA' }).apply({ interfaceLanguage: 'system' })
    const words = sshFailureWords(new SshFailure('identity-file-unreadable'))!
    expect(shown(words.saved)).not.toBe(english(words.saved))
    expect(english(words.saved)).toBe(new SshFailure('identity-file-unreadable').message)
    const said = new WordedError(CONNECT_FAILURES.credentialsUnavailable())
    expect(said.message).not.toBe('Secure credential storage is unavailable. Unlock it before connecting again.')
    expect(englishOf(said, '')).toBe('Secure credential storage is unavailable. Unlock it before connecting again.')
    expect(englishOf(new SaidError(CONNECT_FAILURES.busy().saved), '')).toBe(HOST_BUSY)
    expect(englishOf(new Error('As it came.'), '')).toBe('As it came.')
  })

  it('says every SSH failure as the host writes it, and Add host’s sentence as the row’s English made it', () => {
    for (const code of CODES) holdsTo(sshFailureWords(new SshFailure(code))!, new SshFailure(code).message)
    for (const code of ['node-too-old', 'node-too-new'] as const) holdsTo(sshFailureWords(SshFailure.node(code, '18.2.0'))!, SshFailure.node(code, '18.2.0').message)
    // A version that is not plainly one is the code's own sentence.
    expect(SshFailure.node('node-too-old', 'v18 (custom)').standard).toBe(true)
    for (const platform of ['win32', 'linux', 'darwin'] as const) holdsTo(sshFailureWords(SshFailure.sshTooOld('8.1p1', platform))!, SshFailure.sshTooOld('8.1p1', platform).message)
    for (const liveWait of ['forward', 'request'] as const) {
      const held = classifySshExit({ stderr: '', heldForApproval: true, liveWait }, 'ssh-failed')
      holdsTo(sshFailureWords(held)!, held.message)
    }
    expect(Object.keys(SSH_FAILURE_VARIANTS).sort()).toEqual(['holdForward', 'holdRequest', 'nodeTooNewVersion', 'nodeTooOldVersion', 'sshTooOldElsewhere', 'sshTooOldWindows'])
  })

  it('keeps an SSH failure that carries its own words as they came', () => {
    const own = new SshFailure('not-connected', 'Connect to the SSH host before stopping it.')
    expect(sshFailureWords(own)).toBeUndefined()
    expect(failureWords(own)).toEqual({ saved: own.message, unsaved: unsavedText(own.message) })
    expect(failureWords(new Error('EACCES: permission denied'))).toEqual({ saved: 'EACCES: permission denied', unsaved: 'EACCES: permission denied Nothing was saved.' })
  })

  it('says each connect failure’s Add host sentence as the row’s English made it', () => {
    for (const [key, words] of Object.entries(CONNECT_FAILURES)) {
      const made = (words as (...values: string[]) => FailureWords)(...sample(key))
      expect(english(made.unsaved), key).toBe(unsavedText(english(made.saved)))
    }
    expect(english(CONNECT_FAILURES.busy().saved)).toBe(HOST_BUSY)
    expect(english(CONNECT_FAILURES.newerHost().saved)).toBe(hostVersionMismatch('0.1.40', '999.0.0', true))
    expect(english(CONNECT_FAILURES.olderOwned('0.1.40').saved)).toBe(hostVersionMismatch('0.1.40', '0.0.1', true))
    expect(english(CONNECT_FAILURES.olderNotOwned('0.1.40').saved)).toBe(hostVersionMismatch('0.1.40', '0.0.1', false))
    expect(english(CONNECT_FAILURES.differentOwned('0.1.40').saved)).toBe(hostVersionMismatch('0.1.40', undefined, true))
    expect(english(CONNECT_FAILURES.differentNotOwned('0.1.40').saved)).toBe(hostVersionMismatch('0.1.40', undefined, false))
    expect(english(CONNECT_FAILURES.closedRefresh().unsaved)).toBe('The host connection closed. Nothing was saved. Add the host again to refresh.')
  })

  it('says each fix’s sentence as the host writes it', () => {
    const context = { target: 'forge', installPath: '~/sotto', version: '0.1.40' }
    for (const code of CODES) {
      const fix = failureFix(code, context)
      if (fix) expect(english(sshFixWords(code, fix)), code).toBe(fix.text)
    }
    expect(failureFix('archive-missing', context)?.archive).toBe('Sotto-host-0.1.40-linux-x64.tar.gz')
  })
})

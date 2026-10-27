// @vitest-environment node
import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { MainInterfaceLanguage } from '../../../src/main/interfaceLanguage'

import { WATCHER_DISABLED } from '../../../src/main/agents/watcherLaunchProfiles'
import {
  HOST_CANNOT_STAGE_SCREENSHOTS, PROVIDER_CONNECTION_NOTICES, PROVIDER_LABELS, SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE,
  SCREENSHOTS_TOO_LARGE_IN_TOTAL, type ProviderId,
} from '../../../src/shared/agents'
import { BOOT_UNSUPPORTED_REASONS, bootUnsupportedSentence } from '../../../src/shared/bootStart'
import { BRING_BACK_FROM_DESKTOP, BRING_BACK_NO_TARGET, BRING_BACK_OFF, BRING_BACK_OTHER_DESKTOP, BRING_BACK_QUESTION_GONE, BRING_BACK_UNSUPPORTED, bringBackNotConnected } from '../../../src/shared/bringChangesBack'
import { MICROPHONE_NOT_SET_UP_DETAIL, SPEECH_MODEL_NOT_READY_DETAIL, TRANSCRIPTION_ERROR_DETAIL, TRANSCRIPTION_KEPT_DETAIL, type TranscriptionErrorCode } from '../../../src/shared/dictation'
import { HOST_BUSY, LEGACY_MANAGEMENT_UPDATE, MANAGEMENT_REMOVED } from '../../../src/shared/hostProtocol'
import { HOST_PROVIDER_JOB_WORDS, hostProviderJobTitle, type HostProviderJobCase } from '../../../src/shared/hostProviders'
import {
  bootUnsupportedWords, BRING_BACK_INTERFACE_WORDS, bringBackInInterfaceLanguage, effortColorLabel, gitMergeMethodLabel, HOST_ANSWER_LOST_WORDS, hostBusyWords, hostCannotStageScreenshotsWords, hostProviderJobHeading,
  hostProviderJobWords, inInterfaceLanguage, interactiveVisualLabel, microphoneNotSetUpDetail, opencodeHostNeedsUpdateWords,
  opencodeNotOnHostWords, shownSignInAnswer, SIGN_IN_INTERFACE_WORDS, signInWordsInInterfaceLanguage, speechModelNotReadyDetail, threadStartsUnsupportedWords, transcriptionErrorDetail, transcriptionKeptDetail,
  watcherDisabledWords, workerRoleWords,
} from '../../../src/shared/interfaceWords'
import { HOST_ANSWER_LOST, opencodeHostNeedsUpdate, opencodeNotOnHost, SIGN_IN_WORDS } from '../../../src/shared/opencodeSignIn'
import { EFFORT_COLOR_LABELS, GIT_MERGE_METHOD_LABELS, type EffortColor, type GitMergeMethod } from '../../../src/shared/settings'
import { THREAD_STARTS_UNSUPPORTED } from '../../../src/shared/threadStarts'
import { INTERACTIVE_VISUAL_LABEL } from '../../../src/shared/visuals'
import { WORKER_ROLES } from '../../../src/shared/workerRoles'

/**
 * `interfaceWords.ts` says again, as messages, words that modules the host also builds keep in English (ADR-0123). Tests
 * read English, so each message here is held to its English twin: a change to one that misses the other goes red.
 */
const keys = <K extends string>(record: Readonly<Record<K, unknown>>): K[] => Object.keys(record) as K[]
const providers = keys(PROVIDER_LABELS) as ProviderId[]
const jobCases = keys(HOST_PROVIDER_JOB_WORDS) as HostProviderJobCase[]
const transcriptionCodes = keys(TRANSCRIPTION_ERROR_DETAIL) as TranscriptionErrorCode[]

describe('interface words', () => {
  it('names each effort colourway, merge method and worker role as Settings always has', () => {
    for (const color of keys(EFFORT_COLOR_LABELS) as EffortColor[]) expect(effortColorLabel(color)).toBe(EFFORT_COLOR_LABELS[color])
    for (const method of keys(GIT_MERGE_METHOD_LABELS) as GitMergeMethod[]) expect(gitMergeMethodLabel(method)).toBe(GIT_MERGE_METHOD_LABELS[method])
    for (const role of WORKER_ROLES) expect(workerRoleWords(role.id)).toEqual({ name: role.name, what: role.what })
  })

  it('says a provider job and a host that cannot start at boot in the same words', () => {
    for (const jobCase of jobCases) {
      const { does, doing, button, start, working } = HOST_PROVIDER_JOB_WORDS[jobCase]
      expect(hostProviderJobWords(jobCase)).toEqual({ does, doing, button, start, working })
      for (const provider of providers) expect(hostProviderJobHeading(jobCase, provider, 'forge')).toBe(hostProviderJobTitle(jobCase, provider, 'forge'))
    }
    for (const reason of [...BOOT_UNSUPPORTED_REASONS, undefined]) expect(bootUnsupportedWords(reason)).toBe(bootUnsupportedSentence(reason))
  })

  it('says every OpenCode sign-in outcome as the host does', () => {
    expect(opencodeNotOnHostWords('forge')).toBe(opencodeNotOnHost('forge'))
    expect(opencodeHostNeedsUpdateWords('forge')).toBe(opencodeHostNeedsUpdate('forge'))
    for (const flag of [true, false]) {
      expect(HOST_ANSWER_LOST_WORDS.took('forge', 'Zen', flag)).toBe(HOST_ANSWER_LOST.took('forge', 'Zen', flag))
      expect(HOST_ANSWER_LOST_WORDS.notTaken('forge', 'Zen', flag)).toBe(HOST_ANSWER_LOST.notTaken('forge', 'Zen', flag))
    }
    for (const key of ['untold', 'unknown', 'unread', 'code', 'page'] as const) expect(HOST_ANSWER_LOST_WORDS[key]('forge')).toBe(HOST_ANSWER_LOST[key]('forge'))
    for (const key of ['notRunning', 'unsafePage', 'pageNotOpened', 'catalogUnread', 'unknownSource'] as const) expect(SIGN_IN_INTERFACE_WORDS[key]()).toBe(SIGN_IN_WORDS[key])
    for (const key of ['keyRefused', 'expired', 'failed', 'startFailed', 'codeRefused', 'formRefused', 'keyNotSaved', 'keyUnknown', 'signOutFailed', 'keyUnchecked'] as const) {
      expect(SIGN_IN_INTERFACE_WORDS[key]('Zen')).toBe(SIGN_IN_WORDS[key]('Zen'))
    }
    // A model count past 999 is written as it always was, never grouped.
    for (const models of [0, 1, 2, 1500]) expect(SIGN_IN_INTERFACE_WORDS.signedIn('Zen', models)).toBe(SIGN_IN_WORDS.signedIn('Zen', models))
    for (const key of [true, false]) expect(SIGN_IN_INTERFACE_WORDS.signedOut('Zen', key)).toBe(SIGN_IN_WORDS.signedOut('Zen', key))
    expect(keys(SIGN_IN_INTERFACE_WORDS).sort()).toEqual(keys(SIGN_IN_WORDS).sort())
  })

  it('finds the OpenCode sentences a sign-in answered with, a name in them included, and leaves OpenCode’s own words alone', () => {
    for (const source of ['Zen', 'A (b) [c] $d? *'] as const) {
      for (const key of ['keyRefused', 'expired', 'codeRefused', 'keyUnknown'] as const) {
        const sentence = SIGN_IN_WORDS[key](source)
        expect(signInWordsInInterfaceLanguage(sentence)).toBe(sentence)
      }
    }
    expect(signInWordsInInterfaceLanguage(SIGN_IN_WORDS.notRunning)).toBe(SIGN_IN_WORDS.notRunning)
    expect(signInWordsInInterfaceLanguage('OpenCode said something of its own.')).toBe('OpenCode said something of its own.')
    const answer = { status: 'ok', sources: { status: 'ok', zenModels: 0, sources: [{ id: 'zen' }] }, warning: SIGN_IN_WORDS.catalogUnread }
    expect(shownSignInAnswer(answer)).toEqual(answer)
  })

  it('says dictation’s failures and an interactive visual’s label as the windows always have', () => {
    for (const code of transcriptionCodes) {
      expect(transcriptionErrorDetail(code)).toBe(TRANSCRIPTION_ERROR_DETAIL[code])
      expect(transcriptionKeptDetail(code)).toBe(TRANSCRIPTION_KEPT_DETAIL[code])
    }
    expect(speechModelNotReadyDetail()).toBe(SPEECH_MODEL_NOT_READY_DETAIL)
    expect(microphoneNotSetUpDetail()).toBe(MICROPHONE_NOT_SET_UP_DETAIL)
    expect(interactiveVisualLabel()).toBe(INTERACTIVE_VISUAL_LABEL)
  })

  it('says a host’s refusals as the host and main write them', () => {
    expect(hostBusyWords()).toBe(HOST_BUSY)
    expect(threadStartsUnsupportedWords()).toBe(THREAD_STARTS_UNSUPPORTED)
    expect(hostCannotStageScreenshotsWords()).toBe(HOST_CANNOT_STAGE_SCREENSHOTS)
    expect(watcherDisabledWords()).toBe(WATCHER_DISABLED)
    expect(BRING_BACK_INTERFACE_WORDS.unsupported()).toBe(BRING_BACK_UNSUPPORTED)
    expect(BRING_BACK_INTERFACE_WORDS.off()).toBe(BRING_BACK_OFF)
    expect(BRING_BACK_INTERFACE_WORDS.noTarget()).toBe(BRING_BACK_NO_TARGET)
    expect(BRING_BACK_INTERFACE_WORDS.otherDesktop()).toBe(BRING_BACK_OTHER_DESKTOP)
    expect(BRING_BACK_INTERFACE_WORDS.notConnected('forge')).toBe(bringBackNotConnected('forge'))
    expect(BRING_BACK_INTERFACE_WORDS.questionGone()).toBe(BRING_BACK_QUESTION_GONE)
    expect(BRING_BACK_INTERFACE_WORDS.fromDesktop()).toBe(BRING_BACK_FROM_DESKTOP)
  })

  it('says every refusal of bringing changes back that main or a host sends in the interface language, and Git’s words as written', async () => {
    const sentences = [BRING_BACK_UNSUPPORTED, BRING_BACK_OFF, BRING_BACK_NO_TARGET, BRING_BACK_OTHER_DESKTOP, BRING_BACK_QUESTION_GONE, BRING_BACK_FROM_DESKTOP]
    for (const sentence of sentences) expect(bringBackInInterfaceLanguage(sentence), sentence).toBe(sentence)
    // In another language each is translated, not passed through as it came.
    await new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'], override: 'en-XA' }).apply({ interfaceLanguage: 'system' })
    try { for (const sentence of sentences) expect(bringBackInInterfaceLanguage(sentence), sentence).not.toBe(sentence) }
    finally {
      await new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'] }).apply({ interfaceLanguage: 'en' })
      i18n.loadAndActivate({ locale: 'en', messages: {} })
    }
    const git = 'Your local changes to the following files would be overwritten by merge: app.txt'
    expect(bringBackInInterfaceLanguage(git)).toBe(git)
  })

  it('shows a fixed sentence a host sends in the interface language, and any other text as it came', () => {
    for (const sentence of [SCREENSHOT_WRONG_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOTS_TOO_LARGE_IN_TOTAL, SCREENSHOT_NOT_ITS_TYPE, MANAGEMENT_REMOVED, LEGACY_MANAGEMENT_UPDATE,
      HOST_BUSY, THREAD_STARTS_UNSUPPORTED, HOST_CANNOT_STAGE_SCREENSHOTS, ...PROVIDER_CONNECTION_NOTICES]) expect(inInterfaceLanguage(sentence)).toBe(sentence)
    expect(inInterfaceLanguage('A provider wrote this.')).toBe('A provider wrote this.')
  })
})

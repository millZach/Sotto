import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, expect } from '@playwright/test'

import type { DesignCaptureMotion as CaptureMotion, DesignCaptureRequirement } from '../../scripts/design-capture-matrix.mjs'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { designThreadsFixture, type E2EScenario } from '../../src/shared/e2e'
import type { HistoryEntry } from '../../src/shared/history'
import { DEFAULT_SETTINGS, type Appearance } from '../../src/shared/settings'
import { closeSotto, firstSottoWindow, launchSotto, type LaunchedSotto, type LaunchDependencies } from '../e2e/support/sottoLaunch'

type CaptureScale = DesignCaptureRequirement['scalePercent']
/** Pinned for every launch in this suite; scripts/capture-design.mjs sets the same zone for the Node side. */
const CAPTURE_TIMEZONE = 'America/Los_Angeles'
const CAPTURE_LOCALE = 'en-US'

export const populatedHistory: readonly HistoryEntry[] = [
  {
    id: 'review-1',
    text: 'Draft the launch summary and send it to the product team before lunch.',
    createdAt: Date.UTC(2026, 6, 11, 16, 30),
    durationMs: 8_400,
    language: 'en',
    modelPreset: 'instant',
  },
  {
    id: 'review-2',
    text: 'Remember to confirm the accessibility review and installer smoke test.',
    createdAt: Date.UTC(2026, 6, 10, 22, 15),
    durationMs: 6_200,
    language: 'en',
    modelPreset: 'instant',
  },
  {
    id: 'review-3',
    text: 'The microphone notes stay local and the final transcript is copied automatically.',
    createdAt: Date.UTC(2026, 6, 9, 18, 5),
    durationMs: 10_700,
    language: 'en',
    modelPreset: 'instant',
  },
]

type DesignAgentsProfile = 'design-threads' | 'design-threads-empty'

/**
 * Saved coordinator state for the Threads page captures: agent control is
 * already on so Sotto connects to the fixture host at launch, and every
 * fixture thread but one is assigned. The coordinator's own seven-day
 * windows read the real clock, so context stamps are taken now; the page
 * itself reads the fixed E2E_THREADS_NOW.
 */
function designAgentsState(profile: DesignAgentsProfile): Record<string, unknown> {
  const fixture = designThreadsFixture()
  return {
    configuration: { provider: 'codex', enabled: true, projectsDirectory: '', defaultModelId: 'claude:sonnet',
      followupLimit: 5, speak: false, speechProvider: 'system', speechVoice: 'F1', grokSpeechVoice: 'ara', wakeModelDirectory: '', wakeRuntimeDirectory: '',
      reasoning: 'none', reasoningModel: '', reasoningEffort: '', },
    assignments: profile === 'design-threads' ? fixture.assignments.map((assignment) => ({ ...assignment, contextUpdatedAt: Date.now() })) : [],
    queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', contextSavedAt: Date.now(), outbox: [],
  }
}

async function createProfile(
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly motion?: CaptureMotion
    readonly agents?: DesignAgentsProfile
    readonly appearance?: Appearance
    readonly lightTheme?: string
    readonly darkTheme?: string
    readonly voice?: boolean
  },
): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-design-'))
  const settings = {
    ...DEFAULT_SETTINGS,
    reducedMotion: options.motion === 'reduced' ? 'on' : 'system',
    onboardingComplete: options.onboardingComplete,
    successDisplayMs: 5_000,
    appearance: options.appearance ?? DEFAULT_SETTINGS.appearance,
    lightTheme: options.lightTheme ?? DEFAULT_SETTINGS.lightTheme,
    darkTheme: options.darkTheme ?? DEFAULT_SETTINGS.darkTheme,
    // The Agents room, the wake phrase and the orb are hidden for the beta, so the captures that record them ask for
    // the coordinator by name. Everything else is captured the way an install ships.
    voiceCoordinatorEnabled: options.voice === true,
    // Memory comes on with the coordinator, as `enableVoiceCoordinator` does: the Agents room's questionnaire is
    // the memory feature's, and the captures that greet it with Not now need it there (ADR-0013).
    memoryEnabled: options.voice === true,
  }
  await writeFile(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await writeFile(join(profile, 'history.json'), `${JSON.stringify(options.history ?? [], null, 2)}\n`, 'utf8')
  if (options.agents !== undefined) await writeFile(join(profile, 'agents.json'), `${JSON.stringify(designAgentsState(options.agents), null, 2)}\n`, 'utf8')
  return profile
}

export async function withSotto(
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly motion?: CaptureMotion
    readonly scenario?: E2EScenario
    readonly scalePercent?: CaptureScale
    readonly agents?: DesignAgentsProfile
    readonly appearance?: Appearance
    readonly lightTheme?: string
    readonly darkTheme?: string
    readonly voice?: boolean
  },
  run: (launched: LaunchedSotto) => Promise<void>,
): Promise<void> {
  const profile = await createProfile(options)
  let launched: LaunchedSotto | undefined
  try {
    const scaleFactor = (options.scalePercent ?? 100) / 100
    const dependencies: LaunchDependencies = {
      createProfile: async () => { throw new Error('Design capture supplies an owned profile') },
      // Every capture reads the same clock and language whatever machine runs it:
      // the zone and locale the committed baselines were captured with.
      launch: (launchOptions = {}) => electron.launch({
        ...launchOptions,
        args: ['--disable-gpu', `--force-device-scale-factor=${scaleFactor}`, ...(launchOptions.args ?? [])],
        timezoneId: CAPTURE_TIMEZONE,
        locale: CAPTURE_LOCALE,
      }),
      firstWindow: firstSottoWindow,
      removeProfile: async () => undefined,
    }
    launched = await launchSotto(options.scenario ?? 'success', profile, dependencies)
    const motion = options.motion ?? 'normal'
    await launched.page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' })
    // The persisted mode and the theme owning it paint the root at launch. Only
    // System reads the scheme, and no fixed-mode capture depends on the machine's setting.
    const appearance = options.appearance ?? DEFAULT_SETTINGS.appearance
    if (appearance !== 'system') {
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      const owner = appearance === 'light' ? options.lightTheme ?? DEFAULT_SETTINGS.lightTheme : options.darkTheme ?? DEFAULT_SETTINGS.darkTheme
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme-id', owner)
    }
    await expect.poll(() => launched!.page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")).toBe(motion === 'reduced')
    if (motion === 'reduced') await expect(launched.page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    else await expect(launched.page.locator('html')).not.toHaveAttribute('data-reduced-motion')
    await expect.poll(() => launched!.page.evaluate<number>('devicePixelRatio')).toBeCloseTo(scaleFactor, 2)
    await run(launched)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
}


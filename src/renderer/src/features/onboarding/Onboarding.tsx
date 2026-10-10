import { Check, Mic2, MicOff } from 'lucide-react'
import React, {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'

import type { TranscriptionKeyCheck } from '../../../../shared/contracts'
import type { HostsBridge } from '../../../../shared/hosts'
import type { PhonesBridge } from '../../../../shared/phones'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useOptionalAgents } from '../../agents/AgentContext'
import { useAudioInputDevices, type MediaDevicesAdapter } from '../../audio/useAudioInputDevices'
import { OpenRouterKeyField } from '../../components/OpenRouterKeyField'
import { Button } from '../../components/Button'
import { OpenSystemSettingsButton } from '../../components/OpenSystemSettingsButton'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { SottoMark } from '../../components/SottoMark'
import { VoiceWave } from '../../components/VoiceWave'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy } from '../../platformCopy'
import { AgentsStep } from './AgentsStep'
import { ComputersStep } from './ComputersStep'
import { liveAgentState, localProjects, localProviders } from './localAgents'
import { LookStep } from './LookStep'
import { MICROPHONE_HEARD_LEVEL, type MicrophoneTestState } from './microphoneTest'
import { PhoneStep } from './PhoneStep'
import { ProjectStep } from './ProjectStep'
import './onboarding.css'

export interface OnboardingProps {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onCheckTranscriptionKey: () => Promise<TranscriptionKeyCheck>
  readonly microphoneState: MicrophoneTestState
  readonly microphoneLevel?: number
  readonly shortcut: string
  readonly platform: SottoPlatform
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  readonly onRequestMicrophone: (selectedDeviceId?: string | null) => void | Promise<void>
  readonly onStopMicrophone?: () => void | Promise<void>
  /** Stops any running test and forgets its result, without opening the microphone. */
  readonly onResetMicrophone?: () => void | Promise<void>
  /** Opens an install guide or the TestFlight page in the browser; false when it did not open. */
  readonly onOpenLink?: (url: string) => Promise<boolean>
  readonly hostsBridge?: HostsBridge | undefined
  readonly phonesBridge?: PhonesBridge | undefined
  readonly onComplete: (
    outcome: { readonly microphoneSkipped: boolean },
  ) => boolean | void | Promise<boolean | void>
}

type StepId = 'welcome' | 'look' | 'microphone' | 'key' | 'shortcut' | 'agents' | 'project' | 'computers' | 'phone'

interface SetupStep {
  readonly id: StepId
  readonly group: string
  readonly title: string
}

/** First-run setup, in order: what Sotto is, how it looks, dictation, the coding agents, and other places to use it. */
const STEPS: readonly SetupStep[] = [
  { id: 'welcome', group: 'Start', title: 'Welcome' },
  { id: 'look', group: 'Start', title: 'Look' },
  { id: 'microphone', group: 'Dictation', title: 'Microphone' },
  { id: 'key', group: 'Dictation', title: 'OpenRouter key' },
  { id: 'shortcut', group: 'Dictation', title: 'Shortcut' },
  { id: 'agents', group: 'Agents', title: 'Coding agents' },
  { id: 'project', group: 'Agents', title: 'First project' },
  { id: 'computers', group: 'Elsewhere', title: 'Other computers' },
  { id: 'phone', group: 'Elsewhere', title: 'iPhone' },
]
const GROUPS = [...new Set(STEPS.map(step => step.group))]

/**
 * The microphone test passes once Sotto hears a voice, the level Settings' test counts as one, for this long in all,
 * a quiet stretch taking a third of its own length back.
 */
const HEARD_MS = 300
const LEVEL_READ_MS = 50
/** How long the test listens before it says it has heard nothing yet. */
const NOTHING_HEARD_MS = 6000

const openInBrowser = async (url: string): Promise<boolean> => {
  const result = await window.sotto?.openExternalLink?.(url).catch(() => null)
  return result?.ok === true
}

/** A step's heading and one-line lead. The bar above the card already names the step, so only the welcome has an eyebrow. */
function StepHeading({ title, lead, headingRef }: {
  readonly title: string
  readonly lead: ReactNode
  readonly headingRef: RefObject<HTMLHeadingElement | null>
}): ReactNode {
  return (
    <>
      <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>{title}</h1>
      <p className="onboarding-lead">{lead}</p>
    </>
  )
}

export function Onboarding({
  settings,
  onUpdateSettings,
  onCheckTranscriptionKey,
  microphoneState,
  microphoneLevel = 0,
  shortcut,
  platform,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  onRequestMicrophone,
  onStopMicrophone,
  onResetMicrophone,
  onOpenLink = openInBrowser,
  hostsBridge,
  phonesBridge,
  onComplete,
}: OnboardingProps): ReactNode {
  const [index, setIndex] = useState(0)
  const step = STEPS[index]!
  const [microphoneId, setMicrophoneId] = useState(settings.microphoneId)
  const [savedMicrophoneId, setSavedMicrophoneId] = useState(settings.microphoneId)
  if (settings.microphoneId !== savedMicrophoneId) {
    setSavedMicrophoneId(settings.microphoneId)
    setMicrophoneId(settings.microphoneId)
  }
  const savedMicrophoneRef = useRef(settings.microphoneId)
  savedMicrophoneRef.current = settings.microphoneId
  const microphoneSaveRef = useRef(0)
  const [microphoneSaveFailed, setMicrophoneSaveFailed] = useState(false)
  const [skipRequested, setSkipRequested] = useState(false)
  const [pasteTest, setPasteTest] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [completionError, setCompletionError] = useState(false)
  const [hostCount, setHostCount] = useState(0)
  // The test the user started on this visit to the step, whether it has heard a voice, and the test that has heard
  // nothing for NOTHING_HEARD_MS. Leaving the step closes the microphone; a new test or another microphone starts over.
  const [microphoneOpen, setMicrophoneOpen] = useState(false)
  const [microphoneHeard, setMicrophoneHeard] = useState(false)
  const [testRun, setTestRun] = useState(0)
  const [quietRun, setQuietRun] = useState<number | null>(null)
  const levelRef = useRef(microphoneLevel)
  levelRef.current = microphoneLevel
  const headingRef = useRef<HTMLHeadingElement>(null)
  const copy = platformCopy(platform)
  const { devices: microphones, state: deviceState } = useAudioInputDevices(mediaDevices, microphoneState)
  const microphoneKnown = settings.microphoneId === null || microphones.some(({ deviceId }) => deviceId === settings.microphoneId)
  const agentState = liveAgentState(useOptionalAgents()?.state)

  useEffect(() => {
    headingRef.current?.focus()
  }, [index])

  const stopMicrophoneRef = useRef(onStopMicrophone)
  stopMicrophoneRef.current = onStopMicrophone
  const onMicrophoneStep = step.id === 'microphone'
  useEffect(() => {
    if (!onMicrophoneStep) void Promise.resolve(stopMicrophoneRef.current?.()).catch(() => undefined)
    return () => {
      if (onMicrophoneStep) void Promise.resolve(stopMicrophoneRef.current?.()).catch(() => undefined)
    }
  }, [onMicrophoneStep])

  // The test listens until it hears a voice, then closes the microphone: hearing one is what passes it.
  // The level is read on a timer rather than as it changes, so a voice held at one level still counts.
  const listening = onMicrophoneStep && microphoneOpen && microphoneState === 'ready' && !microphoneHeard
  useEffect(() => {
    if (!listening) return
    let loudMs = 0
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - last
      last = now
      loudMs = Math.max(0, loudMs + (levelRef.current > MICROPHONE_HEARD_LEVEL ? elapsed : -elapsed / 3))
      if (loudMs < HEARD_MS) return
      clearInterval(timer)
      setMicrophoneHeard(true)
      setMicrophoneOpen(false)
      void Promise.resolve(stopMicrophoneRef.current?.()).catch(() => undefined)
    }, LEVEL_READ_MS)
    return () => clearInterval(timer)
  }, [listening])
  useEffect(() => {
    if (!listening) return
    const run = testRun
    const timer = setTimeout(() => setQuietRun(run), NOTHING_HEARD_MS)
    return () => clearTimeout(timer)
  }, [listening, testRun])
  const nothingHeard = listening && quietRun === testRun

  const stopTest = (): void => {
    setMicrophoneOpen(false)
    void Promise.resolve(onStopMicrophone?.()).catch(() => undefined)
  }
  // What the test box says: what happened, and what to do next.
  const testStatus: { readonly title: string; readonly next: string } = microphoneHeard ? { title: 'Sotto heard you. Your microphone works.', next: 'Test again after changing the microphone.' }
    : nothingHeard ? { title: 'Nothing heard yet.', next: 'Check that the microphone above is the one you speak into, then say something.' }
    : listening ? { title: 'Listening. Say something.', next: 'The test passes once Sotto hears your voice.' }
    : microphoneState === 'requesting' ? { title: 'Opening the microphone…', next: '' }
    : microphoneState === 'denied' ? { title: 'Microphone access is blocked.', next: '' }
    : microphoneState === 'missing' ? { title: 'No microphone was found.', next: '' }
    : microphoneState === 'error' ? { title: 'The microphone test could not start.', next: 'Try again, or choose another microphone.' }
    : { title: 'Not tested yet.', next: 'Press Test microphone, then say a few words.' }

  const testMicrophone = (): void => {
    setMicrophoneHeard(false)
    setMicrophoneOpen(true)
    setTestRun(run => run + 1)
    void onRequestMicrophone(microphoneId)
  }

  // A test that later reports ready retires the skip, so finishing after a
  // second attempt leaves the dictation surfaces in their working state.
  // Dictation needs access to the microphone, which a test that has not yet
  // heard a voice has already confirmed.
  const microphoneSkipped = skipRequested && microphoneState !== 'ready'

  // Whether a step's own task is done, which decides whether moving on is Continue or Skip for now.
  const stepDone = (id: StepId): boolean => {
    switch (id) {
      case 'microphone': return microphoneHeard
      case 'key': return settings.llmApiKey.length > 0
      case 'agents': return agentState !== null && localProviders(agentState).some(provider => provider.connection === 'connected')
      case 'project': return agentState !== null && localProjects(agentState).length > 0
      case 'computers': return hostCount > 0
      default: return true
    }
  }

  const goBack = (): void => {
    setMicrophoneOpen(false)
    setIndex(current => Math.max(0, current - 1))
  }
  const advance = (): void => {
    if (step.id === 'microphone' && microphoneState !== 'ready') setSkipRequested(true)
    setMicrophoneOpen(false)
    setIndex(current => Math.min(STEPS.length - 1, current + 1))
  }

  // A picker change records the choice and retires the previous input's test:
  // a result belongs to one input, so Continue waits for a test of the new one.
  // Opening the microphone waits for the Test button: arrowing through a closed
  // picker must not open capture or raise the system's permission prompt once
  // per option.
  const chooseMicrophone = async (next: string | null): Promise<void> => {
    const sequence = ++microphoneSaveRef.current
    setMicrophoneId(next)
    setMicrophoneHeard(false)
    setMicrophoneOpen(false)
    void Promise.resolve(onResetMicrophone?.()).catch(() => undefined)
    setMicrophoneSaveFailed(false)
    const saved = await onUpdateSettings({ microphoneId: next }).catch(() => false)
    if (sequence !== microphoneSaveRef.current || saved) return
    setMicrophoneId(savedMicrophoneRef.current)
    setMicrophoneSaveFailed(true)
  }

  const finish = async (): Promise<void> => {
    if (finishing || (microphoneState !== 'ready' && !microphoneSkipped)) return
    setFinishing(true)
    setCompletionError(false)
    try {
      const completed = await onComplete({ microphoneSkipped })
      if (completed === false) setCompletionError(true)
    } catch {
      setCompletionError(true)
    } finally {
      setFinishing(false)
    }
  }

  const heading = (title: string, lead: ReactNode): ReactNode =>
    <StepHeading title={title} lead={lead} headingRef={headingRef} />

  const last = index === STEPS.length - 1
  const done = stepDone(step.id)

  return (
    <main className="onboarding-shell" aria-labelledby="onboarding-heading">
      <nav className="onboarding-progress" aria-label={`Setup progress: step ${index + 1} of ${STEPS.length}`}>
        <span className="onboarding-progress__text" aria-live="polite" aria-atomic="true">
          Step {index + 1} of {STEPS.length} · {step.title}
        </span>
        <ol aria-hidden="true">
          {GROUPS.map(group => {
            const members = STEPS.map((member, at) => ({ member, at })).filter(({ member }) => member.group === group)
            return (
              <li key={group} data-current={step.group === group} style={{ flexGrow: members.length }}>
                <span className="onboarding-progress__bars">
                  {members.map(({ at }) => <i key={at} data-complete={at < index} data-current={at === index} />)}
                </span>
                <span className="onboarding-progress__group">{group}</span>
              </li>
            )
          })}
        </ol>
      </nav>

      <Card className="onboarding-card">
        {/* The step scrolls inside the card, so Back and the way forward always stay in view. */}
        <div className="onboarding-card__body">
          {step.id === 'welcome' ? (
            <section aria-labelledby="onboarding-heading">
              <SottoMark className="onboarding-welcome__mark" />
              <p className="onboarding-eyebrow">Welcome to Sotto</p>
              {heading('Talk to your computer and your coding agents', platform === 'linux'
                ? 'Hold F9 to talk after installing Sotto’s compositor bindings in Hyprland, and Sotto copies your words, then pastes them into the focused app or terminal. Sotto also runs Codex, Claude Code, Grok Build and Devin threads in one window, on this computer or another.'
                : 'Press a shortcut and speak, and your words arrive as text wherever you were typing. Sotto also runs Codex, Claude Code, Grok Build and Devin threads in one window, on this computer or another.')}
              <div className="onboarding-assurances">
                <p><Check aria-hidden="true" size={18} /> Transcribed by Microsoft MAI-Transcribe-2 through OpenRouter</p>
                <p><Check aria-hidden="true" size={18} /> Audio leaves this computer only while you dictate</p>
                <p><Check aria-hidden="true" size={18} /> Your threads go only to each agent's own provider</p>
                <p><Check aria-hidden="true" size={18} /> No Sotto account, no telemetry</p>
              </div>
              <p className="onboarding-aside">Every step after this one can be skipped and finished later in Settings.</p>
            </section>
          ) : null}

          {step.id === 'look' ? (
            <LookStep settings={settings} platform={platform} onUpdateSettings={onUpdateSettings}
              heading={heading('Choose how Sotto looks', 'Pick light or dark and a theme. The window and the owl follow your choice.')} />
          ) : null}

          {step.id === 'microphone' ? (
            <section aria-labelledby="onboarding-heading">
              {heading('Check your microphone', 'Sotto opens the microphone only while you dictate or run this test.')}
              <Field
                className="onboarding-microphone-picker"
                label="Microphone"
                {...(deviceState === 'error' ? { description: copy.settingsMicrophoneUnavailable } : {})}
                {...(microphoneSaveFailed ? { error: 'Sotto could not save that microphone. The previous one is still selected.' } : {})}
              >
                <Select
                  value={microphoneId ?? ''}
                  onChange={(event) => void chooseMicrophone(event.currentTarget.value || null)}
                >
                  <option value="">{copy.settingsMicrophoneDefaultOption}</option>
                  {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>Previous microphone (unavailable)</option> : null}
                  {microphones.map((microphone, at) => (
                    <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || `Microphone ${at + 1}`}</option>
                  ))}
                </Select>
              </Field>
              <div className="onboarding-microphone-test" data-state={microphoneHeard ? 'heard' : listening ? 'listening' : microphoneState}>
                {microphoneHeard
                  ? <span className="onboarding-microphone-test__heard"><Check aria-hidden="true" size={18} /></span>
                  // The wave the widget and the Dictate room show; it listens for as long as the test's stream runs.
                  : <VoiceWave stage={microphoneState === 'requesting' || listening ? 'listening' : 'idle'} value={microphoneLevel} label="Microphone level" size="deck" holdSpeaking={listening} />}
                <p role="status"><strong>{testStatus.title}</strong>{testStatus.next ? <span>{testStatus.next}</span> : null}</p>
                {/* One button that changes with the test, so focus stays on it from Test to Stop to Test again. */}
                <Button
                  variant={listening || microphoneHeard ? 'secondary' : 'primary'}
                  aria-disabled={microphoneState === 'requesting'}
                  onClick={microphoneState === 'requesting' ? undefined : listening ? stopTest : testMicrophone}
                >
                  {listening ? <MicOff aria-hidden="true" size={18} /> : <Mic2 aria-hidden="true" size={18} />}
                  {listening ? 'Stop test'
                    : microphoneState === 'denied' || microphoneState === 'missing' || microphoneState === 'error' ? 'Try microphone again'
                    : microphoneHeard ? 'Test again' : 'Test microphone'}
                </Button>
              </div>
              {microphoneSkipped ? (
                <p className="onboarding-aside">Microphone test skipped. Dictation waits until you run the test in Settings.</p>
              ) : null}
              {microphoneState === 'denied' ? (
                <>
                  <p className="onboarding-recovery">{copy.onboardingMicrophoneDenied}</p>
                  <OpenSystemSettingsButton platform={platform} pane="microphone" />
                </>
              ) : null}
              {microphoneState === 'missing' ? (
                <p className="onboarding-recovery">{copy.onboardingMicrophoneMissing}</p>
              ) : null}
            </section>
          ) : null}

          {step.id === 'key' ? (
            <section aria-labelledby="onboarding-heading">
              {heading('Connect your OpenRouter key', 'Sotto transcribes with Microsoft MAI-Transcribe-2 through OpenRouter, on your own key. Paste one from openrouter.ai/keys, then verify it.')}
              <OpenRouterKeyField apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckTranscriptionKey={onCheckTranscriptionKey} />
              <p className="onboarding-aside">You can skip this step and add a key in Settings later.</p>
            </section>
          ) : null}

          {step.id === 'shortcut' ? (
            <section aria-labelledby="onboarding-heading">
              {platform === 'linux'
                ? heading('Speak, then paste into any window', 'Install Sotto’s compositor bindings in Hyprland. Hold F9 to talk, or press Super+Ctrl+X to start and stop. Sotto copies your text, then pastes into the focused app or terminal. If paste does not get through, use Super+V, Omarchy’s universal paste.')
                : heading('One shortcut from speech to text', 'Press it to start and again to finish. Your text is always copied before Sotto pastes it.')}
              <div className="onboarding-shortcut">{platform === 'linux'
                ? <><span>Omarchy defaults</span><span>F9 · Super+Ctrl+X</span></>
                : <><span>Active shortcut</span><ShortcutKey accelerator={shortcut} platform={platform} /></>}</div>
              <Field label="Paste test" description="A safe local field for testing your clipboard or shortcut.">
                <textarea
                  className="tt-input onboarding-paste-field"
                  value={pasteTest}
                  onChange={(event) => setPasteTest(event.currentTarget.value)}
                  placeholder="Paste or type here"
                />
              </Field>
              {microphoneSkipped ? <p className="onboarding-aside">Microphone test skipped. Run it in Settings when you want to dictate.</p> : null}
            </section>
          ) : null}

          {step.id === 'agents' ? (
            <AgentsStep onOpenLink={onOpenLink}
              heading={heading('Your coding agents', 'Sotto connects every agent installed on this computer, each signed in with your own account.')} />
          ) : null}

          {step.id === 'project' ? (
            <ProjectStep
              heading={heading('Choose a project folder', 'A project is a folder your agents work in, usually a Git repository. Threads start in it.')} />
          ) : null}

          {step.id === 'computers' ? (
            <ComputersStep bridge={hostsBridge ?? window.sotto?.hosts} onHostsChange={setHostCount}
              heading={heading('Run agents on another computer', 'Sotto can run threads on another PC, a Mac or a Linux box over Tailscale or SSH, and show them here.')} />
          ) : null}

          {step.id === 'phone' ? (
            <>
              <PhoneStep phoneAccess={settings.phoneAccess} onUpdateSettings={onUpdateSettings} onOpenLink={onOpenLink}
                bridge={phonesBridge ?? window.sotto?.phones}
                heading={heading('Answer your threads from your iPhone', 'The beta reads and answers threads on your computers, questions included. It needs Tailscale on the iPhone and on this computer.')} />
              {completionError ? <p className="onboarding-completion-error" role="alert">Setup could not be saved. Your choices are intact; please try again.</p> : null}
            </>
          ) : null}
        </div>

        <footer className="onboarding-actions">
          {index > 0 ? <Button variant="ghost" onClick={goBack} disabled={finishing}>Back</Button> : <span />}
          {step.id === 'welcome' ? <Button onClick={advance}>Get started</Button> : null}
          {step.id !== 'welcome' && !last ? <Button variant={done ? 'primary' : 'secondary'} onClick={advance}>{done ? 'Continue' : 'Skip for now'}</Button> : null}
          {last ? (
            <Button onClick={() => void finish()} disabled={(microphoneState !== 'ready' && !microphoneSkipped) || finishing}>
              {finishing ? 'Saving setup...' : 'Finish setup'}
            </Button>
          ) : null}
        </footer>
      </Card>
    </main>
  )
}

import { Check, FolderOpen, KeyRound, Keyboard, Mic2, Palette, Server, Smartphone, SquareTerminal } from 'lucide-react'
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
import type { MicrophoneTestState } from './microphoneTest'
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
  readonly icon?: typeof Check
}

/** First-run setup, in order: what Sotto is, how it looks, dictation, the coding agents, and other places to use it. */
const STEPS: readonly SetupStep[] = [
  { id: 'welcome', group: 'Start', title: 'Welcome' },
  { id: 'look', group: 'Start', title: 'Look', icon: Palette },
  { id: 'microphone', group: 'Dictation', title: 'Microphone', icon: Mic2 },
  { id: 'key', group: 'Dictation', title: 'OpenRouter key', icon: KeyRound },
  { id: 'shortcut', group: 'Dictation', title: 'Shortcut', icon: Keyboard },
  { id: 'agents', group: 'Agents', title: 'Coding agents', icon: SquareTerminal },
  { id: 'project', group: 'Agents', title: 'First project', icon: FolderOpen },
  { id: 'computers', group: 'Elsewhere', title: 'Other computers', icon: Server },
  { id: 'phone', group: 'Elsewhere', title: 'iPhone', icon: Smartphone },
]
const GROUPS = [...new Set(STEPS.map(step => step.group))]

const openInBrowser = async (url: string): Promise<boolean> => {
  const result = await window.sotto?.openExternalLink?.(url).catch(() => null)
  return result?.ok === true
}

function StepHeading({ eyebrow, title, lead, headingRef }: {
  readonly eyebrow: string
  readonly title: string
  readonly lead: ReactNode
  readonly headingRef: RefObject<HTMLHeadingElement | null>
}): ReactNode {
  return (
    <>
      <p className="onboarding-eyebrow">{eyebrow}</p>
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
  const [betaOpened, setBetaOpened] = useState(false)
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

  // A test that later reports ready retires the skip, so finishing after a
  // second attempt leaves the dictation surfaces in their working state.
  const microphoneSkipped = skipRequested && microphoneState !== 'ready'

  // Whether a step's own task is done, which decides whether moving on is Continue or Skip for now.
  const stepDone = (id: StepId): boolean => {
    switch (id) {
      case 'microphone': return microphoneState === 'ready'
      case 'key': return settings.llmApiKey.length > 0
      case 'agents': return agentState !== null && localProviders(agentState).some(provider => provider.connection === 'connected')
      case 'project': return agentState !== null && localProjects(agentState).length > 0
      case 'computers': return hostCount > 0
      case 'phone': return betaOpened || settings.phoneAccess
      default: return true
    }
  }

  const goBack = (): void => setIndex(current => Math.max(0, current - 1))
  const advance = (): void => {
    if (step.id === 'microphone' && microphoneState !== 'ready') setSkipRequested(true)
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

  const heading = (eyebrow: string, title: string, lead: ReactNode): ReactNode =>
    <StepHeading eyebrow={eyebrow} title={title} lead={lead} headingRef={headingRef} />

  const last = index === STEPS.length - 1
  const done = stepDone(step.id)
  const StepIcon = step.icon

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
          {StepIcon ? <div className="onboarding-step-icon"><StepIcon aria-hidden="true" size={22} strokeWidth={1.8} /></div> : null}

          {step.id === 'welcome' ? (
            <section aria-labelledby="onboarding-heading">
              <SottoMark className="onboarding-welcome__mark" />
              {heading('Welcome to Sotto', 'Talk to your computer and your coding agents', platform === 'linux'
                ? 'Start dictation in Sotto, speak, then stop, and your words are copied for you to paste. Sotto also runs Codex, Claude Code, Grok Build and Devin threads in one window, on this computer or another.'
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
              heading={heading('Look', 'Choose how Sotto looks', 'Pick light or dark and a theme. The window and the owl follow your choice.')} />
          ) : null}

          {step.id === 'microphone' ? (
            <section aria-labelledby="onboarding-heading">
              {heading('Microphone', 'Check your microphone', 'Sotto needs microphone access only while you record or run this test. Choose the input you will speak into if more than one is available. Test your microphone or choose Skip for now to continue.')}
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
              <div className="onboarding-microphone-test" data-state={microphoneState}>
                {/* The wave the widget and the Dictate room show; it listens for as long as the test's stream runs. */}
                <VoiceWave stage={microphoneState === 'requesting' || microphoneState === 'ready' ? 'listening' : 'idle'} value={microphoneLevel} label="Microphone level" size="deck" holdSpeaking={microphoneState === 'ready'} />
                <p role="status">
                  {microphoneState === 'ready' ? 'Microphone ready. Access is confirmed; retest any time to check current input activity.' : null}
                  {microphoneState === 'requesting' ? 'Checking the microphone...' : null}
                  {microphoneState === 'idle' ? 'Run a quick input-level test.' : null}
                  {microphoneState === 'denied' ? 'Microphone access is blocked.' : null}
                  {microphoneState === 'missing' ? 'No microphone was found.' : null}
                  {microphoneState === 'error' ? 'The microphone test could not start.' : null}
                </p>
                <Button
                  variant={microphoneState === 'ready' ? 'secondary' : 'primary'}
                  disabled={microphoneState === 'requesting'}
                  onClick={() => void onRequestMicrophone(microphoneId)}
                >
                  <Mic2 aria-hidden="true" size={18} />
                  {microphoneState === 'denied' || microphoneState === 'missing' || microphoneState === 'error'
                    ? 'Try microphone again'
                    : microphoneState === 'ready' ? 'Retest microphone' : 'Test microphone'}
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
              {heading('Transcription', 'Connect your OpenRouter key', 'Sotto transcribes with Microsoft MAI-Transcribe-2 through OpenRouter, on your own key. Paste a key from openrouter.ai/keys, then verify it.')}
              <OpenRouterKeyField apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckTranscriptionKey={onCheckTranscriptionKey} />
              <p className="onboarding-aside">You can skip this step and add a key in Settings later.</p>
            </section>
          ) : null}

          {step.id === 'shortcut' ? (
            <section aria-labelledby="onboarding-heading">
              {platform === 'linux'
                ? heading('Shortcut & paste', 'Copy your words, then paste', 'On Wayland, use the dictation button to start and stop. Your text is copied for you to paste with Ctrl+V, or Shift+Insert in a terminal.')
                : heading('Shortcut & paste', 'One shortcut from speech to text', 'Press this shortcut to start. Press it again to finish. Your text is always copied before Sotto attempts to paste.')}
              <div className="onboarding-shortcut"><span>{platform === 'linux' ? 'Saved shortcut' : 'Active shortcut'}</span><ShortcutKey accelerator={shortcut} platform={platform} /></div>
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
              heading={heading('Coding agents', 'Check your coding agents', 'Sotto drives the agents installed on this computer, each signed in with your own account.')} />
          ) : null}

          {step.id === 'project' ? (
            <ProjectStep
              heading={heading('First project', 'Choose a project folder', 'A project is a folder your agents work in, usually a Git repository. Threads start in it, and the sidebar lists them under its name.')} />
          ) : null}

          {step.id === 'computers' ? (
            <ComputersStep bridge={hostsBridge ?? window.sotto?.hosts} onHostsChange={setHostCount}
              heading={heading('Other computers', 'Run agents on another computer', "If you have another PC, a Mac or a Linux box, Sotto can run threads there and show them here beside this computer's. It reaches them over Tailscale or SSH.")} />
          ) : null}

          {step.id === 'phone' ? (
            <>
              <PhoneStep phoneAccess={settings.phoneAccess} onUpdateSettings={onUpdateSettings} onOpenLink={onOpenLink}
                bridge={phonesBridge ?? window.sotto?.phones} onBetaOpened={() => setBetaOpened(true)}
                heading={heading('iPhone', 'Answer your threads from your iPhone', 'The iPhone app is in beta. It reads and answers threads on your computers, including questions and permissions waiting for you. It needs Tailscale on the iPhone and on this computer.')} />
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

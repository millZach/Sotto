import React, { useEffect, useState, type ReactNode } from 'react'
import { NATURAL_VOICES, type AgentConfiguration, type AgentVoiceModelStatus } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import voiceLicense from '../../../../docs/notices/supertonic-LICENSE.txt?raw'

function speechError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : 'The voice could not be prepared. Try again.'
}

export function VoiceSettings({ configuration, command, change }: {
  readonly configuration: AgentConfiguration
  readonly command: AgentConnection['command']
  readonly change: <K extends keyof AgentConfiguration>(key: K, value: AgentConfiguration[K]) => void
}): ReactNode {
  const [model, setModel] = useState<AgentVoiceModelStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const natural = configuration.speechProvider === 'natural'
  useEffect(() => {
    if (!natural) return
    let active = true
    const update = (): void => { void window.sotto?.agents?.voiceModel?.('status').then(status => { if (active) setModel(status) }).catch(error => { if (active) setError(speechError(error)) }) }
    update()
    const timer = downloading ? setInterval(update, 750) : undefined
    return () => { active = false; clearInterval(timer) }
  }, [natural, downloading])
  const download = async (): Promise<void> => {
    const operation = window.sotto?.agents?.voiceModel
    if (!operation) { setError('Voice setup is unavailable. Reopen the updated app.'); return }
    setDownloading(true); setError(''); setNotice('')
    try { setModel(await operation('download')); setNotice('Natural voices are ready. Choose one and preview it.') }
    catch (error) { setError(speechError(error)) }
    finally { setDownloading(false) }
  }
  const preview = async (): Promise<void> => {
    setPreviewing(true); setError(''); setNotice('')
    try {
      const saved = await command({ type: 'configure', patch: { speechProvider: configuration.speechProvider, speechVoice: configuration.speechVoice, speak: true } })
      if (!saved || saved.error) { setError(saved?.error ?? 'The voice settings could not be saved.'); return }
      change('speak', true)
      const result = await command({ type: 'preview-voice' })
      if (!result || result.error) setError(result?.error ?? 'The voice preview could not start.')
      else setNotice('Voice saved. Your preview will play through the selected output device.')
    } finally { setPreviewing(false) }
  }
  return <div className="agent-field-wide agent-voice-settings">
    <label className="agent-checkbox"><input type="checkbox" checked={configuration.speak} onChange={event => change('speak', event.target.checked)} />Spoken replies</label>
    <div className="agent-fields">
      <label>Speech voice<select aria-label="Speech voice" value={configuration.speechProvider} onChange={event => { change('speechProvider', event.target.value as AgentConfiguration['speechProvider']); setError(''); setNotice('') }}>
        <option value="natural">Natural voice · on this computer</option>
        <option value="system">System voice</option>
      </select></label>
      {natural ? <label>Voice<select aria-label="Voice" value={configuration.speechVoice} onChange={event => { change('speechVoice', event.target.value as AgentConfiguration['speechVoice']); setNotice('') }}>
        {NATURAL_VOICES.map(voice => <option key={voice} value={voice}>{voice.startsWith('F') ? 'Female' : 'Male'} {voice.slice(1)}</option>)}
      </select></label> : null}
    </div>
    <p className="agent-hint">{natural ? 'AI-generated voices by Supertonic. Replies stay on this computer. One 263 MB download, with no usage charges.' : 'Uses the voice installed with your operating system.'}</p>
    {natural ? <details className="agent-voice-license"><summary>Voice model terms · OpenRAIL-M</summary><p>Downloading and using these voices is subject to these model terms, including the use restrictions in Attachment A.</p><pre>{voiceLicense}</pre></details> : null}
    <div className="agent-voice-actions">
      {natural && !model?.ready ? <Button variant="secondary" disabled={downloading} onClick={() => void download()}>{downloading ? `Downloading voices · ${Math.floor((model?.completedBytes ?? 0) / 1_000_000)} MB` : 'Download natural voices'}</Button> : null}
      <Button variant="secondary" disabled={previewing || downloading || (natural && !model?.ready)} onClick={() => void preview()}>Use and preview voice</Button>
    </div>
    {downloading ? <progress aria-label="Natural voice download" max={model?.totalBytes || 263_304_827} value={model?.completedBytes ?? 0} /> : null}
    {notice ? <p className="agent-hint" role="status">{notice}</p> : null}
    {error ? <p className="agent-error" role="alert">{error}</p> : null}
  </div>
}

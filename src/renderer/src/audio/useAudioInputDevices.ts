import { useEffect, useState } from 'react'

export type MediaDevicesAdapter = Pick<
  MediaDevices,
  'enumerateDevices' | 'addEventListener' | 'removeEventListener'
>

export type AudioInputDeviceState = 'loading' | 'ready' | 'error'

/**
 * Live audio inputs for the Settings and onboarding pickers. Empty device IDs
 * are the browser's unnamed default and duplicate the "system default" option,
 * so they are omitted. `refreshToken` re-runs enumeration after permission
 * so labels appear.
 */
export function useAudioInputDevices(
  mediaDevices: MediaDevicesAdapter | undefined,
  refreshToken?: unknown,
): {
  readonly devices: readonly MediaDeviceInfo[]
  readonly state: AudioInputDeviceState
} {
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([])
  const [state, setState] = useState<AudioInputDeviceState>(
    mediaDevices === undefined ? 'error' : 'loading',
  )

  useEffect(() => {
    if (mediaDevices === undefined) {
      setDevices([])
      setState('error')
      return
    }
    let current = true
    let refreshVersion = 0
    const refresh = async (): Promise<void> => {
      const version = ++refreshVersion
      try {
        const listed = await mediaDevices.enumerateDevices()
        if (!current || version !== refreshVersion) return
        setDevices(listed.filter((candidate) => candidate.kind === 'audioinput' && candidate.deviceId !== ''))
        setState('ready')
      } catch {
        if (current && version === refreshVersion) setState('error')
      }
    }
    const onDeviceChange = (): void => { void refresh() }
    void refresh()
    try {
      mediaDevices.addEventListener('devicechange', onDeviceChange)
    } catch {
      // Enumeration still works when device-change observation is unavailable.
    }
    return () => {
      current = false
      try { mediaDevices.removeEventListener('devicechange', onDeviceChange) } catch {
        // Enumeration remains disposable even on older media-device implementations.
      }
    }
  }, [mediaDevices, refreshToken])

  return { devices, state }
}

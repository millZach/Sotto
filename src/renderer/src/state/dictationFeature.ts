import { dictationOn } from '../../../shared/settings'
import { useOptionalApp } from './AppContext'
import { useOwlFeature } from './owlFeature'

/** Whether Sotto dictates here (ADR-0107). Settings not yet loaded count as on, so nothing flickers away at start. */
export function useDictationOn(): boolean {
  const owlFeatureOn = useOwlFeature('dictation-off')
  const settings = useOptionalApp()?.settings
  return settings === null || settings === undefined ? true : dictationOn(settings, owlFeatureOn)
}

import type { DictationControllerDependencies } from './dictationController'

type Destination = DictationControllerDependencies['deliverOutput']
let current: Destination | undefined

/** The visible personal chat registers its destination; a recording retains the captured closure. */
export function registerDictationDestination(destination: Destination): () => void {
  current = destination
  return () => { if (current === destination) current = undefined }
}

export function captureDictationDestination(): Destination | undefined {
  return document.hasFocus() ? current : undefined
}

import { t } from '@lingui/core/macro'

/**
 * What the composer says about attachments once any file can be attached (ADR-0127), in the interface language (ADR-0123).
 * The refusals match main's English constants in src/shared/agents.ts, which the host says when it refuses a file itself;
 * the window says its own here, before anything is read. With the Owl feature off, the composer keeps its screenshot words.
 */
export const attachmentsTooMany = (): string => t`Attach up to 8 files at a time. Nothing was attached.`
export const fileTooLarge = (): string => t`Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.`
export const imageTooLarge = (): string => t`Each image must be 10 MB or smaller. Nothing was attached. Choose a smaller image.`
export const imagesTooLargeInTotal = (): string => t`Images must total 20 MB or less. Nothing was attached. Remove an image or choose smaller ones.`
export const attachmentsTooLargeInTotal = (): string => t`Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.`
export const imagesNotRead = (name: string): string =>
  t({ message: `This model does not read images. Choose a model with image support, or remove ${name}.`, comment: '{name} is the file name of the image, such as "screenshot.png".' })
/** A draft that answers a question or a permission request takes no attachments. */
export const noAttachmentsOnAnswer = (): string => t`Files cannot be attached while this thread waits for your answer. Nothing was attached.`

export const pickerLabel = (): string => t`Files to attach`
export const attachButton = (): string => t`Attach files`
export const attachedImages = (): string => t`Attached images`
export const attachedFiles = (): string => t`Attached files`
export const addingFiles = (): string => t`Adding files...`
export const dropToAttach = (): string => t({ message: 'Drop to attach', comment: 'Shown over the message box while files are dragged over it.' })
export const removeAttachment = (name: string): string => t({ message: `Remove ${name}`, comment: '{name} is an attached file\'s name. The button takes it off the draft.' })

/** A file could not be staged and no sentence says why. */
export const fileStagingFailed = (): string => t`Could not add this file. Nothing was attached. Try again.`
/** A file's bytes could not be read before staging, as when it was removed or locked since it was chosen. */
export const fileReadFailed = (): string => t`Could not read this file. Nothing was attached. Try adding it again.`

/**
 * What a failed add says once others may have gone before it: which one, that it and those after it were not
 * attached, and why. `next` is staging's reason without its "Nothing was attached.", or null for none.
 */
export function addFailedWords(name: string, remaining: number, next: string | null): string {
  if (remaining === 1) return next ? t`Could not add ${name}, so it was not attached. ${next}` : t`Could not add ${name}, so it was not attached. Try adding it again.`
  const after = remaining - 1
  return next ? t`Could not add ${name}, so it and the ${after} after it were not attached. ${next}`
    : t`Could not add ${name}, so it and the ${after} after it were not attached. Try adding them again.`
}

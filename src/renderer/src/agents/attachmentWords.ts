import { t } from '@lingui/core/macro'
import {
  ATTACHED_FILE_TOO_LARGE, ATTACHED_FILES_NEED_A_FOLDER, ATTACHED_IMAGE_TOO_LARGE, ATTACHED_IMAGES_TOO_LARGE_IN_TOTAL, ATTACHMENTS_TOO_LARGE_IN_TOTAL,
  ATTACHMENTS_TOO_MANY, FILE_UPLOAD_INCOMPLETE, FILE_UPLOAD_MISMATCH, HOST_CANNOT_STAGE_FILES, HOST_DISCONNECTED_BEFORE_FILES,
} from '../../../shared/agents'

/**
 * What the composer says about attachments once any file can be attached (ADR-0131), in the interface language (ADR-0123).
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

const nothingAttached = (): string => t`Nothing was attached.`
/**
 * A sentence main or a host says about attachments (ADR-0131), built in English in shared code, as the window says it in
 * the interface language (ADR-0123). Any sentence this does not know is shown as it came.
 */
export function attachmentRefusal(sentence: string): string {
  switch (sentence) {
    case HOST_CANNOT_STAGE_FILES: return t`This host cannot keep files yet. Update Sotto there, then attach them again. Nothing was attached.`
    case HOST_DISCONNECTED_BEFORE_FILES: return t`This host is disconnected. Connect again before attaching files. Nothing was attached.`
    case FILE_UPLOAD_INCOMPLETE: return t`This file did not reach the host whole. Nothing was attached. Attach it again.`
    case FILE_UPLOAD_MISMATCH: return t`This file changed on its way to the host. Nothing was attached. Attach it again.`
    case ATTACHED_FILES_NEED_A_FOLDER: return t`This thread has no working folder, so files cannot be attached. Remove them, then send again. Your draft is saved.`
    case ATTACHMENTS_TOO_MANY: return attachmentsTooMany()
    case ATTACHED_FILE_TOO_LARGE: return fileTooLarge()
    case ATTACHED_IMAGE_TOO_LARGE: return imageTooLarge()
    case ATTACHED_IMAGES_TOO_LARGE_IN_TOTAL: return imagesTooLargeInTotal()
    case ATTACHMENTS_TOO_LARGE_IN_TOTAL: return attachmentsTooLargeInTotal()
    default: return sentence
  }
}
/** A refusal without its "Nothing was attached.", for words that already say what was not attached. */
export function withoutNothingAttached(sentence: string): string {
  return sentence.replace(nothingAttached(), ' ').replace(/ ?Nothing was attached\./u, ' ').replace(/\s+/gu, ' ').trim()
}

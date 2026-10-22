export const SETTINGS_GET = 'sotto:settings:get' as const
export const SETTINGS_UPDATE = 'sotto:settings:update' as const
export const SETTINGS_RESET = 'sotto:settings:reset' as const
export const SETTINGS_CHANGED = 'sotto:settings:changed' as const

export const RECOVERY_NOTICE_LIST = 'sotto:recovery-notice:list' as const
export const RECOVERY_NOTICE = 'sotto:recovery-notice:event' as const

export const HISTORY_LIST = 'sotto:history:list' as const
export const HISTORY_ADD = 'sotto:history:add' as const
export const HISTORY_SEARCH = 'sotto:history:search' as const
export const HISTORY_DELETE = 'sotto:history:delete' as const
export const HISTORY_CLEAR = 'sotto:history:clear' as const
/** Every dictation record (ADR-0100), for the window to count from. */
export const DICTATION_RECORDS_LIST = 'sotto:dictation-records:list' as const
/** One dictation record by its dictation's id, or null. */
export const DICTATION_RECORD_GET = 'sotto:dictation-records:get' as const

export const HOTKEY_GET = 'sotto:hotkey:get' as const
export const HOTKEY_REPLACE = 'sotto:hotkey:replace' as const
export const DICTATION_SHORTCUTS_REPLACE = 'sotto:dictation-shortcuts:replace' as const
export const DICTATION_SHORTCUTS_SUSPEND = 'sotto:dictation-shortcuts:suspend' as const
export const DICTATION_KEYS_RECORD = 'sotto:dictation-keys:record' as const
export const DICTATION_KEYS_RECORD_CANCEL = 'sotto:dictation-keys:record-cancel' as const
export const DICTATION_KEYS_HELD = 'sotto:dictation-keys:held' as const
/** Linux: a Sotto binding fired while Settings recorded keys, so Hyprland kept the keys; carries the row it belongs to. */
export const DICTATION_KEYS_TAKEN = 'sotto:dictation-keys:taken' as const
export const KEY_LISTENER_PERMISSION_GET = 'sotto:key-listener:permission' as const
export const KEY_LISTENER_PERMISSION_REQUEST = 'sotto:key-listener:permission-request' as const
export const KEY_LISTENER_PERMISSION_CHANGED = 'sotto:key-listener:permission-changed' as const

export const DICTATION_REQUEST = 'sotto:dictation:request' as const
export const DICTATION_COMMAND = 'sotto:dictation:command' as const

export const WIDGET_PUBLISH = 'sotto:widget:publish' as const
export const WIDGET_STATE = 'sotto:widget:state' as const
export const WIDGET_VISIBILITY = 'sotto:widget:visibility' as const
export const WIDGET_PRESENTATION = 'sotto:widget:presentation' as const
export const WIDGET_DRAG = 'sotto:widget:drag' as const


export const OUTPUT_DELIVER = 'sotto:output:deliver' as const
export const OUTPUT_COPY_IMAGE = 'sotto:output:copy-image' as const

export const TRANSCRIPT_POLISH = 'sotto:transcript:polish' as const

export const TRANSCRIPTION_TRANSCRIBE = 'sotto:transcription:transcribe' as const
export const TRANSCRIPTION_CANCEL = 'sotto:transcription:cancel' as const
export const SPEECH_MODEL_GET_STATUS = 'sotto:speech-model:get-status' as const
/** Retries the chosen model: resumes its download or starts it again. Nothing chosen does nothing. Progress follows on SPEECH_MODEL_STATUS. */
export const SPEECH_MODEL_DOWNLOAD = 'sotto:speech-model:download' as const
/** Every model the user can choose on this computer, looked for again on each call. */
export const SPEECH_MODEL_LIST = 'sotto:speech-model:list' as const
/** Makes a model the one dictation uses; Sotto's own downloads now if it is not here yet. */
export const SPEECH_MODEL_CHOOSE = 'sotto:speech-model:choose' as const
export const SPEECH_MODEL_STATUS = 'sotto:speech-model:status' as const
export const OPENROUTER_CHECK_KEY = 'sotto:openrouter:check-key' as const
export const MICROPHONE_ENSURE_ACCESS = 'sotto:microphone:ensure-access' as const

export const UPDATE_GET_STATUS = 'sotto:update:get-status' as const
export const UPDATE_CHECK = 'sotto:update:check' as const
export const UPDATE_DOWNLOAD = 'sotto:update:download' as const
export const UPDATE_INSTALL = 'sotto:update:install' as const
export const UPDATE_STATUS = 'sotto:update:status' as const
export const UPDATE_CHECK_REQUESTED = 'sotto:update:check-requested' as const

export const STARTUP_GET = 'sotto:startup:get' as const
export const STARTUP_SET = 'sotto:startup:set' as const

export const APP_SHOW = 'sotto:app:show' as const
export const EXTERNAL_LINK_OPEN = 'sotto:external-link:open' as const
export const QUESTION_PAGE_OPEN = 'sotto:question-page:open' as const
export const SYSTEM_SETTINGS_OPEN = 'sotto:system-settings:open' as const
export const APP_HIDE = 'sotto:app:hide' as const
export const APP_TOGGLE_MAXIMIZE = 'sotto:app:toggle-maximize' as const
export const APP_MAXIMIZED = 'sotto:app:maximized' as const
export const APP_WINDOW_HIDDEN = 'sotto:app:window-hidden' as const
export const APP_RELOAD = 'sotto:app:reload' as const
export const APP_MINIMIZE = 'sotto:app:minimize' as const
export const APP_QUIT = 'sotto:app:quit' as const

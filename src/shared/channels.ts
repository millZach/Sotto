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

export const HOTKEY_GET = 'sotto:hotkey:get' as const
export const HOTKEY_REPLACE = 'sotto:hotkey:replace' as const

export const DICTATION_REQUEST = 'sotto:dictation:request' as const
export const DICTATION_COMMAND = 'sotto:dictation:command' as const

export const WIDGET_PUBLISH = 'sotto:widget:publish' as const
export const WIDGET_STATE = 'sotto:widget:state' as const
export const WIDGET_VISIBILITY = 'sotto:widget:visibility' as const
export const WIDGET_PRESENTATION = 'sotto:widget:presentation' as const
export const WIDGET_DRAG = 'sotto:widget:drag' as const


export const OUTPUT_DELIVER = 'sotto:output:deliver' as const

export const TRANSCRIPT_POLISH = 'sotto:transcript:polish' as const

export const TRANSCRIPTION_TRANSCRIBE = 'sotto:transcription:transcribe' as const
export const TRANSCRIPTION_CANCEL = 'sotto:transcription:cancel' as const
export const TRANSCRIPTION_CHECK_KEY = 'sotto:transcription:check-key' as const

export const UPDATE_GET_STATUS = 'sotto:update:get-status' as const
export const UPDATE_CHECK = 'sotto:update:check' as const
export const UPDATE_DOWNLOAD = 'sotto:update:download' as const
export const UPDATE_INSTALL = 'sotto:update:install' as const
export const UPDATE_STATUS = 'sotto:update:status' as const

export const STARTUP_GET = 'sotto:startup:get' as const
export const STARTUP_SET = 'sotto:startup:set' as const

export const APP_SHOW = 'sotto:app:show' as const
export const EXTERNAL_LINK_OPEN = 'sotto:external-link:open' as const
export const APP_HIDE = 'sotto:app:hide' as const
export const APP_TOGGLE_MAXIMIZE = 'sotto:app:toggle-maximize' as const
export const APP_MAXIMIZED = 'sotto:app:maximized' as const
export const APP_MINIMIZE = 'sotto:app:minimize' as const
export const APP_QUIT = 'sotto:app:quit' as const

export const IPC_CHANNELS = Object.freeze({
  settingsGet: SETTINGS_GET,
  settingsUpdate: SETTINGS_UPDATE,
  settingsReset: SETTINGS_RESET,
  settingsChanged: SETTINGS_CHANGED,
  recoveryNoticeList: RECOVERY_NOTICE_LIST,
  recoveryNotice: RECOVERY_NOTICE,
  historyList: HISTORY_LIST,
  historyAdd: HISTORY_ADD,
  historySearch: HISTORY_SEARCH,
  historyDelete: HISTORY_DELETE,
  historyClear: HISTORY_CLEAR,
  hotkeyGet: HOTKEY_GET,
  hotkeyReplace: HOTKEY_REPLACE,
  dictationRequest: DICTATION_REQUEST,
  dictationCommand: DICTATION_COMMAND,
  widgetPublish: WIDGET_PUBLISH,
  widgetState: WIDGET_STATE,
  widgetVisibility: WIDGET_VISIBILITY,
  widgetPresentation: WIDGET_PRESENTATION,
  widgetDrag: WIDGET_DRAG,
  outputDeliver: OUTPUT_DELIVER,
  transcriptPolish: TRANSCRIPT_POLISH,
  transcriptionTranscribe: TRANSCRIPTION_TRANSCRIBE,
  transcriptionCancel: TRANSCRIPTION_CANCEL,
  transcriptionCheckKey: TRANSCRIPTION_CHECK_KEY,
  updateGetStatus: UPDATE_GET_STATUS,
  updateCheck: UPDATE_CHECK,
  updateDownload: UPDATE_DOWNLOAD,
  updateInstall: UPDATE_INSTALL,
  updateStatus: UPDATE_STATUS,
  startupGet: STARTUP_GET,
  startupSet: STARTUP_SET,
  appShow: APP_SHOW,
  externalLinkOpen: EXTERNAL_LINK_OPEN,
  appHide: APP_HIDE,
  appMinimize: APP_MINIMIZE,
  appToggleMaximize: APP_TOGGLE_MAXIMIZE,
  appMaximized: APP_MAXIMIZED,
  appQuit: APP_QUIT,
})

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

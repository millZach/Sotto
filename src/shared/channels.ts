export const SETTINGS_GET = 'talktype:settings:get' as const
export const SETTINGS_UPDATE = 'talktype:settings:update' as const
export const SETTINGS_RESET = 'talktype:settings:reset' as const
export const SETTINGS_CHANGED = 'talktype:settings:changed' as const

export const HISTORY_LIST = 'talktype:history:list' as const
export const HISTORY_ADD = 'talktype:history:add' as const
export const HISTORY_SEARCH = 'talktype:history:search' as const
export const HISTORY_DELETE = 'talktype:history:delete' as const
export const HISTORY_CLEAR = 'talktype:history:clear' as const

export const HOTKEY_GET = 'talktype:hotkey:get' as const
export const HOTKEY_REPLACE = 'talktype:hotkey:replace' as const

export const DICTATION_REQUEST = 'talktype:dictation:request' as const
export const DICTATION_COMMAND = 'talktype:dictation:command' as const

export const WIDGET_PUBLISH = 'talktype:widget:publish' as const
export const WIDGET_STATE = 'talktype:widget:state' as const

export const MODEL_GET_STATUS = 'talktype:model:get-status' as const
export const MODEL_LIST_DISCLOSURES = 'talktype:model:list-disclosures' as const
export const MODEL_INSTALL = 'talktype:model:install' as const
export const MODEL_REMOVE = 'talktype:model:remove' as const
export const MODEL_STATUS = 'talktype:model:status' as const

export const OUTPUT_DELIVER = 'talktype:output:deliver' as const

export const STARTUP_GET = 'talktype:startup:get' as const
export const STARTUP_SET = 'talktype:startup:set' as const

export const APP_SHOW = 'talktype:app:show' as const
export const APP_HIDE = 'talktype:app:hide' as const
export const APP_MINIMIZE = 'talktype:app:minimize' as const
export const APP_QUIT = 'talktype:app:quit' as const

export const IPC_CHANNELS = Object.freeze({
  settingsGet: SETTINGS_GET,
  settingsUpdate: SETTINGS_UPDATE,
  settingsReset: SETTINGS_RESET,
  settingsChanged: SETTINGS_CHANGED,
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
  modelGetStatus: MODEL_GET_STATUS,
  modelListDisclosures: MODEL_LIST_DISCLOSURES,
  modelInstall: MODEL_INSTALL,
  modelRemove: MODEL_REMOVE,
  modelStatus: MODEL_STATUS,
  outputDeliver: OUTPUT_DELIVER,
  startupGet: STARTUP_GET,
  startupSet: STARTUP_SET,
  appShow: APP_SHOW,
  appHide: APP_HIDE,
  appMinimize: APP_MINIMIZE,
  appQuit: APP_QUIT,
})

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

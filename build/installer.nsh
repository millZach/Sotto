!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var TalkTypeDesktopShortcutCheckbox
Var TalkTypeCreateDesktopShortcut

!macro customInit
  ClearErrors
  ReadRegDWORD $TalkTypeCreateDesktopShortcut SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcut
  ${If} ${Errors}
  StrCpy $TalkTypeCreateDesktopShortcut ${BST_UNCHECKED}
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $TalkTypeCreateDesktopShortcut ${BST_CHECKED}
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom TalkTypeShortcutPageCreate TalkTypeShortcutPageLeave
!macroend

Function TalkTypeShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "The Start Menu shortcut is always installed. You can optionally add TalkType to the desktop."
  Pop $0
  ${NSD_CreateCheckbox} 0 38u 100% 14u "Create a desktop shortcut"
  Pop $TalkTypeDesktopShortcutCheckbox
  ${NSD_SetState} $TalkTypeDesktopShortcutCheckbox $TalkTypeCreateDesktopShortcut
  nsDialogs::Show
FunctionEnd

Function TalkTypeShortcutPageLeave
  ${NSD_GetState} $TalkTypeDesktopShortcutCheckbox $TalkTypeCreateDesktopShortcut
FunctionEnd

!macro customInstall
  ${If} $TalkTypeCreateDesktopShortcut == ${BST_CHECKED}
    ${If} $oldDesktopLink != $newDesktopLink
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${EndIf}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${Else}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
    ${If} $oldDesktopLink != $newDesktopLink
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcut $TalkTypeCreateDesktopShortcut
!macroend
!else
!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
!endif

!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var SottoDesktopShortcutCheckbox
Var SottoCreateDesktopShortcut

!macro customInit
  ClearErrors
  ReadRegDWORD $SottoCreateDesktopShortcut SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcut
  ${If} ${Errors}
  StrCpy $SottoCreateDesktopShortcut ${BST_UNCHECKED}
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $SottoCreateDesktopShortcut ${BST_CHECKED}
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom SottoShortcutPageCreate SottoShortcutPageLeave
!macroend

Function SottoShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "The Start Menu shortcut is always installed. You can optionally add Sotto to the desktop."
  Pop $0
  ${NSD_CreateCheckbox} 0 38u 100% 14u "Create a desktop shortcut"
  Pop $SottoDesktopShortcutCheckbox
  ${NSD_SetState} $SottoDesktopShortcutCheckbox $SottoCreateDesktopShortcut
  nsDialogs::Show
FunctionEnd

Function SottoShortcutPageLeave
  ${NSD_GetState} $SottoDesktopShortcutCheckbox $SottoCreateDesktopShortcut
FunctionEnd

!macro customInstall
  ${If} $SottoCreateDesktopShortcut == ${BST_CHECKED}
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
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcut $SottoCreateDesktopShortcut
!macroend
!else
!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
!endif

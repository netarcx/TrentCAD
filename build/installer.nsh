!include "LogicLib.nsh"

; Override electron-builder's built-in "app is running" check — we handle
; it ourselves in customInit by force-killing the lingering process.
!macro customCheckAppRunning
!macroend

!macro customInit
  ; Kill any lingering FrameCAD process (Electron can take a few seconds
  ; to fully exit after the window closes, which makes NSIS think the app
  ; is still running and abort with "cannot close FrameCAD").
  nsExec::ExecToStack 'cmd /c taskkill /IM "FrameCAD.exe" /F 2>nul'
  Pop $0
  Pop $1
  ; Brief pause so the OS releases file handles
  Sleep 1000

  ; Block install if SolidWorks is running so we can replace the locked add-in DLLs
  framecad_sw_check:
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq SLDWORKS.exe" /NH 2>nul | find /I "SLDWORKS.exe"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "SolidWorks is currently running. The FrameCAD add-in cannot be updated while SolidWorks is open.$\n$\nClose SolidWorks and click Retry, or Cancel to abort." /SD IDCANCEL IDRETRY framecad_sw_check
    Abort "Installation aborted - close SolidWorks first."
  ${EndIf}

  ; Wipe stale Electron files from the PREVIOUS version before the new
  ; files are extracted. This must happen in customInit (pre-extract), not
  ; customInstall (post-extract), otherwise we'd delete the freshly
  ; installed files. Only touches directories/patterns that Electron owns.
  ${If} ${FileExists} "$INSTDIR\FrameCAD.exe"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\swiftshader"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\LICENSE*"
    Delete "$INSTDIR\LICENSES*"
    Delete "$INSTDIR\FrameCAD.exe"
    Delete "$INSTDIR\TrentCAD.exe"
  ${EndIf}
!macroend

!macro customInstall
  ; Unregister any existing add-in for a clean upgrade. Handle BOTH the
  ; new FrameCAD.SolidWorksAddin.dll filename AND the pre-1.1.0
  ; TrentCAD.SolidWorksAddin.dll so an upgrade from v1.0.x doesn't
  ; leave an orphan COM registration pointing at the deleted old DLL.
  ${If} ${FileExists} "$INSTDIR\solidworks-addin\FrameCAD.SolidWorksAddin.dll"
    nsExec::ExecToLog '"$WINDIR\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe" /unregister "$INSTDIR\solidworks-addin\FrameCAD.SolidWorksAddin.dll"'
    Pop $0
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\solidworks-addin\TrentCAD.SolidWorksAddin.dll"
    nsExec::ExecToLog '"$WINDIR\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe" /unregister "$INSTDIR\solidworks-addin\TrentCAD.SolidWorksAddin.dll"'
    Pop $0
  ${EndIf}

  ; Remove the old add-in folder entirely so stale files can't linger
  RMDir /r "$INSTDIR\solidworks-addin"

  ; Install new add-in files
  SetOutPath "$INSTDIR\solidworks-addin"
  SetOverwrite on
  File /r "${BUILD_RESOURCES_DIR}\solidworks-addin\*.*"

  ; Register the new add-in via RegAsm
  nsExec::ExecToLog '"$WINDIR\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe" /codebase "$INSTDIR\solidworks-addin\FrameCAD.SolidWorksAddin.dll"'
  Pop $0
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "SolidWorks add-in registration returned code $0.$\nThe add-in may not appear in SolidWorks.$\nTry running the installer as Administrator."
  ${EndIf}

  ; No Git / Git LFS / GitHub CLI auto-install: the storage backend is
  ; Google Drive now (the old Git/LFS backend was removed), so the desktop
  ; needs none of those tools. Drive access is a Google sign-in inside the
  ; app, and team identity is a PIN — nothing to install here.
!macroend

!macro customUnInit
  ; Unregister COM add-in
  nsExec::ExecToLog '"$WINDIR\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe" /unregister "$INSTDIR\solidworks-addin\FrameCAD.SolidWorksAddin.dll"'

  ; Remove add-in files
  RMDir /r "$INSTDIR\solidworks-addin"
!macroend

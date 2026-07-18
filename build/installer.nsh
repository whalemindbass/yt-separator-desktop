; YT Separator NSIS custom installer
; 이전 appId(com.rowonss.yt-separator)로 설치된 버전이 있으면 조용히 제거해 이중 설치 방지.

!macro customInit
  Var /GLOBAL _yssPrevUninstall

  ; HKCU (per-user 설치)
  ReadRegStr $_yssPrevUninstall HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.rowonss.yt-separator" "UninstallString"
  ${If} $_yssPrevUninstall != ""
    DetailPrint "Removing previous version (com.rowonss.yt-separator, per-user)..."
    ExecWait `$_yssPrevUninstall /S --force-run`
    Sleep 1500
  ${EndIf}

  ; HKLM (per-machine 설치)
  ReadRegStr $_yssPrevUninstall HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.rowonss.yt-separator" "UninstallString"
  ${If} $_yssPrevUninstall != ""
    DetailPrint "Removing previous version (com.rowonss.yt-separator, per-machine)..."
    ExecWait `$_yssPrevUninstall /S --force-run`
    Sleep 1500
  ${EndIf}
!macroend

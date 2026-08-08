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

  ; 구 productName "YT Separator" 폴더에 남은 설치를 조용히 제거 (appId 는 같고 폴더만 다름).
  ; 실제로 두 가지 레이아웃이 발견됨:
  ;   A. Programs\YT Separator\Dr.studio\  — 개명 후에도 옛 상위 폴더를 그대로 쓴 설치
  ;   B. Programs\YT Separator\            — 개명 전 설치
  ; A 를 먼저 지워야 상위 폴더가 비어서 아래 RMDir 로 정리된다.

  IfFileExists "$LOCALAPPDATA\Programs\YT Separator\Dr.studio\Uninstall Dr.studio.exe" 0 ytsep_nested_done
    DetailPrint "Removing previous install under 'YT Separator\Dr.studio'..."
    ExecWait `"$LOCALAPPDATA\Programs\YT Separator\Dr.studio\Uninstall Dr.studio.exe" /S _?=$LOCALAPPDATA\Programs\YT Separator\Dr.studio`
    Sleep 1500
    RMDir /r "$LOCALAPPDATA\Programs\YT Separator\Dr.studio"
  ytsep_nested_done:

  IfFileExists "$LOCALAPPDATA\Programs\YT Separator\Uninstall YT Separator.exe" 0 ytsep_done
    DetailPrint "Removing previous 'YT Separator' install..."
    ExecWait `"$LOCALAPPDATA\Programs\YT Separator\Uninstall YT Separator.exe" /S _?=$LOCALAPPDATA\Programs\YT Separator`
    Sleep 1500
    RMDir /r "$LOCALAPPDATA\Programs\YT Separator"
  ytsep_done:

  ; 옛 이름 바로가기 정리. 상위 폴더는 RMDir(비재귀) 라 비어 있을 때만 지워진다 —
  ; 사용자가 그 경로를 새 설치 위치로 골랐어도 안전.
  Delete "$DESKTOP\YT Separator.lnk"
  Delete "$SMPROGRAMS\YT Separator.lnk"
  Delete "$SMPROGRAMS\YT Separator\YT Separator.lnk"
  RMDir  "$SMPROGRAMS\YT Separator"
  RMDir  "$LOCALAPPDATA\Programs\YT Separator"
!macroend

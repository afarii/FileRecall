!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Google\Chrome\NativeMessagingHosts\com.filerecall.desktop" ""
    ${if} $0 == "$APPDATA\filerecall-desktop\chrome-host.json"
      DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.filerecall.desktop"
    ${endif}
  ${endif}
  ClearErrors
!macroend

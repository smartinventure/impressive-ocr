; SPDX-License-Identifier: AGPL-3.0-or-later
;
; NSIS customisation.
;
; Adds the second shortcut: "Impressive OCR Server", which starts the backend headless — no
; window, no tray — for a machine that acts as a processing server. Both shortcuts run the
; same executable; the flag is what differs.

!macro customInstall
  ; The headless launcher. --server suppresses the window and the tray, prints the URL, and
  ; keeps running until stopped.
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME} Server.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" \
    "--server" "$INSTDIR\resources\icons\icon-server.ico" 0 SW_SHOWMINIMIZED \
    "" "Run Impressive OCR as a headless server"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\${PRODUCT_NAME} Server.lnk"
!macroend

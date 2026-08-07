; U6 / KTD-8: legacy Tauri (per-machine MSI) install cleanup for the bridge
; installer. Included by electron-builder via `nsis.include`
; (electron-builder.config.ts) — electron-builder calls the `customInstall`
; macro inside its install section (templates/nsis/installSection.nsh),
; AFTER our files and per-user shortcuts are in place.
;
; Background: the last Tauri line (<= 0.0.33) shipped a per-machine MSI
; (Wix). The Electron line installs per-user (oneClick, perMachine: false),
; so without cleanup a bridge-updated machine ends up with TWO Comate
; installs and duplicate entry points. This script:
;   1. detects the old MSI via the HKLM Uninstall registry keys (both the
;      64-bit and 32-bit views — the installer is 32-bit NSIS, and a 64-bit
;      per-machine MSI registers in the 64-bit view);
;   2. runs `msiexec /x {ProductCode}` WITH UI (no /qn) — exactly one UAC
;      prompt is accepted (KTD-8). msiexec exit 0/3010 = removed;
;   3. on refusal (1602) or failure (anything else): tolerate the residue,
;      neutralize the old entry points (all-users Start Menu/Desktop
;      shortcuts — the per-machine MSI only ever created all-users links,
;      so our per-user links are untouched) and show a one-time notice.
;
; Registry contract: the Tauri MSI registers under
;   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{ProductCode}
; with DisplayName "Comate" and WindowsInstaller = 1 (per-machine MSI).
;
; NOTE: cannot be exercised locally (no Windows/makensis on dev machines) —
; the two-OS rehearsal (docs/runbooks/bridge-rollback.md) is the gate for
; real behavior, including the UAC-refusal branch.

!ifndef COMATE_LEGACY_CLEANUP_NSH
!define COMATE_LEGACY_CLEANUP_NSH

!include LogicLib.nsh

Var /GLOBAL LegacyMsiProductCode

; Searches one registry view ($0 = "64" or "32") of the HKLM Uninstall hive
; for a per-machine MSI whose DisplayName is "Comate". Sets
; $LegacyMsiProductCode to the {GUID} subkey name when found.
Function FindLegacyTauriMsiInView
  ; $0 = view ("64"/"32"), uses $1-$3, preserves nothing else.
  ${If} $0 == "64"
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
  StrCpy $1 0
  ${Do}
    EnumRegKey $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $1
    ${If} $2 == ""
      ${ExitDo}
    ${EndIf}
    ; Only MSI products have a {GUID} key name and WindowsInstaller=1.
    StrCpy $3 $2 1
    ${If} $3 == "{"
      ClearErrors
      ReadRegDWORD $3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$2" "WindowsInstaller"
      ${IfNot} ${Errors}
      ${AndIf} $3 == 1
        ClearErrors
        ReadRegStr $3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$2" "DisplayName"
        ${IfNot} ${Errors}
        ${AndIf} $3 == "Comate"
          StrCpy $LegacyMsiProductCode $2
          ${ExitDo}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
FunctionEnd

Function FindLegacyTauriMsi
  StrCpy $LegacyMsiProductCode ""
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 "64"
  Call FindLegacyTauriMsiInView
  ${If} $LegacyMsiProductCode == ""
    StrCpy $0 "32"
    Call FindLegacyTauriMsiInView
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ; Restore the view the rest of the (32-bit) installer expects.
  SetRegView 32
FunctionEnd

; Neutralizes the old entry points without touching the MSI residue itself.
; BEST-EFFORT: the per-machine MSI created ALL-USERS shortcuts, and this
; installer runs unelevated (per-user), so deleting from the common profile
; may be denied for non-admin users — tolerated residue per KTD-8. Our own
; per-user links live in the user profile and are untouched either way.
Function NeutralizeLegacyEntryPoints
  SetShellVarContext all
  Delete "$SMPROGRAMS\Comate.lnk"
  Delete "$SMPROGRAMS\Comate\Comate.lnk"
  RMDir "$SMPROGRAMS\Comate"
  Delete "$DESKTOP\Comate.lnk"
  ; Defensive: remove a legacy auto-run entry if one exists (old updater
  ; re-entry point). Harmless when absent; denied without elevation.
  SetRegView 64
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Comate"
  SetRegView 32
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Comate"
  ; Best-effort means failures above leave the NSIS error flag set — clear it
  ; so electron-builder's own logic after customInstall starts clean.
  ClearErrors
FunctionEnd

; electron-builder hook: runs inside the install section after our files
; and shortcuts are installed (installSection.nsh). One UAC prompt for the
; MSI uninstall is accepted (KTD-8); refusal/failure degrades to residue
; tolerance + entry-point neutralization + one-time notice.
!macro customInstall
  Call FindLegacyTauriMsi
  ${If} $LegacyMsiProductCode != ""
    DetailPrint "Legacy Tauri install detected ($LegacyMsiProductCode) — uninstalling via msiexec"
    ; WITH UI (no /qn): the user sees the uninstaller and a single UAC prompt.
    ExecWait 'msiexec.exe /x "$LegacyMsiProductCode"' $0
    ${If} $0 == 0
    ${OrIf} $0 == 3010 ; ERROR_SUCCESS_REBOOT_REQUIRED — removed, reboot pending
      DetailPrint "Legacy Tauri install removed (msiexec exit $0)"
    ${Else}
      ; 1602 = user cancelled (incl. UAC refusal); anything else = failure.
      ; Tolerate the residue (KTD-8) and neutralize old entry points so the
      ; old binary stops being launched (it would otherwise keep polling
      ; latest.json and re-run the bridge update).
      DetailPrint "Legacy uninstall declined/failed (msiexec exit $0) — neutralizing old entry points"
      Call NeutralizeLegacyEntryPoints
      MessageBox MB_ICONINFORMATION|MB_OK \
        "An older Comate installation could not be removed automatically (it may have been declined).$\r$\n$\r$\nThe new version is installed and ready; the old shortcuts were removed. You can finish the cleanup later via Windows Settings > Apps > Comate." \
        /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend

!endif ; COMATE_LEGACY_CLEANUP_NSH

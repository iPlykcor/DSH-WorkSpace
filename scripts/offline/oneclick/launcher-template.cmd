@echo off
rem ============================================================================
rem  dsh-octopus-operation-space <<PLUGIN_VERSION>> - single-file offline deployer
rem
rem  DOUBLE-CLICK THIS FILE. Nothing else to type, no arguments, no network.
rem
rem  Why a .cmd and not a .ps1: Windows only ever EXECUTES a .cmd on
rem  double-click, while a .ps1 is merely OPENED - on this fleet that means
rem  Notepad (the .ps1 UserChoice points at an AppX editor) and the
rem  "Run with PowerShell" verb is not even registered, so a double-clicked
rem  .ps1 can never deploy anything. Everything below the marker line is the
rem  real deployer, in PowerShell, byte-identical to the audited
rem  install-offline.ps1; this prologue only unpacks it and starts it.
rem
rem  Optional arguments (only when you run it from a terminal):
rem    deploy.cmd -DryRun              show the plan, write nothing
rem    deploy.cmd -Uninstall          remove the plugin again
rem    deploy.cmd -Profile web         one profile instead of all
rem    deploy.cmd -Force              install despite a version warning
rem ============================================================================
setlocal
set "OCTO_SELF=%~f0"
set "OCTO_TMP=%TEMP%\octopus-deploy-%RANDOM%%RANDOM%.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllText($env:OCTO_TMP, (& { $text = [IO.File]::ReadAllText($env:OCTO_SELF); $marker = '#' + 'OCTOPUS-PS1-BEGIN' + '#'; $at = $text.LastIndexOf($marker); if ($at -lt 0) { throw 'payload marker not found' }; $text.Substring($at + $marker.Length) }), (New-Object Text.UTF8Encoding($false)))"
if not exist "%OCTO_TMP%" goto :payload_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%OCTO_TMP%" %*
set "OCTO_RC=%ERRORLEVEL%"
del "%OCTO_TMP%" >nul 2>&1
exit /b %OCTO_RC%
:payload_failed
echo.
echo This file could not unpack its own payload. It may have been truncated
echo or edited in transit - copy it again from the package you received.
echo.
pause
exit /b 1
#OCTOPUS-PS1-BEGIN#

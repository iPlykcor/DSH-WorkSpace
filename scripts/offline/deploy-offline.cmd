@echo off
rem One-click deployer for dsh-octopus-operation-space (offline bundle).
rem
rem Double-click this file. It just runs deploy-offline.ps1 next to it with an
rem execution policy that works on a default Windows install, because the
rem "Run with PowerShell" verb is missing on some machines and a Restricted
rem policy would refuse the script outright. All real work (and every safety
rem check: backup, both mount entries, SHA256 verification, cross-profile
rem rollback) lives in the PowerShell installer; this file only launches it.
rem
rem Extra arguments are passed through, e.g.:
rem   deploy-offline.cmd -DryRun
rem   deploy-offline.cmd -Uninstall
rem   deploy-offline.cmd -Profile web
setlocal
set "HERE=%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
rem -NoPause because this file pauses on its own below; two prompts would be silly.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%deploy-offline.ps1" -NoPause %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo DEPLOY FAILED - exit code %RC%. Read the messages above.
if "%RC%"=="0" echo Finished. Details and backups were printed above.
echo.
pause
exit /b %RC%

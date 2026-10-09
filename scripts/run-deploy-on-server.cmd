@echo off
REM One-click deploy for talent-asset-workbench (run inside the RDP session).
REM The RDP client must map the workstation D: drive (\\tsclient\D).
setlocal
set SRC=\\tsclient\D\talent-asset-workbench
echo === deploying from %SRC% ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%SRC%\scripts\deploy-to-server.ps1" -SourceRoot "%SRC%"
set RC=%ERRORLEVEL%
echo.
echo === deploy finished, exit code %RC% ===
pause

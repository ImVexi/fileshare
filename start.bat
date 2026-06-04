@echo off
title Fileshare Server

set PORT=3000
set ADMIN_PASSWORD=8762
set PUBLIC_URL=https://share.vextroboomin.xyz

echo.
echo === Fileshare Server ===
echo Port: %PORT%
echo Public URL: %PUBLIC_URL%
echo Admin: %PUBLIC_URL%/admin/
echo Password: %ADMIN_PASSWORD%
echo.
echo Starting server...
echo.

node "%~dp0server.js"

pause

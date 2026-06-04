@echo off
title Fileshare Server
set PORT=3000

echo.
echo === Fileshare Server ===
echo Port: %PORT%
echo Admin: http://localhost:%PORT%/admin/
echo Password: set ADMIN_PASSWORD env var or edit server.js
echo.
echo Starting server...
echo.

node "%~dp0server.js"
pause

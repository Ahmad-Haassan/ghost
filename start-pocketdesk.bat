@echo off
cd /d "%~dp0"

if not exist "%~dp0cloudflared.exe" (
    echo [GHOST Remote] Downloading Cloudflare tunnel binary...
    curl.exe -L -o "%~dp0cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)

if exist "%~dp0node_modules\electron\dist\electron.exe" (
    start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
) else (
    call cmd /c "npx electron ."
)

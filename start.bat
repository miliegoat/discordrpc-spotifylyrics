@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Node.js not found.
    set /p ans="Auto-install Node.js? (y/n): "
    if /I "!ans!"=="y" (
        echo Downloading Node.js...
        curl -fsSL -o node-install.msi https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi
        echo Installing...
        msiexec /i node-install.msi /quiet /norestart
        del node-install.msi
        echo Node.js installed!
        call set "PATH=%PATH%;%ProgramFiles%\nodejs\;%ProgramFiles(x86)%\nodejs\"
    ) else (
        pause
        exit /b
    )
)

:getid
if exist "id" goto deps
echo.
echo === First Time Setup ===
set /p uid="Enter your Discord User ID: "
if "!uid!"=="" (
    echo User ID cannot be empty.
    goto getid
)
echo !uid!> id
echo.
echo Setup complete!

:deps
if exist "node_modules" goto startapp
echo Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo.
    echo npm install failed. Retrying with a clean cache...
    if exist "node_modules" rmdir /s /q "node_modules"
    if exist "package-lock.json" del "package-lock.json"
    call npm cache clean --force
    call npm install
    if errorlevel 1 (
        echo.
        echo ============================================================
        echo ERROR: Could not install dependencies.
        echo.
        echo Try running these commands manually in this folder:
        echo   1. rmdir /s /q node_modules
        echo   2. del package-lock.json
        echo   3. npm cache clean --force
        echo   4. npm install
        echo.
        echo If the issue persists, try moving the project to a shorter
        echo path (e.g. C:\wtf) or run as Administrator.
        echo ============================================================
        pause
        exit /b 1
    )
)

:startapp
echo.
echo Starting...
start /MIN wscript.exe start.vbs
echo You can close this window now. Exit the app by right-clicking the icon in the system tray.
timeout /t 3 /nobreak >nul

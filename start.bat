@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Ollama Steam Chatbot Framework
echo Location: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not available in PATH.
  echo Install Node.js 18 or newer, then run start.bat again.
  echo.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo ERROR: This framework requires Node.js 18 or newer.
  echo Update Node.js, then run start.bat again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm is not available in PATH.
  echo Reinstall or repair Node.js so npm is included.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo ERROR: package.json is missing from:
  echo   %CD%
  echo.
  echo Keep package.json in the same framework folder as bot.js and start.bat.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\steam-user\package.json" (
  echo Dependencies are not installed on this computer yet.
  echo Installing them now from package.json...
  echo.
  call npm install --no-package-lock --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo ERROR: npm could not install the framework dependencies.
    echo Check your internet connection and Node.js/npm installation.
    echo Framework folder:
    echo   %CD%
    echo.
    pause
    exit /b 1
  )
  echo.
  echo Dependencies installed for this computer.
  echo.
)

echo Starting bot...
node --max-old-space-size=512 bot.js
set "BOT_EXIT=%ERRORLEVEL%"

rem Exit code 20 means bot.js already explained a Steam startup/login
rem problem and already waited for a key, so do not show another pause.
if "%BOT_EXIT%"=="20" exit /b 20

echo.
if not "%BOT_EXIT%"=="0" (
  echo Bot stopped because of an error. Exit code: %BOT_EXIT%
) else (
  echo Bot stopped.
)
echo.
pause
exit /b %BOT_EXIT%

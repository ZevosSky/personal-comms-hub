@echo off
setlocal

echo Comms Hub build helper
echo.
echo Usage:
echo   build.bat install      - Install dependencies
echo   build.bat dev          - Run Vite + Electron in development mode
echo   build.bat build        - Build the renderer only
echo   build.bat start        - Launch the built app locally
echo   build.bat smoke        - Run the smoke check
echo   build.bat dist         - Build the default packaged app output
echo   build.bat dist:win     - Build the Windows installer
echo   build.bat dist:linux   - Build the Linux AppImage
echo.
echo Common launch commands after building:
echo   npm start              - Launch the built desktop app
echo   npm run dev            - Launch the live development version
echo.

if "%~1"=="" goto :usage
if /I "%~1"=="help" goto :usage
if /I "%~1"=="install" goto :install
if /I "%~1"=="dev" goto :dev
if /I "%~1"=="build" goto :build
if /I "%~1"=="start" goto :start
if /I "%~1"=="smoke" goto :smoke
if /I "%~1"=="dist" goto :dist
if /I "%~1"=="dist:win" goto :distwin
if /I "%~1"=="dist:linux" goto :distlinux

echo Unknown command: %~1
echo.
goto :usage

:install
call npm install
goto :eof

:dev
call npm run dev
goto :eof

:build
call npm run build
goto :eof

:start
call npm start
goto :eof

:smoke
call npm run smoke
goto :eof

:dist
call npm run dist
goto :eof

:distwin
call npm run dist:win
goto :eof

:distlinux
call npm run dist:linux
goto :eof

:usage
echo Example:
echo   build.bat install
echo   build.bat build
echo   build.bat start
exit /b 0

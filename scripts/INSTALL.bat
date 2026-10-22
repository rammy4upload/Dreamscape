@echo off
setlocal EnableExtensions

REM ===============================
REM Pokemon Brick Bronze AutoReuploader — install
REM ===============================

cd /d "%~dp0.." || exit /b 1

echo Installing npm packages in:
cd
echo.

where npm >nul 2>&1 || (
  echo [ERROR] npm not found. Install Node.js LTS from https://nodejs.org/ then re-run INSTALL.bat
  pause
  exit /b 1
)

call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
set "LINK="
set /p "LINK=Register global ^`autoreuploader^` command ^(npm link^)? [y/N]: "
if /I "%LINK%"=="y" (
  call npm link
  if errorlevel 1 (
    echo [WARN] npm link failed. You can still run: node cli/index.js ...
  ) else (
    echo [OK] You can run: autoreuploader --help
  )
) else (
  echo Skipped npm link. Run scripts\LAUNCH.bat or: node cli/index.js --help
)

echo.
echo Done.
pause
exit /b 0

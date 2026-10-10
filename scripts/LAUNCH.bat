@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ===============================
REM Monster Brick Bronze AutoReuploader — interactive launcher
REM ===============================

set "ROOT=%~dp0.."
set "DEFCFG=!ROOT!config.json"

:menu
cls
echo ===============================
echo  Monster Brick Bronze AutoReuploader
echo ===============================
echo  Config default: !DEFCFG!
echo.
echo  Choose what to run:
echo    1  Full upload ^(--fullupload; with permissions^)
echo    2  Normal upload ^(--normalupload; no permissions^)
echo    3  Configure experience ^(--configureexperience^)
echo    4  Push placeids only ^(--pushplaceids^)
echo    5  RBXL only        ^(--rbxlupload^)
echo    6  Add friends ^(--addfriends^)
echo    7  Grant permissions ^(--grantpermissions^)
echo    8  Reupload if taken down ^(--reupload^)
echo    9  Auto Reuploader Service ^(--service; CTRL+C to stop^)
echo   10  Channel status service ^(--channelstatusservice; CTRL+C to stop^)
echo   11  Add backup account ^(--add-backup-account^)
echo    0  Help             ^(--help^)
echo.
set "SEL="
set /p "SEL=Enter choice [0-11]: "
if "!SEL!"=="" goto menu
if "!SEL!"=="0" set "CMD=--help" & goto opts
if "!SEL!"=="1" set "CMD=--fullupload" & goto opts
if "!SEL!"=="2" set "CMD=--normalupload" & goto opts
if "!SEL!"=="3" set "CMD=--configureexperience" & goto opts
if "!SEL!"=="4" set "CMD=--pushplaceids" & goto opts
if "!SEL!"=="5" set "CMD=--rbxlupload" & goto opts
if "!SEL!"=="6" set "CMD=--addfriends" & goto opts
if "!SEL!"=="7" set "CMD=--grantpermissions" & goto opts
if "!SEL!"=="8" set "CMD=--reupload" & goto opts
if "!SEL!"=="9" set "CMD=--service" & goto opts
if "!SEL!"=="10" set "CMD=--channelstatusservice" & goto opts
if "!SEL!"=="11" set "CMD=--add-backup-account" & goto opts
echo Invalid choice.
timeout /t 2 >nul
goto menu

:opts
if "!CMD!"=="--help" (
  set "CFG=!DEFCFG!"
  set "EXTRA="
  goto run
)

echo.
set "CFG=!DEFCFG!"
set /p "CHG=Use a different config.json path? [y/N]: "
if /I "!CHG!"=="y" (
  set "CFG="
  set /p "CFG=Full path to config.json: "
  if "!CFG!"=="" (
    echo No path entered; using default.
    set "CFG=!DEFCFG!"
  )
)

set "EXTRA="
set /p "EXTRA=Extra CLI options ^(Enter for none; appended after --config^): "

:run
echo.
echo Running:
echo   node "!ROOT!cli\index.js" !CMD! --config "!CFG!" !EXTRA!
echo.
REM Run node attached to this console so output streams live (do not capture via PowerShell).
where node >nul 2>&1 || (
  echo [ERROR] node is not on PATH.
  set "EC=9009"
  goto after_run
)

if defined EXTRA (
  node "!ROOT!cli\index.js" !CMD! --config "!CFG!" !EXTRA!
) else (
  node "!ROOT!cli\index.js" !CMD! --config "!CFG!"
)

:after_run
set "EC=!ERRORLEVEL!"
if not "!CMD!"=="--help" (
  echo.
  if not "!EC!"=="0" echo Exit code: !EC!
  pause
)
goto menu

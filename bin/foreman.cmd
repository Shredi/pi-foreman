@echo off
rem pi-foreman: `foreman update-check|retro [args]` for cmd (sync: not available yet).
setlocal
set "PF_PY=%PI_FOREMAN_PYTHON%"
set "PF_PYARGS="
set "PF_SCRIPT="
if /i "%~1"=="update-check" set "PF_SCRIPT=foreman_update_check.py"
if /i "%~1"=="retro" set "PF_SCRIPT=foreman_retro.py"
if /i "%~1"=="sync" (echo foreman sync: not available yet 1>&2 & exit /b 2)
if not defined PF_SCRIPT (echo usage: foreman update-check^|retro [args] 1>&2 & exit /b 2)
shift
if defined PF_PY goto run
where py >nul 2>nul
if errorlevel 1 (set "PF_PY=python") else (set "PF_PY=py" & set "PF_PYARGS=-3")
:run
"%PF_PY%" %PF_PYARGS% -E -s "%~dp0..\scripts\%PF_SCRIPT%" %*
exit /b %ERRORLEVEL%

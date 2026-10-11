@echo off
rem pi-foreman: `foreman setup|update-check|retro|sync|session|radar|config|bench|backlog|findings|close|worktree [args]` for cmd.
setlocal
if /i "%~1"=="setup" goto setup
set "PF_PY=%PI_FOREMAN_PYTHON%"
set "PF_PYARGS="
set "PF_SCRIPT="
if /i "%~1"=="update-check" set "PF_SCRIPT=foreman_update_check.py"
if /i "%~1"=="retro" set "PF_SCRIPT=foreman_retro.py"
if /i "%~1"=="sync" set "PF_SCRIPT=foreman_sync.py"
if /i "%~1"=="session" set "PF_SCRIPT=foreman_session.py"
if /i "%~1"=="radar" set "PF_SCRIPT=foreman_radar.py"
if /i "%~1"=="config" set "PF_SCRIPT=foreman_config.py"
if /i "%~1"=="bench" set "PF_SCRIPT=foreman_bench.py"
if /i "%~1"=="backlog" set "PF_SCRIPT=foreman_backlog.py"
if /i "%~1"=="findings" set "PF_SCRIPT=foreman_findings.py"
if /i "%~1"=="close" set "PF_SCRIPT=foreman_close.py"
if /i "%~1"=="worktree" set "PF_SCRIPT=foreman_worktree.py"
if not defined PF_SCRIPT (echo usage: foreman setup^|update-check^|retro^|sync^|session^|radar^|config^|bench^|backlog^|findings^|close^|worktree [args] 1>&2 & exit /b 2)
shift
set "PF_ARGS="
:collect
if "%~1"=="" goto pick
set PF_ARGS=%PF_ARGS% %1
shift
goto collect
:pick
if defined PF_PY goto run
where py >nul 2>nul
if errorlevel 1 (set "PF_PY=python") else (set "PF_PY=py" & set "PF_PYARGS=-3")
goto run
:setup
shift
set "PF_ARGS="
:collects
if "%~1"=="" goto runsetup
set PF_ARGS=%PF_ARGS% %1
shift
goto collects
:runsetup
node "%~dp0..\setup.mjs" %PF_ARGS%
exit /b %ERRORLEVEL%
:run
"%PF_PY%" %PF_PYARGS% -E -s "%~dp0..\scripts\%PF_SCRIPT%" %PF_ARGS%
exit /b %ERRORLEVEL%

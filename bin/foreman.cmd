@echo off
rem pi-foreman: `foreman setup|update-check|retro|sync|session|radar|config|bench|backlog|findings|close|worktree|dialogs|features|knowledge [args]` for cmd.
setlocal
set "PF_HERE=%~dp0"
if /i "%~1"=="setup" goto setup
if /i "%~1"=="dialogs" goto dialogs
if /i "%~1"=="features" goto features
if /i "%~1"=="knowledge" goto knowledge
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
if not defined PF_SCRIPT (echo usage: foreman setup^|update-check^|retro^|sync^|session^|radar^|config^|bench^|backlog^|findings^|close^|worktree^|dialogs^|features^|knowledge [args] 1>&2 & exit /b 2)
shift
set "PF_ARGS="
:collect
if "%~1"=="" goto pick
set PF_ARGS=%PF_ARGS% %1
shift
goto collect
:pick
if defined PF_PY goto run
set "PF_FOUND=none"
where py >nul 2>nul
if errorlevel 1 goto pickpython
set "PF_PY=py"
set "PF_PYARGS=-3"
call :check
if not errorlevel 1 goto run
:pickpython
set "PF_PY=python"
set "PF_PYARGS="
where python >nul 2>nul
if errorlevel 1 goto nopython
call :check
if not errorlevel 1 goto run
:nopython
echo pi-foreman needs Python 3.13+; found %PF_FOUND%. Set PI_FOREMAN_PYTHON or install Python 3.13 (macOS: brew install python@3.13). 1>&2
exit /b 2
:check
call "%PF_PY%" %PF_PYARGS% -c "import sys; sys.exit(sys.version_info < (3, 13))" >nul 2>nul
set "PF_RC=%ERRORLEVEL%"
if "%PF_FOUND%"=="none" for /f "delims=" %%v in ('call "%PF_PY%" %PF_PYARGS% -c "import sys; print(sys.version.split()[0])" 2^>nul') do if defined PF_PYARGS (set "PF_FOUND=%PF_PY% %PF_PYARGS% %%v") else (set "PF_FOUND=%PF_PY% %%v")
exit /b %PF_RC%
:dialogs
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)" >nul 2>nul
if errorlevel 1 (echo foreman dialogs needs Node ^>= 22.6 ^(--experimental-strip-types^) 1>&2 & exit /b 1)
node --no-warnings --experimental-strip-types "%PF_HERE%..\extensions\core-adapter\dialogs-cli.ts" "%~2"
exit /b %ERRORLEVEL%
:setup
shift
set "PF_ARGS="
:collects
if "%~1"=="" goto runsetup
set PF_ARGS=%PF_ARGS% %1
shift
goto collects
:runsetup
node "%PF_HERE%..\setup.mjs" %PF_ARGS%
set "PF_RC=%ERRORLEVEL%"
if not "%PF_RC%"=="0" exit /b %PF_RC%
node --no-warnings --experimental-strip-types "%PF_HERE%..\scripts\foreman_review_warn.mjs" %PF_ARGS% 2>nul
exit /b 0
:features
shift
set "PF_ARGS="
:collectf
if "%~1"=="" goto runfeatures
set PF_ARGS=%PF_ARGS% %1
shift
goto collectf
:runfeatures
node "%PF_HERE%..\scripts\foreman_features.mjs" %PF_ARGS%
exit /b %ERRORLEVEL%
:knowledge
shift
set "PF_ARGS="
:collectk
if "%~1"=="" goto runknowledge
set PF_ARGS=%PF_ARGS% %1
shift
goto collectk
:runknowledge
node "%PF_HERE%..\scripts\foreman_knowledge.mjs" %PF_ARGS%
exit /b %ERRORLEVEL%
:run
"%PF_PY%" %PF_PYARGS% -E -s "%PF_HERE%..\scripts\%PF_SCRIPT%" %PF_ARGS%
set "PF_RC=%ERRORLEVEL%"
rem update-check keeps its exit code; the knowledge nudge goes to stderr so --json stays clean (best effort)
if "%PF_SCRIPT%"=="foreman_update_check.py" node "%PF_HERE%..\scripts\foreman_knowledge.mjs" nudge 1>&2 2>nul
exit /b %PF_RC%

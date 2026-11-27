@echo off
rem pi-foreman: `ledger` for cmd, and for PowerShell when scripts cannot run.
rem Same binding as bin/ledger: PI_SESSION_ID -> CLAUDE_CODE_SESSION_ID, PI_FOREMAN_STATE_DIR -> TMPDIR.
setlocal
set "PF_PY=%PI_FOREMAN_PYTHON%"
set "PF_PYARGS="
set "CLAUDE_CODE_SESSION_ID=%PI_SESSION_ID%"
if defined PI_FOREMAN_STATE_DIR set "TMPDIR=%PI_FOREMAN_STATE_DIR%"
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
:run
rem the run holds the cross-process <ledger>.lock via bin\ledger-run.mjs (Node on PATH, 22.6+); no usable node: run unlocked
where node >nul 2>nul
if errorlevel 1 goto direct
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)" >nul 2>nul
if errorlevel 1 goto direct
node --no-warnings --experimental-strip-types "%~dp0ledger-run.mjs" "%~dp0..\core\scripts\ledger.py" "%PF_PY%" %PF_PYARGS% -- %*
exit /b %ERRORLEVEL%
:direct
"%PF_PY%" %PF_PYARGS% -X utf8 -E -s "%~dp0..\core\scripts\ledger.py" %*
exit /b %ERRORLEVEL%

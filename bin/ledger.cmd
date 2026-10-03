@echo off
rem pi-foreman: `ledger` for cmd, and for PowerShell when scripts cannot run.
rem Same binding as bin/ledger: PI_SESSION_ID -> CLAUDE_CODE_SESSION_ID, PI_FOREMAN_STATE_DIR -> TMPDIR.
setlocal
set "PF_PY=%PI_FOREMAN_PYTHON%"
set "PF_PYARGS="
set "CLAUDE_CODE_SESSION_ID=%PI_SESSION_ID%"
if defined PI_FOREMAN_STATE_DIR set "TMPDIR=%PI_FOREMAN_STATE_DIR%"
if defined PF_PY goto run
where py >nul 2>nul
if errorlevel 1 (set "PF_PY=python") else (set "PF_PY=py" & set "PF_PYARGS=-3")
:run
"%PF_PY%" %PF_PYARGS% -E -s "%~dp0..\core\scripts\ledger.py" %*
exit /b %ERRORLEVEL%

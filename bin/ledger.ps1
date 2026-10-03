# pi-foreman: `ledger` for Pi's powershell tool (Pi starts it with -ExecutionPolicy Bypass).
# Same binding as bin/ledger: PI_SESSION_ID -> CLAUDE_CODE_SESSION_ID, PI_FOREMAN_STATE_DIR -> TMPDIR.
$script = Join-Path $PSScriptRoot '..\core\scripts\ledger.py'
$py = $env:PI_FOREMAN_PYTHON
$pre = @()
if (-not $py) {
    if (Get-Command py -ErrorAction SilentlyContinue) { $py = 'py'; $pre = @('-3') } else { $py = 'python' }
}
$oldSid = $env:CLAUDE_CODE_SESSION_ID
$oldTmp = $env:TMPDIR
try {
    $env:CLAUDE_CODE_SESSION_ID = $env:PI_SESSION_ID
    if ($env:PI_FOREMAN_STATE_DIR) { $env:TMPDIR = $env:PI_FOREMAN_STATE_DIR }
    & $py @pre -E -s $script @args
    $code = $LASTEXITCODE
} finally {
    $env:CLAUDE_CODE_SESSION_ID = $oldSid
    $env:TMPDIR = $oldTmp
}
exit $code

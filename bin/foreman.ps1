# pi-foreman: `foreman setup|update-check|retro|sync|session|radar|config|bench|backlog|findings|close|worktree|dialogs [args]` for PowerShell.
$sub = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
if ($sub -eq 'setup') {
    & node (Join-Path $PSScriptRoot '..\setup.mjs') @rest
    exit $LASTEXITCODE
}
if ($sub -eq 'dialogs') {
    & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)" 2>$null
    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('foreman dialogs needs Node >= 22.6 (--experimental-strip-types)'); exit 1 }
    & node --no-warnings --experimental-strip-types (Join-Path $PSScriptRoot '..\extensions\core-adapter\dialogs-cli.ts') @rest
    exit $LASTEXITCODE
}
switch ($sub) {
    'update-check' { $name = 'foreman_update_check.py' }
    'retro' { $name = 'foreman_retro.py' }
    'sync' { $name = 'foreman_sync.py' }
    'session' { $name = 'foreman_session.py' }
    'radar' { $name = 'foreman_radar.py' }
    'config' { $name = 'foreman_config.py' }
    'bench' { $name = 'foreman_bench.py' }
    'backlog' { $name = 'foreman_backlog.py' }
    'findings' { $name = 'foreman_findings.py' }
    'close' { $name = 'foreman_close.py' }
    'worktree' { $name = 'foreman_worktree.py' }
    default { [Console]::Error.WriteLine('usage: foreman setup|update-check|retro|sync|session|radar|config|bench|backlog|findings|close|worktree|dialogs [args]'); exit 2 }
}
$script = Join-Path $PSScriptRoot "..\scripts\$name"
$py = $env:PI_FOREMAN_PYTHON
$pre = @()
if (-not $py) {
    if (Get-Command py -ErrorAction SilentlyContinue) { $py = 'py'; $pre = @('-3') } else { $py = 'python' }
}
& $py @pre -E -s $script @rest
exit $LASTEXITCODE

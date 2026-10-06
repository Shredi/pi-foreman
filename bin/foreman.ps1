# pi-foreman: `foreman update-check|retro [args]` for PowerShell (sync: not available yet).
$sub = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
switch ($sub) {
    'update-check' { $name = 'foreman_update_check.py' }
    'retro' { $name = 'foreman_retro.py' }
    'sync' { [Console]::Error.WriteLine('foreman sync: not available yet'); exit 2 }
    default { [Console]::Error.WriteLine('usage: foreman update-check|retro [args]'); exit 2 }
}
$script = Join-Path $PSScriptRoot "..\scripts\$name"
$py = $env:PI_FOREMAN_PYTHON
$pre = @()
if (-not $py) {
    if (Get-Command py -ErrorAction SilentlyContinue) { $py = 'py'; $pre = @('-3') } else { $py = 'python' }
}
& $py @pre -E -s $script @rest
exit $LASTEXITCODE

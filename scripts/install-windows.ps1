# Installs Claude Link on this Windows machine:
#   1. publishes the daemon and the mod to %USERPROFILE%\.claude-link (app\ and
#      mod\); later builds published on any linked machine arrive by themselves
#   2. starts the daemon at login from the Startup folder, without a console
#      window, and restarts it if it stops
#   3. loads the mod in every Claude Code session (CLAUDE_CODE_PLUGIN_DIRS in ~\.claude\settings.json)
# Set the link up first with "claude-link init" or "claude-link join".
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$linkHome = if ($env:CLAUDE_LINK_HOME) { $env:CLAUDE_LINK_HOME } else { Join-Path $env:USERPROFILE '.claude-link' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw 'Node.js is required (https://nodejs.org).'
}
if (-not (Test-Path (Join-Path $linkHome 'config.json'))) {
    throw "Set up the link first: node `"$root\daemon\claude-link.mjs`" init --name <name> (or join <code>)."
}

$app = Join-Path $linkHome 'app'
$mod = Join-Path $linkHome 'mod'
& $node (Join-Path $root 'daemon\claude-link.mjs') publish --from $root
if ($LASTEXITCODE -ne 0) {
    throw 'Publishing the daemon and mod failed.'
}

# Stop a daemon started by hand or by an earlier install.
Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" |
    Where-Object { $_.CommandLine -like '*Claude Link.vbs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*claude-link.mjs*serve*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$script = Join-Path $app 'claude-link.mjs'
$log = Join-Path $linkHome 'daemon.log'
$launcherBody = @"
' Keeps the Claude Link daemon running without a console window, restarting it
' when it stops unless it exits with 3 (already running, or not set up).
Set shell = CreateObject("WScript.Shell")
Do
  code = shell.Run("""$node"" ""$script"" serve --supervised --log ""$log""", 0, True)
  If code = 3 Then Exit Do
  WScript.Sleep 10000
Loop
"@
$launcher = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Link.vbs'
Set-Content -Path $launcher -Value $launcherBody -Encoding ASCII

# Started through WMI so it also outlives the session when installed over SSH.
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "wscript.exe `"$launcher`"" } | Out-Null

& $node $script install-mod $mod
Write-Output "Claude Link is running. Check it with: node `"$script`" status"

# One-shot setup: gets Etsy Command Center running on a fresh Windows Server
# VDS, reachable over real HTTPS from any browser, with no domain purchase,
# no DNS setup, and no GitHub login (the repo is public, downloaded as a
# plain zip).
#
# Run this ON THE VDS, in a PowerShell window running as Administrator:
#
#   irm https://raw.githubusercontent.com/keyartisanetsy-ctrl/EtsyApp/claude/etsy-bulk-management-app-q3enu5/deploy/setup-vds.ps1 -OutFile setup-vds.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-vds.ps1 -PublicIP 84.55.17.145
#
# (Replace 84.55.17.145 with this VDS's own public IP.)
#
# What it does: installs Node.js if missing, downloads the app (no git
# needed), builds it, generates a random app password, installs Caddy for
# automatic HTTPS (via a free nip.io hostname that maps straight back to
# this VDS's IP), and registers both the app and Caddy as Windows services
# (via NSSM) so they survive reboots. Safe to re-run.

param(
  [Parameter(Mandatory = $true)]
  [string]$PublicIP
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without a progress bar.

function Section($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# Any external program (npm, node, msiexec, nssm...) can write ordinary
# status text to its error stream -- npm's own deprecation warnings do this
# on some versions, nssm does it on every restart of a service that was not
# already running. PowerShell turns each such line into an ErrorRecord, and
# with $ErrorActionPreference set to Stop (below) that is fatal, killing the
# script over output that was never actually an error. Every native command
# in this script goes through here instead of being called bare: the output
# is shown as it normally would be, but stderr text alone cannot abort the
# script -- only a real (non-zero) exit code can, and only when asked to
# check for one.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$CallArgs = @(),
    [switch]$IgnoreExitCode
  )
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Exe @CallArgs 2>&1 | ForEach-Object { Write-Host "  $_" } }
  finally { $ErrorActionPreference = $prevEAP }
  if (-not $IgnoreExitCode -and $LASTEXITCODE -ne 0) {
    throw "$Exe $($CallArgs -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Run this from a PowerShell window opened as Administrator (right-click -> Run as administrator)." -ForegroundColor Red
  exit 1
}

$Hostname = ($PublicIP -replace '\.', '-') + '.nip.io'
$AppDir   = 'C:\EtsyApp'
$ToolsDir = 'C:\EtsyAppTools'
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

Section "Public URL will be: https://$Hostname"

# --- Node.js ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Section "Installing Node.js..."
  $nodeMsi = Join-Path $ToolsDir 'node.msi'
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-x64.msi' -OutFile $nodeMsi
  Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /quiet /norestart" -Wait
  # A fresh install is not yet on this session's PATH.
  $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $env:Path = "$machinePath;C:\Program Files\nodejs\"
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js installed but "node" is still not found. Close this window, open a new Administrator PowerShell, and run this script again.' }
}
$nodeExe = $node.Source
Invoke-Native -Exe $nodeExe -CallArgs @('--version')

# --- App code (a plain zip download, no git needed) --------------------------
if (-not (Test-Path $AppDir)) {
  Section "Downloading the app..."
  $zip = Join-Path $ToolsDir 'EtsyApp.zip'
  Invoke-WebRequest -Uri 'https://github.com/keyartisanetsy-ctrl/EtsyApp/archive/refs/heads/claude/etsy-bulk-management-app-q3enu5.zip' -OutFile $zip
  $extractTo = Join-Path $ToolsDir 'extract'
  Remove-Item $extractTo -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $extractTo -Force
  $inner = Get-ChildItem $extractTo | Select-Object -First 1
  Move-Item $inner.FullName $AppDir
} else {
  Write-Host "App directory $AppDir already exists -- using what is there. Delete it first to fetch fresh code."
}
Set-Location $AppDir

Section "Installing and building the app (first run downloads dependencies - a few minutes)..."
Invoke-Native -Exe 'npm' -CallArgs @('run', 'setup')
Invoke-Native -Exe 'npm' -CallArgs @('run', 'build')

# --- .env / app password -----------------------------------------------------
$EnvFile = Join-Path $AppDir '.env'
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $AppDir '.env.example') $EnvFile }
$envText = Get-Content $EnvFile -Raw
if ($envText -notmatch 'APP_PASSWORD=\S+') {
  $chars = (48..57) + (65..90) + (97..122)   # 0-9 A-Z a-z
  $generated = -join (1..24 | ForEach-Object { [char](Get-Random -InputObject $chars) })
  if ($envText -match '(?m)^APP_PASSWORD=.*$') {
    $envText = $envText -replace '(?m)^APP_PASSWORD=.*$', "APP_PASSWORD=$generated"
  } else {
    $envText += "`nAPP_PASSWORD=$generated`n"
  }
}
if ($envText -match '(?m)^HOST=.*$') {
  $envText = $envText -replace '(?m)^HOST=.*$', 'HOST=127.0.0.1'
} else {
  $envText += "`nHOST=127.0.0.1`n"
}
Set-Content -Path $EnvFile -Value $envText -NoNewline
$AppPassword = (Select-String -Path $EnvFile -Pattern '^APP_PASSWORD=(.+)$').Matches[0].Groups[1].Value

# --- NSSM (wraps the app as a real Windows service) --------------------------
$nssmExe = Join-Path $ToolsDir 'nssm.exe'
if (-not (Test-Path $nssmExe)) {
  Section "Installing NSSM (runs the app as a Windows service)..."
  $nssmZip = Join-Path $ToolsDir 'nssm.zip'
  Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $nssmZip
  $nssmExtract = Join-Path $ToolsDir 'nssm-extract'
  Remove-Item $nssmExtract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force
  Copy-Item (Join-Path $nssmExtract 'nssm-2.24\win64\nssm.exe') $nssmExe
}

$LogDir = Join-Path $ToolsDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# nssm's exit code is not a reliable success/failure signal for "set" and
# "restart" (e.g. it can be non-zero just because a freshly-installed
# service had never been started before), so those go through
# Invoke-Native with -IgnoreExitCode; Get-Service and the log files below
# are what actually says whether it worked.
#
# NSSM also discards a service's stdout/stderr by default, which makes a
# crash invisible -- Get-Service still says "Running" while the process is
# stuck in a restart loop. Every service gets a real log file so that is
# never a dead end again.
function Install-OrRestart-Service($name, $exe, $argString, $workDir) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) {
    Invoke-Native -Exe $nssmExe -CallArgs @('install', $name, $exe) -IgnoreExitCode
    Invoke-Native -Exe $nssmExe -CallArgs @('set', $name, 'AppParameters', $argString) -IgnoreExitCode
    Invoke-Native -Exe $nssmExe -CallArgs @('set', $name, 'AppDirectory', $workDir) -IgnoreExitCode
    Invoke-Native -Exe $nssmExe -CallArgs @('set', $name, 'Start', 'SERVICE_AUTO_START') -IgnoreExitCode
  }
  Invoke-Native -Exe $nssmExe -CallArgs @('set', $name, 'AppStdout', (Join-Path $LogDir "$name-out.log")) -IgnoreExitCode
  Invoke-Native -Exe $nssmExe -CallArgs @('set', $name, 'AppStderr', (Join-Path $LogDir "$name-err.log")) -IgnoreExitCode
  if (-not $svc) { Invoke-Native -Exe $nssmExe -CallArgs @('start', $name) -IgnoreExitCode }
  else { Invoke-Native -Exe $nssmExe -CallArgs @('restart', $name) -IgnoreExitCode }

  Start-Sleep -Seconds 5
  $status = (Get-Service -Name $name -ErrorAction SilentlyContinue).Status
  Write-Host "  $name status: $status (log: $LogDir\$name-*.log)"
}

Section "Registering the app as a Windows service..."
Install-OrRestart-Service -name 'EtsyCommandCenter' -exe $nodeExe -argString 'scripts\start.mjs' -workDir $AppDir

# --- Caddy (automatic HTTPS) --------------------------------------------------
$caddyExe = Join-Path $ToolsDir 'caddy.exe'
if (-not (Test-Path $caddyExe)) {
  Section "Installing Caddy (automatic HTTPS)..."
  Invoke-WebRequest -Uri 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile $caddyExe
}
$CaddyDir = Join-Path $ToolsDir 'caddy-data'
New-Item -ItemType Directory -Force -Path $CaddyDir | Out-Null
$Caddyfile = Join-Path $ToolsDir 'Caddyfile'
Set-Content -Path $Caddyfile -Value "$Hostname {`n`treverse_proxy 127.0.0.1:4317`n}`n"

Section "Registering Caddy as a Windows service..."
Install-OrRestart-Service -name 'EtsyCaddy' -exe $caddyExe -argString "run --config $Caddyfile --adapter caddyfile" -workDir $ToolsDir

# --- Firewall ------------------------------------------------------------------
# 443 is what a browser uses; 80 is kept open too because Caddy's automatic
# certificate step tries it first and only falls back to doing everything
# over 443 alone if it is not reachable.
if (-not (Get-NetFirewallRule -DisplayName 'Etsy Command Center HTTPS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Etsy Command Center HTTPS' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow | Out-Null
}
if (-not (Get-NetFirewallRule -DisplayName 'Etsy Command Center HTTP (cert issuance)' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Etsy Command Center HTTP (cert issuance)' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow | Out-Null
}

Write-Host "`n================================================================"
Write-Host " Ready."
Write-Host ""
Write-Host " Open:      https://$Hostname"
Write-Host " Password:  $AppPassword"
Write-Host ""
Write-Host " Write these two down -- the password is also saved in:"
Write-Host "   $EnvFile"
Write-Host ""
Write-Host " Both services restart automatically when the server reboots."
Write-Host " Check status any time with:  Get-Service EtsyCommandCenter, EtsyCaddy"
Write-Host " If something is not working, the real error is in:  $LogDir"
Write-Host "================================================================"

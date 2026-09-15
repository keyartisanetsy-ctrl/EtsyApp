# One-shot setup: gets Etsy Command Center running on a Windows Server VDS,
# reachable over real HTTPS from any browser -- with no domain, no DNS step,
# and no GitHub login (the repo is public, downloaded as a plain zip).
#
# Run this ON THE VDS, in a PowerShell window running as Administrator:
#
#   irm https://raw.githubusercontent.com/keyartisanetsy-ctrl/EtsyApp/claude/etsy-bulk-management-app-q3enu5/deploy/setup-vds.ps1 -OutFile setup-vds.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-vds.ps1
#
# That's it -- no IP to look up or type in. The script asks a public "what
# is my IP" service from inside the VDS itself for this machine's real
# internet-facing address, which is what actually matters here and is not
# always the same as whatever a hosting panel's dashboard shows (that field
# is sometimes an internal/management IP instead). It then fronts the app
# with Caddy, using a free nip.io hostname that maps straight back to that
# IP (no domain purchase, no DNS step) -- Caddy gets and renews its own
# certificate, and the resulting https://<ip-with-dashes>.nip.io address
# never changes, across restarts or reboots, for as long as the VDS keeps
# that IP. This is the one to register as a redirect/callback URL with an
# OAuth provider (Shopify, Etsy) once, and forget -- and since it is
# detected fresh every run, the exact same command works unmodified on any
# of several different VDSs, each getting its own correct, permanent address.
#
# Two optional overrides:
#   -PublicIp 203.0.113.45   Skip auto-detection and use this IP instead
#                            (only needed if detection ever guesses wrong).
#   -NoPublicIp              Use a Cloudflare Tunnel instead: no inbound
#                            port needed at all, but the address it hands
#                            back CHANGES every time that service restarts,
#                            so it is not usable as an OAuth redirect URI.
#                            For a VDS that genuinely cannot open 80/443.
#
# Either way: installs Node.js if missing, downloads the app (no git
# needed), builds it, generates a random app password, and registers the
# app plus whichever of the two above as Windows services (via NSSM) so
# they survive reboots. Safe to re-run.

param(
  # A static public IPv4 for this VDS. Leave empty (the default) to have the
  # script detect it automatically from inside the VDS -- see above for why
  # that is preferred over reading it off a hosting panel.
  [string]$PublicIp = '',
  # Explicit opt-out of the permanent-address path, for a VDS that cannot
  # open inbound 80/443. Falls back to a Cloudflare quick tunnel, whose
  # address changes on every restart.
  [switch]$NoPublicIp
)

# Asks a public echo service what IP this machine is reaching the internet
# as -- the only reliable way to know, since a hosting panel's own "IP
# Adresi" field is sometimes an internal/NAT address rather than the real
# public one (three different providers can each show a different kind of
# address there). Tries a few providers in case one is unreachable or rate
# limiting; the first plain, valid IPv4 response wins.
function Get-PublicIp {
  foreach ($url in 'https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com') {
    try {
      $candidate = (Invoke-RestMethod -Uri $url -TimeoutSec 8).ToString().Trim()
      if ($candidate -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $candidate }
    } catch { }
  }
  return $null
}

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

$AppDir   = 'C:\EtsyApp'
$ToolsDir = 'C:\EtsyAppTools'
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

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
# Always re-fetched, even on a re-run: this is also how you pick up a fix,
# just by running this exact same command again. The zip is straight from
# the git branch, so it never contains .env or data\ (both gitignored) --
# copying it over an existing $AppDir overwrites the app's own code without
# touching your password or your local database.
Section "Downloading the latest app code..."
$zip = Join-Path $ToolsDir 'EtsyApp.zip'
Invoke-WebRequest -Uri 'https://github.com/keyartisanetsy-ctrl/EtsyApp/archive/refs/heads/claude/etsy-bulk-management-app-q3enu5.zip' -OutFile $zip
# What was just downloaded, so the app's own auto-update check (below) knows
# it already has this and does not immediately redownload the same thing.
try {
  $LatestSha = (Invoke-RestMethod -Uri 'https://api.github.com/repos/keyartisanetsy-ctrl/EtsyApp/commits/claude/etsy-bulk-management-app-q3enu5' -Headers @{ 'User-Agent' = 'EtsyCommandCenter' }).sha
} catch { $LatestSha = $null }
$extractTo = Join-Path $ToolsDir 'extract'
Remove-Item $extractTo -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $extractTo -Force
$inner = Get-ChildItem $extractTo | Select-Object -First 1
if (-not (Test-Path $AppDir)) {
  Move-Item $inner.FullName $AppDir
} else {
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $AppDir -Recurse -Force
  Remove-Item $extractTo -Recurse -Force -ErrorAction SilentlyContinue
}
Set-Location $AppDir

Section "Installing and building the app (first run downloads dependencies - a few minutes)..."
Invoke-Native -Exe 'npm' -CallArgs @('run', 'setup')
Invoke-Native -Exe 'npm' -CallArgs @('run', 'build')

if ($LatestSha) {
  New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data') | Out-Null
  Set-Content -Path (Join-Path $AppDir 'data\.installed-commit') -Value $LatestSha -NoNewline
}

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
# From here on the app checks its own branch every 30 minutes and updates
# itself -- re-running this whole script by hand is only needed again if
# something about the VDS itself changes, not for picking up an app fix.
# AUTO_UPDATE_RESTART is safe specifically because EtsyCommandCenter is an
# NSSM service below, which restarts it automatically on exit.
foreach ($pair in @('AUTO_UPDATE=1', 'AUTO_UPDATE_RESTART=1')) {
  $envKey = $pair.Split('=')[0]
  if ($envText -match "(?m)^$envKey=.*$") {
    $envText = $envText -replace "(?m)^$envKey=.*$", $pair
  } else {
    $envText += "`n$pair`n"
  }
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

if (-not $PublicIp -and -not $NoPublicIp) {
  Section "Detecting this VDS's real public IP..."
  $PublicIp = Get-PublicIp
  if ($PublicIp) {
    Write-Host "  Detected: $PublicIp"
  } else {
    Write-Host "  Could not reach any IP-detection service -- falling back to a Cloudflare" -ForegroundColor Yellow
    Write-Host "  tunnel instead (its address changes on every restart). Pass -PublicIp" -ForegroundColor Yellow
    Write-Host "  <your VDS's real public IP> to force the permanent-address path." -ForegroundColor Yellow
  }
}

if ($PublicIp) {
  # --- Caddy (a permanent HTTPS address, needs inbound 80/443 open) ---------
  $HostnameName = ($PublicIp -replace '\.', '-') + '.nip.io'
  $PermanentUrl = "https://$HostnameName"
  Section "Public URL will be: $PermanentUrl (this never changes)"

  $caddyExe = Join-Path $ToolsDir 'caddy.exe'
  if (-not (Test-Path $caddyExe)) {
    Section "Installing Caddy (automatic HTTPS)..."
    # Caddy's own dynamic build endpoint always serves the current stable
    # build for the platform asked for -- no release-asset filename or
    # version number to keep in sync with here.
    Invoke-WebRequest -Uri 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile $caddyExe
  }

  $CaddyfilePath = Join-Path $ToolsDir 'Caddyfile'
  Set-Content -Path $CaddyfilePath -Value "$HostnameName {`n`treverse_proxy 127.0.0.1:4317`n}" -NoNewline

  Section "Opening inbound 80/443 in Windows Firewall..."
  foreach ($port in 80, 443) {
    $ruleName = "EtsyCommandCenter-$port"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    }
  }
  Write-Host "  Firewall rules added on this machine. If the VDS provider also has its" -ForegroundColor Yellow
  Write-Host "  own network firewall/security-group panel, open 80/443 there too." -ForegroundColor Yellow

  Section "Registering Caddy as a Windows service..."
  Install-OrRestart-Service -name 'EtsyCaddy' -exe $caddyExe -argString "run --config `"$CaddyfilePath`" --adapter caddyfile" -workDir $ToolsDir

  # Caddy requests its certificate from Let's Encrypt on first request to the
  # hostname, which takes a few seconds -- confirmed here rather than just
  # printed and hoped for.
  $UrlReachable = $false
  Section "Waiting for Caddy to obtain its certificate..."
  for ($i = 0; $i -lt 15 -and -not $UrlReachable; $i++) {
    try {
      Invoke-WebRequest -Uri $PermanentUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
      $UrlReachable = $true
    } catch {
      if ($_.Exception.Response) { $UrlReachable = $true } else { Start-Sleep -Seconds 2 }
    }
  }

  Write-Host "`n================================================================"
  Write-Host " Ready."
  Write-Host ""
  if ($UrlReachable) {
    Write-Host " Open:      $PermanentUrl"
  } else {
    Write-Host " Open:      $PermanentUrl  (not confirmed reachable yet -- give it a minute; check"
    Write-Host "            that 80/443 are actually open at the VDS provider's own panel too)"
  }
  Write-Host " Password:  $AppPassword"
  Write-Host ""
  Write-Host " Write these two down -- the password is also saved in:"
  Write-Host "   $EnvFile"
  Write-Host ""
  Write-Host " This address never changes -- safe to register as a redirect/callback URL"
  Write-Host " with Shopify, Etsy, or anywhere else that needs one, and forget it."
  Write-Host " Both services restart automatically when the server reboots."
  Write-Host " Check status any time with:  Get-Service EtsyCommandCenter, EtsyCaddy"
  Write-Host " If something is not working, the real error is in:  $LogDir"
  Write-Host "================================================================"

} else {
  # --- Cloudflare Tunnel (public HTTPS, no inbound port needed at all) -------
  $cloudflaredExe = Join-Path $ToolsDir 'cloudflared.exe'
  if (-not (Test-Path $cloudflaredExe)) {
    Section "Installing cloudflared (public HTTPS with no inbound port)..."
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflaredExe
  }

  Section "Registering the tunnel as a Windows service..."
  Install-OrRestart-Service -name 'EtsyTunnel' -exe $cloudflaredExe -argString 'tunnel --url http://127.0.0.1:4317' -workDir $ToolsDir

  # A "quick tunnel" like this one gets a fresh, randomly-named
  # *.trycloudflare.com address every time cloudflared starts -- it is
  # printed to its own log once the connection is up, not returned by nssm,
  # so it has to be read back out.
  #
  # A bare domain match here used to also accept api.trycloudflare.com --
  # the internal endpoint cloudflared itself talks to while registering the
  # tunnel, which shows up in the log on a retry/warning line and reads
  # exactly like a real link but is not one. Real quick-tunnel hostnames are
  # always several dictionary words joined by hyphens
  # (warm-glass-cats-slowly.trycloudflare.com), so requiring a hyphen plus an
  # explicit blocklist of the short technical subdomains Cloudflare actually
  # runs rules that out structurally instead of guessing at every subdomain
  # cloudflared might ever log.
  Section "Waiting for the tunnel address..."
  $TunnelUrl = $null
  $errLog = Join-Path $LogDir 'EtsyTunnel-err.log'
  $outLog = Join-Path $LogDir 'EtsyTunnel-out.log'
  $ReservedTunnelNames = @('api','www','update','updates','login','dash','support','status','blog','developers','community','help')
  for ($i = 0; $i -lt 20 -and -not $TunnelUrl; $i++) {
    Start-Sleep -Seconds 2
    $found = Select-String -Path @($errLog, $outLog) -Pattern 'https://([a-z0-9-]+)\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue
    $candidates = foreach ($line in $found) {
      foreach ($m in $line.Matches) {
        $sub = $m.Groups[1].Value.ToLowerInvariant()
        if ($sub -notin $ReservedTunnelNames -and $sub -like '*-*') { $m.Value }
      }
    }
    if ($candidates) { $TunnelUrl = $candidates | Select-Object -Last 1 }
  }

  # A freshly created quick tunnel can take a moment to actually route through
  # Cloudflare's edge even after its address is known -- confirmed here rather
  # than just printed and hoped for, since a link that actually works is the
  # whole point of handing one to another machine.
  $TunnelReachable = $false
  if ($TunnelUrl) {
    Section "Confirming the tunnel actually answers..."
    for ($i = 0; $i -lt 6 -and -not $TunnelReachable; $i++) {
      try {
        Invoke-WebRequest -Uri $TunnelUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
        $TunnelReachable = $true
      } catch {
        # Any HTTP response at all (even the app's own 401 for no password)
        # counts as reachable -- only a connection-level failure lands here.
        if ($_.Exception.Response) { $TunnelReachable = $true } else { Start-Sleep -Seconds 2 }
      }
    }
  }

  Write-Host "`n================================================================"
  Write-Host " Ready."
  Write-Host ""
  if ($TunnelUrl -and $TunnelReachable) {
    Write-Host " Open:      $TunnelUrl"
  } elseif ($TunnelUrl) {
    Write-Host " Open:      $TunnelUrl  (not confirmed reachable yet -- give it a few more seconds)"
  } else {
    Write-Host " The tunnel address was not found yet -- give it a moment, then run:"
    Write-Host "   Select-String -Path `"$errLog`",`"$outLog`" -Pattern 'trycloudflare.com'"
  }
  Write-Host " Password:  $AppPassword"
  Write-Host ""
  Write-Host " Write these two down -- the password is also saved in:"
  Write-Host "   $EnvFile"
  Write-Host ""
  Write-Host " This address CHANGES on every EtsyTunnel restart -- fine for browsing the"
  Write-Host " app, but not for registering with an OAuth provider (Shopify, Etsy). For"
  Write-Host " a permanent address instead, re-run this script with -PublicIp <your VDS IP>."
  Write-Host " Both services restart automatically when the server reboots."
  Write-Host " Check status any time with:  Get-Service EtsyCommandCenter, EtsyTunnel"
  Write-Host " If something is not working, the real error is in:  $LogDir"
  Write-Host "================================================================"
}

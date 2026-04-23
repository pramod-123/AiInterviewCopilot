#Requires -Version 5.1
<#
  Consumer installer (Windows): release tarball win-x64, Prisma, Whisper venv, Chrome extension.
  Default prefix: $env:USERPROFILE\.local\share\ai-interview-copilot

  Run from repo clone:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Or download raw from GitHub, then:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Env: AI_INTERVIEW_COPILOT_REPO, RELEASE_TAG, INSTALL_PREFIX, INSTALL_CONSUMER_YES=1,
       INSTALL_CONSUMER_START_SERVER=1, LIVE_REALTIME_PROVIDER, OPENAI_API_KEY, GEMINI_API_KEY,
       ANTHROPIC_API_KEY, LLM_PROVIDER, NODE_MIN_MAJOR (default 20)
#>

$ErrorActionPreference = 'Stop'

$NODE_MIN_MAJOR = if ($env:NODE_MIN_MAJOR) { [int]$env:NODE_MIN_MAJOR } else { 20 }
$REPO = if ($env:AI_INTERVIEW_COPILOT_REPO) { $env:AI_INTERVIEW_COPILOT_REPO } else { 'pramod-123/AiInterviewCopilot' }
$RELEASE_TAG = if ($env:RELEASE_TAG) { $env:RELEASE_TAG } else { 'latest' }
$defaultPrefix = Join-Path $env:USERPROFILE '.local\share\ai-interview-copilot'
$INSTALL_PREFIX = if ($env:INSTALL_PREFIX) { $env:INSTALL_PREFIX } else { $defaultPrefix }
$AUTO_YES = $env:INSTALL_CONSUMER_YES -eq '1'
$EXTENSION_ASSET_NAME = 'ai-interview-copilot-chrome-extension.zip'

function Write-Info($m) { Write-Host $m }
function Write-Ok($m) { Write-Host $m -ForegroundColor Green }
function Write-Warn($m) { Write-Host $m -ForegroundColor Yellow }

function Test-NodeOk {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  $maj = [int]((node -p "Number(process.version.slice(1).split('.')[0])" 2>$null))
  return $maj -ge $NODE_MIN_MAJOR
}

function Test-Python3Ok {
  if (Get-Command python3 -ErrorAction SilentlyContinue) { return $true }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    try { py -3 -c "import sys; assert sys.version_info[0] >= 3" 2>$null; return $true } catch { return $false }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    try { python -c "import sys; assert sys.version_info[0] >= 3" 2>$null; return $true } catch { return $false }
  }
  return $false
}

function Install-WingetDeps {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Warn 'winget not found. Install Node LTS, FFmpeg, Python 3.12, jq manually, then re-run.'
    return $false
  }
  Write-Info 'Installing dependencies via winget (silent)…'
  $silent = @('--accept-package-agreements', '--accept-source-agreements', '--silent')
  foreach ($id in @('OpenJS.NodeJS.LTS', 'Gyan.FFmpeg', 'Python.Python.3.12', 'jqlang.jq')) {
    try {
      & winget install -e --id $id @silent 2>$null | Out-Null
    } catch {
      Write-Warn "winget install $id (may already be installed)"
    }
  }
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  return $true
}

function Get-ReleaseJson([string]$repo, [string]$tag) {
  if ($tag -eq 'latest') {
    $url = "https://api.github.com/repos/$repo/releases/latest"
  } else {
    $url = "https://api.github.com/repos/$repo/releases/tags/$tag"
  }
  return Invoke-RestMethod -Uri $url -Headers @{ Accept = 'application/vnd.github+json' }
}

function Get-AssetUrl($release, [string]$name) {
  $a = @($release.assets | Where-Object { $_.name -eq $name })[0]
  if (-not $a) { return $null }
  return $a.browser_download_url
}

function Ensure-DbUrlInRuntimeConfig([string]$root, [string]$dbPath) {
  $cfg = Join-Path $root '.app-runtime-config.json'
  if (-not (Test-Path $cfg)) { return }
  $url = 'file:' + ($dbPath -replace '\\', '/')
  $j = Get-Content $cfg -Raw | ConvertFrom-Json
  $j | Add-Member -NotePropertyName databaseUrl -NotePropertyValue $url -Force
  $j.version = 1
  ($j | ConvertTo-Json -Depth 30) | Set-Content $cfg -Encoding UTF8
}

function Merge-RuntimeSnippet {
  param(
    [string]$Root,
    [string]$Openai,
    [string]$Anthropic,
    [string]$Gemini,
    [string]$GeminiLiveModel,
    [string]$Llm,
    [string]$WhisperPath,
    [string]$LiveRt,
    [bool]$PatchProviders
  )
  $cfg = Join-Path $Root '.app-runtime-config.json'
  if (-not (Test-Path $cfg)) {
    '{"version":1}' | Set-Content $cfg -Encoding UTF8
  }
  $j = Get-Content $cfg -Raw | ConvertFrom-Json
  if ($Openai) { $j | Add-Member -NotePropertyName openaiApiKey -NotePropertyValue $Openai -Force }
  if ($Anthropic) { $j | Add-Member -NotePropertyName anthropicApiKey -NotePropertyValue $Anthropic -Force }
  if ($Gemini) { $j | Add-Member -NotePropertyName geminiApiKey -NotePropertyValue $Gemini -Force }
  if ($GeminiLiveModel) { $j | Add-Member -NotePropertyName geminiLiveModel -NotePropertyValue $GeminiLiveModel -Force }
  if ($WhisperPath) { $j | Add-Member -NotePropertyName localWhisperExecutable -NotePropertyValue $WhisperPath -Force }
  $l = $Llm.ToLowerInvariant().Trim()
  $lr = $LiveRt.ToLowerInvariant().Trim()
  if ($PatchProviders) {
    if ($l -and @('openai', 'anthropic', 'gemini') -contains $l) {
      $j | Add-Member -NotePropertyName llmProvider -NotePropertyValue $l -Force
    } else {
      $p = $j.PSObject.Properties['llmProvider']
      if ($p) { $j.PSObject.Properties.Remove('llmProvider') }
    }
    if ($lr -and @('openai', 'gemini') -contains $lr) {
      $j | Add-Member -NotePropertyName liveRealtimeProvider -NotePropertyValue $lr -Force
    } else {
      $p = $j.PSObject.Properties['liveRealtimeProvider']
      if ($p) { $j.PSObject.Properties.Remove('liveRealtimeProvider') }
    }
  } else {
    if ($l -and @('openai', 'anthropic', 'gemini') -contains $l) {
      $j | Add-Member -NotePropertyName llmProvider -NotePropertyValue $l -Force
    }
    if ($lr -and @('openai', 'gemini') -contains $lr) {
      $j | Add-Member -NotePropertyName liveRealtimeProvider -NotePropertyValue $lr -Force
    }
  }
  if (-not $j.evaluationProvider) {
    $j | Add-Member -NotePropertyName evaluationProvider -NotePropertyValue 'single-agent' -Force
  }
  $j.version = 1
  ($j | ConvertTo-Json -Depth 30) | Set-Content $cfg -Encoding UTF8
}

$INSTALL_PREFIX = (New-Item -ItemType Directory -Force -Path $INSTALL_PREFIX).FullName
Write-Info "Install target: $INSTALL_PREFIX"
Write-Info "Repository: $REPO @ $RELEASE_TAG"

if (-not $AUTO_YES) {
  $yn = Read-Host 'Proceed? [y/N]'
  if ($yn -notmatch '^[yY]') { Write-Info 'Aborted.'; exit 0 }
}

$needDeps = (-not (Test-NodeOk)) -or (-not (Test-Python3Ok)) -or
  -not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or
  -not (Get-Command ffprobe -ErrorAction SilentlyContinue) -or
  -not (Get-Command tar -ErrorAction SilentlyContinue)

if ($needDeps) {
  $doWinget = $AUTO_YES
  if (-not $doWinget) {
    $r = Read-Host 'Install missing tools via winget? [Y/n]'
    $doWinget = $r -notmatch '^[nN]'
  }
  if ($doWinget) { Install-WingetDeps | Out-Null }
}

if (-not (Test-NodeOk)) {
  Write-Error "Node.js $NODE_MIN_MAJOR+ required. Install Node LTS, open a new terminal, re-run."
  exit 1
}
foreach ($c in @('ffmpeg', 'ffprobe', 'tar')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
    Write-Error "Missing '$c' on PATH."
    exit 1
  }
}
if (-not (Test-Python3Ok)) {
  Write-Error 'Python 3 required.'
  exit 1
}

$release = Get-ReleaseJson $REPO $RELEASE_TAG
$serverAsset = 'ai-interview-copilot-server-win-x64.tar.gz'
$url = Get-AssetUrl $release $serverAsset
if (-not $url) {
  Write-Error "Asset not found: $serverAsset. Use a release that includes the Windows server build."
  exit 1
}

$tmpTgz = [System.IO.Path]::GetTempFileName()
try {
  Invoke-WebRequest -Uri $url -OutFile $tmpTgz -UseBasicParsing
  & tar -xzf $tmpTgz -C $INSTALL_PREFIX
} finally {
  Remove-Item -Force $tmpTgz -ErrorAction SilentlyContinue
}

Set-Location $INSTALL_PREFIX
Set-Content -Path '.install-repo' -Value $REPO -Encoding UTF8
if (-not (Test-Path '.env') -and (Test-Path '.env.example')) { Copy-Item '.env.example' '.env' }

$dataDir = Join-Path $INSTALL_PREFIX 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$dbFile = Join-Path $dataDir 'app.db'

if (-not (Test-Path '.app-runtime-config.json')) {
  if (Test-Path '.app-runtime-config.example.json') {
    Copy-Item '.app-runtime-config.example.json' '.app-runtime-config.json'
  } else {
    Set-Content '.app-runtime-config.json' '{"version":1,"evaluationProvider":"single-agent"}' -Encoding UTF8
  }
}
Ensure-DbUrlInRuntimeConfig $INSTALL_PREFIX $dbFile

if ($AUTO_YES) {
  $liveRaw = if ($env:LIVE_REALTIME_PROVIDER) { $env:LIVE_REALTIME_PROVIDER.ToLowerInvariant().Trim() } else { '' }
  $openaiK = if ($env:OPENAI_API_KEY) { $env:OPENAI_API_KEY } else { '' }
  $geminiK = if ($env:GEMINI_API_KEY) { $env:GEMINI_API_KEY } else { '' }
  $anthK = if ($env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY } else { '' }
  $llm = if ($env:LLM_PROVIDER) { $env:LLM_PROVIDER.ToLowerInvariant().Trim() } else { 'openai' }
  $liveRt = ''
  if ($liveRaw -eq 'openai' -and $openaiK) { $liveRt = 'openai' }
  elseif ($liveRaw -eq 'gemini' -and $geminiK) { $liveRt = 'gemini' }
  $llmM = ''
  if ($llm -eq 'openai' -and $openaiK) { $llmM = 'openai' }
  elseif ($llm -eq 'anthropic' -and $anthK) { $llmM = 'anthropic' }
  elseif ($llm -eq 'gemini' -and $geminiK) { $llmM = 'gemini' }
  Merge-RuntimeSnippet -Root $INSTALL_PREFIX -Openai $openaiK -Anthropic $anthK -Gemini $geminiK -GeminiLiveModel '' `
    -Llm $llmM -WhisperPath '' -LiveRt $liveRt -PatchProviders $true
}

$dbUrl = 'file:' + ($dbFile -replace '\\', '/')
$env:DATABASE_URL = $dbUrl
npx prisma db push

$venv = Join-Path $INSTALL_PREFIX 'venv-whisper'
if (Get-Command python3 -ErrorAction SilentlyContinue) {
  & python3 -m venv $venv
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 -m venv $venv
} else {
  & python -m venv $venv
}
$pip = Join-Path $venv 'Scripts\pip.exe'
& $pip install -U pip setuptools wheel
& $pip install 'openai-whisper'

$binDir = Join-Path $INSTALL_PREFIX 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$whisperCmd = Join-Path $binDir 'whisper.cmd'
Set-Content -Path $whisperCmd -Value "@echo off`r`n`"%~dp0..\venv-whisper\Scripts\whisper.exe`" %*`r`n" -Encoding ASCII

Merge-RuntimeSnippet -Root $INSTALL_PREFIX -Openai '' -Anthropic '' -Gemini '' -GeminiLiveModel '' `
  -Llm '' -WhisperPath $whisperCmd -LiveRt '' -PatchProviders $false

Write-Warn 'If models are empty, set them in Chrome → Server config (defaults merge is Linux/macOS installer only).'

$extDir = Join-Path $INSTALL_PREFIX 'chrome-extension'
$dlExt = $AUTO_YES
if (-not $AUTO_YES) {
  $e = Read-Host 'Download Chrome extension zip from this release? [Y/n]'
  $dlExt = $e -notmatch '^[nN]'
}
if ($dlExt) {
  $extUrl = Get-AssetUrl $release $EXTENSION_ASSET_NAME
  if ($extUrl) {
    $tmpZ = "$([System.IO.Path]::GetTempFileName()).zip"
    try {
      Invoke-WebRequest -Uri $extUrl -OutFile $tmpZ -UseBasicParsing
      if (Test-Path $extDir) { Remove-Item -Recurse -Force $extDir }
      New-Item -ItemType Directory -Path $extDir | Out-Null
      Expand-Archive -Path $tmpZ -DestinationPath $extDir -Force
    } finally {
      Remove-Item $tmpZ -Force -ErrorAction SilentlyContinue
    }
    Write-Ok "Chrome extension → $extDir"
  } else {
    Write-Warn "No $EXTENSION_ASSET_NAME in this release."
  }
}

$startCmd = Join-Path $INSTALL_PREFIX 'start-server.cmd'
Set-Content -Path $startCmd -Value "@echo off`r`ncd /d `"%~dp0`"`r`nnode dist\index.js`r`n" -Encoding ASCII

$startPs1 = Join-Path $INSTALL_PREFIX 'start-server-background.ps1'
@'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT
$log = Join-Path $ROOT 'server.log'
$port = 3001
$cfgp = Join-Path $ROOT '.app-runtime-config.json'
if (Test-Path $cfgp) {
  try {
    $cj = Get-Content $cfgp -Raw | ConvertFrom-Json
    if ($cj.listenPort) { $port = [int]$cj.listenPort }
  } catch { }
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
$stamp = (Get-Date).ToString('u')
Add-Content $log "`n===== $stamp starting (PORT=$port) ====="
$p = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $ROOT -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError $log
$p.Id | Set-Content (Join-Path $ROOT 'server.pid')
Write-Host "Started PID $($p.Id) — log $log"
'@ | Set-Content -Path $startPs1 -Encoding UTF8

$stopPs1 = Join-Path $INSTALL_PREFIX 'stop-server.ps1'
@'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3001
$cfgp = Join-Path $ROOT '.app-runtime-config.json'
if (Test-Path $cfgp) {
  try {
    $cj = Get-Content $cfgp -Raw | ConvertFrom-Json
    if ($cj.listenPort) { $port = [int]$cj.listenPort }
  } catch { }
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $ROOT 'server.pid') -ErrorAction SilentlyContinue
Write-Host "Stopped listener on port $port (if any)."
'@ | Set-Content -Path $stopPs1 -Encoding UTF8

Write-Ok "Installation complete."
Write-Info "Install root:     $INSTALL_PREFIX"
Write-Info "Start (foreground): $startCmd"
Write-Info "Start (background): powershell -File `"$startPs1`""
Write-Info "Stop:               powershell -File `"$stopPs1`""
Write-Info "Optional PATH:      $binDir"
if (Test-Path (Join-Path $extDir 'manifest.json')) {
  Write-Info "Chrome: Load unpacked → $extDir"
}

if ($AUTO_YES -and $env:INSTALL_CONSUMER_START_SERVER -eq '1') {
  Set-Location $INSTALL_PREFIX
  & node dist\index.js
}

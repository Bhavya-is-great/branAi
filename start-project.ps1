param(
  [switch]$SkipBuild,
  [switch]$SkipModelPull
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step($message) {
  Write-Host "`n==> $message" -ForegroundColor Cyan
}

function Run-Command($label, $command) {
  Write-Step $label
  Write-Host $command -ForegroundColor DarkGray
  Invoke-Expression $command
}

function Ensure-DockerHealthy {
  Write-Step 'Checking Docker Desktop'
  try {
    $null = docker version 2>$null
  } catch {
    throw "Docker Desktop is not healthy. Open Docker Desktop, wait until it is running, then retry."
  }
}

function Ensure-EnvFile {
  if (-not (Test-Path '.env')) {
    if (-not (Test-Path '.env.example')) {
      throw 'Neither .env nor .env.example exists.'
    }
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example' -ForegroundColor Green
  }
}

function Get-OllamaModels {
  $output = docker compose exec -T ollama ollama list 2>$null
  if (-not $output) { return @() }
  return ($output -split "`r?`n") | Select-Object -Skip 1 | ForEach-Object {
    $parts = ($_ -split '\s+') | Where-Object { $_ }
    if ($parts.Count -gt 0) { $parts[0] }
  } | Where-Object { $_ }
}

function Ensure-OllamaModels {
  $requiredModels = @('gemma3:1b', 'gemma3:4b', 'nomic-embed-text')
  $installed = Get-OllamaModels
  foreach ($model in $requiredModels) {
    if ($installed -contains $model) {
      Write-Host "Model already present: $model" -ForegroundColor Green
      continue
    }
    Run-Command "Pulling Ollama model $model" "docker compose exec -T ollama ollama pull $model"
  }
}

try {
  Set-Location $PSScriptRoot
  Ensure-DockerHealthy
  Ensure-EnvFile

  Run-Command 'Starting Ollama' 'docker compose up -d ollama'

  if (-not $SkipModelPull) {
    Ensure-OllamaModels
  }

  if (-not $SkipBuild) {
    Run-Command 'Building containers' 'docker compose build'
  }

  Run-Command 'Starting full stack' 'docker compose up -d'
  Run-Command 'Showing container status' 'docker compose ps'

  Write-Host "`nProject is starting." -ForegroundColor Green
  Write-Host 'App: http://localhost:3000'
  Write-Host 'API: http://localhost:4000'
  Write-Host 'Proxy: http://localhost:8080'
}
catch {
  Write-Host "`nStartup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'If Docker still shows 500 errors, fix Docker Desktop first and rerun this script.' -ForegroundColor Yellow
  exit 1
}
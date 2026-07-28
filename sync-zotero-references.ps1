param(
  [string]$ReferenceRoot = (Join-Path $PSScriptRoot ".references")
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$GitArgs,
    [int]$Attempts = 1
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    & git @GitArgs
    if ($LASTEXITCODE -eq 0) {
      return
    }
    $exitCode = $LASTEXITCODE
    if ($attempt -lt $Attempts) {
      Write-Warning "Git command failed (attempt $attempt/$Attempts, exit $exitCode). Retrying..."
      Start-Sleep -Seconds 2
    }
  }
  throw "Git command failed after $Attempts attempt(s) (exit $exitCode): git $($GitArgs -join ' ')"
}

function Get-DirectorySize {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $measurement = Get-ChildItem -LiteralPath $Path -File -Recurse -Force |
    Measure-Object -Property Length -Sum
  if ($null -eq $measurement.Sum) {
    return [long]0
  }
  return [long]$measurement.Sum
}

function Sync-ReferenceRepository {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [string]$Branch,
    [Parameter(Mandatory = $true)]
    [string[]]$SparsePaths,
    [switch]$NonCone
  )

  $target = Join-Path $ReferenceRoot $Name
  $gitDirectory = Join-Path $target ".git"

  if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
      throw "Target exists but is not a Git repository: $target"
    }
    Write-Host "Updating $Name ..."
    Invoke-Git -GitArgs @("-C", $target, "pull", "--ff-only") -Attempts 3
  } else {
    Write-Host "Downloading $Name ..."
    Invoke-Git -GitArgs @(
      "clone",
      "--depth", "1",
      "--filter=blob:none",
      "--sparse",
      "--branch", $Branch,
      $Url,
      $target
    ) -Attempts 3
  }

  if ($NonCone) {
    Invoke-Git -GitArgs (@(
      "-C", $target,
      "sparse-checkout", "set", "--no-cone"
    ) + $SparsePaths)
  } else {
    Invoke-Git -GitArgs (@(
      "-C", $target,
      "sparse-checkout", "set"
    ) + $SparsePaths)
  }

  $commit = (& git -C $target rev-parse --short HEAD).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot read the current commit for $Name."
  }
  $sizeMiB = [math]::Round((Get-DirectorySize -Path $target) / 1MB, 2)
  Write-Host "Completed ${Name}: commit=$commit, disk=${sizeMiB} MiB"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git was not found in PATH."
}

if (-not (Test-Path -LiteralPath $ReferenceRoot)) {
  New-Item -ItemType Directory -Path $ReferenceRoot | Out-Null
}

$ReferenceRoot = [System.IO.Path]::GetFullPath($ReferenceRoot)
Write-Host "Zotero reference root: $ReferenceRoot"

Sync-ReferenceRepository `
  -Name "zotero-docs" `
  -Url "https://github.com/zotero/zotero-docs.git" `
  -Branch "main" `
  -SparsePaths @("content/dev")

Sync-ReferenceRepository `
  -Name "zotero-reader" `
  -Url "https://github.com/zotero/reader.git" `
  -Branch "master" `
  -SparsePaths @("src")

Sync-ReferenceRepository `
  -Name "zotero-source" `
  -Url "https://github.com/zotero/zotero.git" `
  -Branch "main" `
  -NonCone `
  -SparsePaths @(
    "/chrome/content/zotero/xpcom/pluginAPI/",
    "/chrome/content/zotero/xpcom/reader.js",
    "/chrome/content/zotero/reader/"
  )

Write-Host "Zotero official references are up to date."

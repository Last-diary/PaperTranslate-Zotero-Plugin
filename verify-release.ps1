# 检查实际发布产物，避免更新清单与安装包不一致。
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$updates = Get-Content (Join-Path $root "updates.json") -Raw | ConvertFrom-Json
$id = $manifest.applications.zotero.id
$entries = @($updates.addons.$id.updates)
if ($entries.Count -ne 1) { throw "Expected exactly one update entry for $id" }
$update = $entries[0]
$xpiPath = Join-Path $root "papertranslate.xpi"
$hash = (Get-FileHash $xpiPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($update.update_hash -cne "sha256:$hash") { throw "XPI hash mismatch" }
$expectedLink = "https://github.com/Last-diary/PaperTranslate-Zotero-Plugin/releases/download/v$($manifest.version)/papertranslate.xpi"
if ($update.update_link -cne $expectedLink) { throw "Release download URL mismatch" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($xpiPath)
try {
  $entry = $zip.GetEntry("manifest.json")
  if (-not $entry) { throw "Missing root manifest.json" }
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { $packed = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($packed.version -cne $manifest.version -or $update.version -cne $packed.version) {
    throw "Package/update/source version mismatch"
  }
  foreach ($key in @("id", "update_url", "strict_min_version", "strict_max_version")) {
    if ($packed.applications.zotero.$key -cne $manifest.applications.zotero.$key) {
      throw "Package metadata mismatch: $key"
    }
  }
  foreach ($key in @("strict_min_version", "strict_max_version")) {
    if ($update.applications.zotero.$key -cne $packed.applications.zotero.$key) {
      throw "Update compatibility mismatch: $key"
    }
  }
  foreach ($file in $zip.Entries) {
    if ($file.FullName.Contains('\') -or $file.FullName -match '^(\.git|\.references|test)/' -or $file.FullName -eq 'updates.json') {
      throw "Unexpected archive entry: $($file.FullName)"
    }
  }
} finally { $zip.Dispose() }
Write-Host "Release artifacts verified: version=$($manifest.version), id=$id, sha256=$hash"

# 打包 PaperTranslate 插件为 .xpi（XPI 本质是 zip）
# 注意：Windows PowerShell 5.1 的 Compress-Archive 会把条目路径写成反斜杠，
# 导致 Zotero 无法正确读取包内文件（安装时报“不兼容”）。
# 这里改用 .NET ZipArchive，并强制使用正斜杠条目名。
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$zotero = $manifest.applications.zotero
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "正式发布版本必须为 x.y.z：$version"
}
$releaseBase = "https://github.com/Last-diary/PaperTranslate-Zotero-Plugin/releases"
if ($zotero.update_url -ne "$releaseBase/latest/download/updates.json") {
  throw "manifest.json 的 update_url 与发布地址不一致"
}
$xpiPath = Join-Path $root "papertranslate.xpi"
if (Test-Path $xpiPath) { Remove-Item $xpiPath -Force }

$include = @(
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "chrome",
  "locale",
  "icons",
  "README.md"
)

$files = foreach ($item in $include) {
  $path = Join-Path $root $item
  if (Test-Path $path -PathType Container) {
    Get-ChildItem $path -Recurse -File
  } elseif (Test-Path $path) {
    Get-Item $path
  } else {
    Write-Warning "不存在，已跳过：$item"
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($xpiPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length + 1).Replace("\", "/")
    $entry = $zip.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    try {
      $fileStream = [System.IO.File]::OpenRead($file.FullName)
      try {
        $fileStream.CopyTo($entryStream)
      } finally {
        $fileStream.Dispose()
      }
    } finally {
      $entryStream.Dispose()
    }
  }
} finally {
  $zip.Dispose()
}

Write-Host "Built: $xpiPath ($($files.Count) 个文件)"

$hash = (Get-FileHash -LiteralPath $xpiPath -Algorithm SHA256).Hash.ToLowerInvariant()
$addons = @{}
$addons[$zotero.id] = @{
  updates = @(@{
    version = $version
    update_link = "$releaseBase/download/v$version/papertranslate.xpi"
    update_hash = "sha256:$hash"
    applications = @{
      zotero = @{
        strict_min_version = $zotero.strict_min_version
        strict_max_version = $zotero.strict_max_version
      }
    }
  })
}
$updatesPath = Join-Path $root "updates.json"
$json = @{ addons = $addons } | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($updatesPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Built: $updatesPath (version=$version, sha256=$hash)"

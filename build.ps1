# 打包 PaperTranslate 插件为 .xpi（XPI 本质是 zip）
# 注意：Windows PowerShell 5.1 的 Compress-Archive 会把条目路径写成反斜杠，
# 导致 Zotero 无法正确读取包内文件（安装时报“不兼容”）。
# 这里改用 .NET ZipArchive，并强制使用正斜杠条目名。
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
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

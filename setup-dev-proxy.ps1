param(
  [string]$ProfilePath = "C:\Users\pipilong\AppData\Roaming\Zotero\Zotero\Profiles\1zr364kd.default"
)

$ErrorActionPreference = "Stop"

$pluginId = "papertranslate@papertranslate.dev"
$sourcePath = [System.IO.Path]::GetFullPath($PSScriptRoot)
$profilePath = [System.IO.Path]::GetFullPath($ProfilePath)
$extensionsPath = Join-Path $profilePath "extensions"
$installedXpi = Join-Path $extensionsPath "$pluginId.xpi"
$proxyPath = Join-Path $extensionsPath $pluginId
$prefsPath = Join-Path $profilePath "prefs.js"

if (Get-Process zotero -ErrorAction SilentlyContinue) {
  throw "Zotero 仍在运行。请先正常关闭 Zotero，再重新执行此脚本。"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "bootstrap.js") -PathType Leaf)) {
  throw "源码目录无效：$sourcePath"
}
if (-not (Test-Path -LiteralPath $extensionsPath -PathType Container)) {
  throw "Zotero extensions 目录不存在：$extensionsPath"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (Test-Path -LiteralPath $installedXpi -PathType Leaf) {
  $backupXpi = Join-Path $extensionsPath "$pluginId.xpi.bak-$stamp"
  Move-Item -LiteralPath $installedXpi -Destination $backupXpi
  Write-Host "已备份当前 XPI：$backupXpi"
}

[System.IO.File]::WriteAllText(
  $proxyPath,
  $sourcePath,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "已创建源码代理：$proxyPath -> $sourcePath"

if (Test-Path -LiteralPath $prefsPath -PathType Leaf) {
  $prefsBackup = "$prefsPath.bak-papertranslate-$stamp"
  Copy-Item -LiteralPath $prefsPath -Destination $prefsBackup
  $lines = [System.IO.File]::ReadAllLines($prefsPath)
  $filtered = $lines | Where-Object {
    $_ -notmatch 'user_pref\("extensions\.lastApp(BuildId|Version)"'
  }
  [System.IO.File]::WriteAllLines(
    $prefsPath,
    $filtered,
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Host "已备份并更新 prefs.js：$prefsBackup"
}

Write-Host "开发代理配置完成。请运行 .\start-dev.ps1 启动 Zotero。"

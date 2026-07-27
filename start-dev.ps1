param(
  [string]$ZoteroPath = "C:\Program Files\Zotero\zotero.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ZoteroPath -PathType Leaf)) {
  throw "找不到 Zotero：$ZoteroPath"
}
if (Get-Process zotero -ErrorAction SilentlyContinue) {
  throw "Zotero 已在运行。请先正常关闭，再运行此脚本以加载最新插件源码。"
}

Start-Process -FilePath $ZoteroPath -ArgumentList "-purgecaches"
Write-Host "Zotero 已以 -purgecaches 启动，将直接加载当前插件源码。"

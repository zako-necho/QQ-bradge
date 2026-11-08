# QQ 桥接桌面版 —— 构建脚本
#
# 把 app/ 里的源码和一份 Electron 运行时拼成可双击运行的目录。
#   .\build.ps1
#   .\build.ps1 -ElectronVersion 45.2.3 -OutDir dist
#
# 依赖：Windows + PowerShell 5.1 以上 + 自带的 tar/curl（Win10 1803+ 都有）。

param(
  [string]$ElectronVersion = '45.2.3',
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Join-Path $here 'app'
$out = Join-Path $here $OutDir
$cache = Join-Path $here '.cache'

# ---- 检查源码 ----
if (-not (Test-Path (Join-Path $appDir 'main.js'))) {
  throw "找不到 app/main.js，请在仓库根目录运行本脚本"
}
Write-Host "[构建] 源码：$appDir"

# ---- 下载 Electron（有缓存就跳过）----
$zipName = "electron-v$ElectronVersion-win32-x64.zip"
$zip = Join-Path $cache $zipName
if (-not (Test-Path $zip)) {
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $url = "https://npmmirror.com/mirrors/electron/$ElectronVersion/$zipName"
  Write-Host "[构建] 下载 $url"
  curl.exe -L --fail --silent --show-error -o $zip $url
  if (-not (Test-Path $zip)) { throw "下载失败：$url" }
} else {
  Write-Host "[构建] 使用缓存：$zip"
}

# ---- 解压 ----
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Write-Host "[构建] 解压到 $out"
tar -xf $zip -C $out
if (Test-Path (Join-Path $out 'resources\default_app.asar')) {
  Remove-Item (Join-Path $out 'resources\default_app.asar') -Force
}

# ---- 放入 app ----
$resApp = Join-Path $out 'resources\app'
if (Test-Path $resApp) { Remove-Item $resApp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $resApp | Out-Null
Copy-Item (Join-Path $appDir '*') $resApp -Recurse -Force

# 不要把开发时的个人数据带出去
Remove-Item (Join-Path $resApp 'desktop.log') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $resApp 'settings.json') -Force -ErrorAction SilentlyContinue

# ---- 改名 ----
$exe = Join-Path $out 'electron.exe'
$target = Join-Path $out 'QQ桥接.exe'
if (Test-Path $exe) { Rename-Item $exe $target -Force }

# ---- 图标 ----
# rcedit 优先用本地那份；没有就自动从 npmmirror 的 winCodeSign 包里解一份出来。
$rcedit = Join-Path $here 'rcedit-x64.exe'
if (-not (Test-Path $rcedit) -and (Test-Path $target)) {
  try {
    Write-Host "[构建] 获取 rcedit…"
    $wcsZip = Join-Path $cache 'winCodeSign.7z'
    if (-not (Test-Path $wcsZip)) {
      curl.exe -L --fail --silent --show-error -o $wcsZip `
        "https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
    }
    if (Test-Path $wcsZip) {
      New-Item -ItemType Directory -Force -Path $cache | Out-Null
      # darwin/ 里的符号链接在 Windows 上解不出来，会报无关紧要的错，忽略
      & tar -xf $wcsZip -C $cache 2>$null
      $found = Get-ChildItem $cache -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($found) { Copy-Item $found.FullName $rcedit -Force }
    }
  } catch {
    Write-Warning "获取 rcedit 失败：$($_.Exception.Message)"
  }
}

if ((Test-Path $rcedit) -and (Test-Path $target)) {
  Write-Host "[构建] 写入 exe 图标"
  & $rcedit $target --set-icon (Join-Path $appDir 'icon.ico')
  if ($LASTEXITCODE -ne 0) { Write-Warning "rcedit 返回 $LASTEXITCODE，图标可能没写进去" }
} else {
  Write-Host "[构建] 没拿到 rcedit，跳过 exe 图标（程序仍可运行，托盘图标不受影响）"
}

# ---- 说明 ----
Copy-Item (Join-Path $here 'README.md') $out -Force -ErrorAction SilentlyContinue

$size = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[构建] 完成：$target")
Write-Host ("[构建] 体积：{0:N0} MB" -f ($size / 1MB))

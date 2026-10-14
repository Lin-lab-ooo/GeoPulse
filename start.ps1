param([int]$Port = 4173)
$ErrorActionPreference = 'Stop'
$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$taskNodePath = if ($taskNodeCommand) { $taskNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $taskNodePath)) { throw '需要 Node.js 20 或更新版本。安装后运行 npm start。' }
$env:PORT = [string]$Port
Write-Host "GeoPulse: http://127.0.0.1:$Port"
& $taskNodePath (Join-Path $PSScriptRoot 'server.mjs')

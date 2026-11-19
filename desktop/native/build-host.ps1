param(
    [string]$OutputDirectory = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
$exe = Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path 'filerecall-host.exe'
& $compiler /nologo /target:exe "/out:$exe" (Join-Path $PSScriptRoot 'HostLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw '无法编译 FileRecall Chrome 连接组件。' }

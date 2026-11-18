param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$major = & $node -p 'Number(process.versions.node.split(".")[0])'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw '需要 Node.js 24 或更高版本。' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$exe = Join-Path $PSScriptRoot 'filerecall-host.exe'
& $compiler /nologo /target:exe "/out:$exe" (Join-Path $PSScriptRoot 'HostLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw '无法编译 FileRecall Chrome 连接组件。' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'node-path.txt'), $node, $utf8)
$manifestPath = Join-Path $PSScriptRoot 'host-manifest.json'
$manifest = @{
    name = 'com.filerecall.desktop'
    description = 'FileRecall local download sync'
    path = $exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, $utf8)
if (!$BuildOnly) {
    & reg.exe add 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.filerecall.desktop' /ve /t REG_SZ /d $manifestPath /f
    if ($LASTEXITCODE -ne 0) { throw '无法注册 FileRecall Chrome 连接组件。' }
}

param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $ProjectRoot

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $ProjectRoot 'data'
}

if (-not $env:DATA_DIR) {
    $env:DATA_DIR = $DataDir
}

$node = (Get-Command node).Source
$restarts = New-Object System.Collections.Generic.List[datetime]
$delaySeconds = 5

while ($true) {
    Write-Host "starting companion at $(Get-Date -Format o)"
    & $node '--disable-warning=ExperimentalWarning' (Join-Path $ProjectRoot 'src/index.js')
    $code = $LASTEXITCODE
    Write-Host "companion exited with code $code"

    if ($code -ne 42) {
        exit $code
    }

    $cutoff = (Get-Date).AddHours(-1)
    $recent = @($restarts | Where-Object { $_ -gt $cutoff })
    if ($recent.Count -ge 3) {
        Write-Host 'companion exited 42 three times within an hour; stop restarting'
        exit 42
    }

    $restarts.Add((Get-Date))
    Write-Host "restarting after crash ($($recent.Count + 1)/3 in the last hour)"
    Start-Sleep -Seconds $delaySeconds
}

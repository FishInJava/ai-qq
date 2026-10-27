param([string]$RuntimePath)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

function Get-Runtime {
    try {
        return Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Open-Page {
    $runtime = Get-Runtime
    if ($null -eq $runtime) {
        [System.Windows.Forms.MessageBox]::Show('服务还没准备好。', '在旁边') | Out-Null
        return
    }
    Start-Process "http://127.0.0.1:$($runtime.port)/"
}

function Invoke-Admin([string]$Name) {
    $runtime = Get-Runtime
    if ($null -eq $runtime) {
        return
    }
    try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($runtime.port)/api/admin/$Name" -TimeoutSec 4 | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show('服务没有响应，稍后再试。', '在旁边') | Out-Null
    }
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = '在旁边'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开页面')
$openItem.add_Click({ Open-Page })
$pauseItem = $menu.Items.Add('暂停所有会话')
$pauseItem.add_Click({ Invoke-Admin 'pause-all' })
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$quitItem = $menu.Items.Add('退出')
$quitItem.add_Click({
    Invoke-Admin 'quit'
    Start-Sleep -Milliseconds 300
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Open-Page })
$notify.ShowBalloonTip(1500, '在旁边', '她已经在自己的时间里了。', [System.Windows.Forms.ToolTipIcon]::None)

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $notify.Visible = $false
    $notify.Dispose()
}

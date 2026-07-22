param(
  [ValidateSet('web', 'pwa')]
  [string]$Mode = 'web'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public sealed class PiChatSpinner : Control {
    public float Angle { get; set; }

    public PiChatSpinner() {
        Angle = -70f;
        SetStyle(ControlStyles.UserPaint |
                 ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaintBackground(PaintEventArgs e) {
        e.Graphics.Clear(Parent == null ? Color.White : Parent.BackColor);
    }

    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        const int scale = 4;
        using (var frame = new Bitmap(Width * scale, Height * scale))
        using (var graphics = Graphics.FromImage(frame))
        using (var pen = new Pen(Color.FromArgb(42, 108, 221), 3.0f * scale)) {
            graphics.Clear(Parent == null ? Color.White : Parent.BackColor);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            graphics.DrawArc(pen, 4 * scale, 4 * scale, (Width - 9) * scale, (Height - 9) * scale, Angle, 275f);
            e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            e.Graphics.DrawImage(frame, new Rectangle(0, 0, Width, Height));
        }
    }
}
'@

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$uiScriptPath = $MyInvocation.MyCommand.Path
$launcher = Join-Path $project 'pi-chat-launch.cmd'
$launcherProcessHelper = Join-Path $project 'scripts\pi-chat-launch-process.ps1'
. $launcherProcessHelper
$iconPath = Join-Path $project 'resources\icons\pi-chat.ico'
$logoPath = Join-Path $project 'src\web\public\icons\pi-chat-512.png'
if (-not (Test-Path -LiteralPath $logoPath)) { $logoPath = Join-Path $project 'dist\web\icons\pi-chat-512.png' }
$logDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Pi Chat'
[void](New-Item -ItemType Directory -Force -Path $logDirectory)
$logPath = Join-Path $logDirectory 'launcher.log'
$runId = '{0:yyyyMMdd-HHmmss}-{1}' -f [DateTime]::Now, $PID
$launcherOutPath = Join-Path $logDirectory ("launcher-$runId.stdout.log")
$launcherErrPath = Join-Path $logDirectory ("launcher-$runId.stderr.log")
$serverOutPath = Join-Path $logDirectory ("server-$runId.stdout.log")
$serverErrPath = Join-Path $logDirectory ("server-$runId.stderr.log")
Set-Content -LiteralPath $logPath -Value ("Pi Chat launcher started at {0:u}" -f [DateTime]::Now)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Pi Chat'
$form.ClientSize = New-Object System.Drawing.Size(340, 88)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::White
$form.TopMost = $true

$appIcon = $null
$logoImage = $null
if (Test-Path -LiteralPath $iconPath) {
  $appIcon = New-Object System.Drawing.Icon($iconPath)
  $form.Icon = $appIcon
}
if (Test-Path -LiteralPath $logoPath) {
  $sourceImage = [System.Drawing.Image]::FromFile($logoPath)
  $logoImage = New-Object System.Drawing.Bitmap(44, 44)
  $graphics = [System.Drawing.Graphics]::FromImage($logoImage)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($sourceImage, 0, 0, 44, 44)
  $graphics.Dispose()
  $sourceImage.Dispose()

  $logo = New-Object System.Windows.Forms.PictureBox
  $logo.Location = New-Object System.Drawing.Point(22, 22)
  $logo.Size = New-Object System.Drawing.Size(44, 44)
  $logo.SizeMode = 'Normal'
  $logo.Image = $logoImage
  $form.Controls.Add($logo)
}

$spinner = New-Object PiChatSpinner
$spinner.Location = New-Object System.Drawing.Point(86, 29)
$spinner.Size = New-Object System.Drawing.Size(30, 30)
$form.Controls.Add($spinner)

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Pi Chat starting'
$label.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Regular)
$label.ForeColor = [System.Drawing.Color]::FromArgb(24, 33, 49)
$label.Location = New-Object System.Drawing.Point(130, 30)
$label.Size = New-Object System.Drawing.Size(180, 28)
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$form.Controls.Add($label)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.Text = ''
$detailLabel.Font = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
$detailLabel.ForeColor = [System.Drawing.Color]::FromArgb(110, 120, 135)
$detailLabel.Location = New-Object System.Drawing.Point(86, 48)
$detailLabel.Size = New-Object System.Drawing.Size(230, 34)
$detailLabel.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
$detailLabel.Visible = $false
$form.Controls.Add($detailLabel)

function New-PiChatActionButton {
  param(
    [string]$Text,
    [System.Drawing.Point]$Location,
    [System.Drawing.Size]$Size,
    [System.Drawing.Color]$ForeColor,
    [System.Drawing.Color]$BackColor,
    [System.Drawing.Color]$BorderColor
  )
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = $Location
  $button.Size = $Size
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 1
  $button.FlatAppearance.BorderColor = $BorderColor
  $button.BackColor = $BackColor
  $button.ForeColor = $ForeColor
  $button.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Regular)
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  $button.Visible = $false
  $button.UseVisualStyleBackColor = $false
  return $button
}

$openLogButton = New-PiChatActionButton `
  -Text '打开日志' `
  -Location (New-Object System.Drawing.Point(86, 90)) `
  -Size (New-Object System.Drawing.Size(100, 30)) `
  -ForeColor ([System.Drawing.Color]::FromArgb(42, 108, 221)) `
  -BackColor ([System.Drawing.Color]::FromArgb(245, 248, 252)) `
  -BorderColor ([System.Drawing.Color]::FromArgb(180, 200, 230))
$openLogButton.Add_Click({ Start-Process -FilePath "$env:SystemRoot\System32\notepad.exe" -ArgumentList @($logPath) })
$form.Controls.Add($openLogButton)

$retryButton = New-PiChatActionButton `
  -Text '重试' `
  -Location (New-Object System.Drawing.Point(194, 90)) `
  -Size (New-Object System.Drawing.Size(64, 30)) `
  -ForeColor ([System.Drawing.Color]::White) `
  -BackColor ([System.Drawing.Color]::FromArgb(42, 108, 221)) `
  -BorderColor ([System.Drawing.Color]::FromArgb(42, 108, 221))
$retryButton.Add_Click({
  $form.Hide()
  $retry = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $uiScriptPath,
    '-Mode', $Mode
  ) -WorkingDirectory $project -PassThru
  if ($retry) { $form.Close() } else { $form.Show() }
})
$form.Controls.Add($retryButton)

$closeButton = New-PiChatActionButton `
  -Text '关闭' `
  -Location (New-Object System.Drawing.Point(266, 90)) `
  -Size (New-Object System.Drawing.Size(50, 30)) `
  -ForeColor ([System.Drawing.Color]::FromArgb(70, 80, 95)) `
  -BackColor ([System.Drawing.Color]::White) `
  -BorderColor ([System.Drawing.Color]::FromArgb(210, 216, 224))
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

$script:launcherExitCode = 0
$script:failureShown = $false
$script:successHandled = $false
$process = $null

function Open-PiChatWindow {
  param([ValidateSet('web', 'pwa')][string]$OpenMode)
  $url = 'http://127.0.0.1:30170'
  if ($OpenMode -eq 'pwa') {
    $edgePwa = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge_proxy.exe'
    if (Test-Path -LiteralPath $edgePwa) {
      Start-Process -FilePath $edgePwa -ArgumentList @(
        '--profile-directory=Default',
        '--app-id=geogmfmioogonffbmpjonolpkgepgafd',
        "--app-url=$url",
        '--app-launch-source=4',
        '--new-window'
      ) | Out-Null
      return
    }
  }
  Start-Process -FilePath $url | Out-Null
}

try {
  # Keep project paths out of cmd.exe source. Quoted environment expansion is safe
  # for checkout paths containing spaces, ampersands, parentheses, or apostrophes.
  $env:PI_CHAT_SERVER_OUT = $serverOutPath
  $env:PI_CHAT_SERVER_ERR = $serverErrPath
  # Splash owns the browser open so it can hide before Chat appears.
  $env:PI_CHAT_SKIP_OPEN = '1'
  $process = Start-PiChatLauncherProcess `
    -ProjectDirectory $project `
    -LauncherPath $launcher `
    -Mode $Mode `
    -StandardOutputPath $launcherOutPath `
    -StandardErrorPath $launcherErrPath
} catch {
  Add-Content -LiteralPath $logPath -Value $_.Exception.ToString()
  $script:launcherExitCode = 1
}

$animationTimer = New-Object System.Windows.Forms.Timer
$animationTimer.Interval = 16
$animationTimer.Add_Tick({
  $spinner.Angle = ($spinner.Angle + 6) % 360
  $spinner.Invalidate()
})

$exitTimer = New-Object System.Windows.Forms.Timer
$exitTimer.Interval = 50
$exitTimer.Add_Tick({
  if ($script:failureShown -or $script:successHandled) { return }
  if ($process -and -not $process.HasExited) { return }
  if ($process) { $script:launcherExitCode = Get-PiChatLauncherExitCode -Process $process }
  if ($script:launcherExitCode -ne 0) {
    $script:failureShown = $true
    Add-Content -LiteralPath $logPath -Value "`r`n--- Pi Chat Launcher stdout ---"
    if (Test-Path -LiteralPath $launcherOutPath) { Get-Content -LiteralPath $launcherOutPath | Add-Content -LiteralPath $logPath }
    Add-Content -LiteralPath $logPath -Value "`r`n--- Pi Chat Launcher stderr ---"
    if (Test-Path -LiteralPath $launcherErrPath) { Get-Content -LiteralPath $launcherErrPath | Add-Content -LiteralPath $logPath }
    Add-Content -LiteralPath $logPath -Value "`r`n--- Pi Chat Server stdout ---"
    if (Test-Path -LiteralPath $serverOutPath) { Get-Content -LiteralPath $serverOutPath | Add-Content -LiteralPath $logPath }
    Add-Content -LiteralPath $logPath -Value "`r`n--- Pi Chat Server stderr ---"
    if (Test-Path -LiteralPath $serverErrPath) { Get-Content -LiteralPath $serverErrPath | Add-Content -LiteralPath $logPath }
    $animationTimer.Stop()
    $spinner.Visible = $false

    $summary = "退出代码 $($script:launcherExitCode)"
    foreach ($candidate in @($launcherErrPath, $serverErrPath, $launcherOutPath, $serverOutPath)) {
      if (-not (Test-Path -LiteralPath $candidate)) { continue }
      $lines = @(Get-Content -LiteralPath $candidate -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
      if ($lines.Count -gt 0) {
        $tail = [string]$lines[-1]
        if ($tail.Length -gt 90) { $tail = $tail.Substring(0, 87) + '...' }
        $summary = $tail
        break
      }
    }

    $label.Text = 'Pi Chat 启动失败'
    $label.ForeColor = [System.Drawing.Color]::FromArgb(176, 32, 37)
    $label.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $label.Location = New-Object System.Drawing.Point(86, 18)
    $label.Size = New-Object System.Drawing.Size(230, 26)
    $detailLabel.Text = $summary
    $detailLabel.Visible = $true
    $openLogButton.Visible = $true
    $retryButton.Visible = $true
    $closeButton.Visible = $true
    $form.ClientSize = New-Object System.Drawing.Size(340, 136)
    $form.Activate()
    return
  }
  # Service is ready: hide splash first, then open Chat so the window does not
  # linger over the browser for an extra fixed delay.
  $script:successHandled = $true
  $animationTimer.Stop()
  $exitTimer.Stop()
  $form.Hide()
  try { Open-PiChatWindow -OpenMode $Mode } catch { Add-Content -LiteralPath $logPath -Value $_.Exception.ToString(); $script:launcherExitCode = 1 }
  $form.Close()
})

$form.Add_Shown({
  $animationTimer.Start()
  $exitTimer.Start()
  $form.Activate()
})
$form.Add_FormClosed({
  $animationTimer.Stop()
  $exitTimer.Stop()
  $animationTimer.Dispose()
  $exitTimer.Dispose()
  if ($process) { $process.Dispose() }
  if ($logoImage) { $logoImage.Dispose() }
  if ($appIcon) { $appIcon.Dispose() }
})
[void]$form.ShowDialog()
exit $script:launcherExitCode

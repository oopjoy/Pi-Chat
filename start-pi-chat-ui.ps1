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

$openLogButton = New-Object System.Windows.Forms.Button
$openLogButton.Text = 'Open log'
$openLogButton.Location = New-Object System.Drawing.Point(130, 70)
$openLogButton.Size = New-Object System.Drawing.Size(88, 28)
$openLogButton.Visible = $false
$openLogButton.Add_Click({ Start-Process -FilePath "$env:SystemRoot\System32\notepad.exe" -ArgumentList @($logPath) })
$form.Controls.Add($openLogButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = 'Close'
$closeButton.Location = New-Object System.Drawing.Point(228, 70)
$closeButton.Size = New-Object System.Drawing.Size(88, 28)
$closeButton.Visible = $false
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

$script:launcherExitCode = 0
$script:launcherExitedAt = $null
$script:failureShown = $false
$process = $null
try {
  # Keep project paths out of cmd.exe source. Quoted environment expansion is safe
  # for checkout paths containing spaces, ampersands, parentheses, or apostrophes.
  $env:PI_CHAT_SERVER_OUT = $serverOutPath
  $env:PI_CHAT_SERVER_ERR = $serverErrPath
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
$exitTimer.Interval = 80
$exitTimer.Add_Tick({
  if ($script:failureShown) { return }
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
    $label.Text = 'Pi Chat failed to start'
    $label.ForeColor = [System.Drawing.Color]::FromArgb(176, 32, 37)
    $label.Location = New-Object System.Drawing.Point(86, 20)
    $label.Size = New-Object System.Drawing.Size(230, 35)
    $openLogButton.Visible = $true
    $closeButton.Visible = $true
    $form.ClientSize = New-Object System.Drawing.Size(340, 116)
    $form.Activate()
    return
  }
  if ($null -eq $script:launcherExitedAt) { $script:launcherExitedAt = [DateTime]::UtcNow }
  if (([DateTime]::UtcNow - $script:launcherExitedAt).TotalMilliseconds -ge 280) { $form.Close() }
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

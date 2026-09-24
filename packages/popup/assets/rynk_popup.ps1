# Rynk "Host this project" popup for Windows (WinForms, no extra install).
# Same JSON-lines protocol as rynk_popup.py. Closing it never stops hosting.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Send($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

$queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$rs = [runspacefactory]::CreateRunspace(); $rs.Open(); $rs.SessionStateProxy.SetVariable('queue', $queue)
$reader = [powershell]::Create(); $reader.Runspace = $rs
[void]$reader.AddScript({ $in = [Console]::In; while ($null -ne ($l = $in.ReadLine())) { $queue.Enqueue($l) }; $queue.Enqueue('{"type":"close"}') })
[void]$reader.BeginInvoke()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Rynk'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.MinimizeBox = $true
$form.StartPosition = 'CenterScreen'; $form.AutoSize = $true; $form.AutoSizeMode = 'GrowAndShrink'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9); $form.KeyPreview = $true; $form.TopMost = $true
$script:mode = 'waiting'; $script:init = $null; $script:live = $null; $script:started = $null
$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.AutoSize = $true; $root.Padding = '14,12,14,12'; $root.ColumnCount = 2
$form.Controls.Add($root)

function Clear-View { $root.Controls.Clear(); $root.RowStyles.Clear(); $root.RowCount = 0 }
function Add-Row($label, $control) {
  $l = New-Object System.Windows.Forms.Label; $l.Text = $label; $l.AutoSize = $true; $l.ForeColor = [System.Drawing.Color]::DimGray; $l.Margin = '0,6,12,0'
  $root.Controls.Add($l, 0, $root.RowCount); $root.Controls.Add($control, 1, $root.RowCount); $root.RowCount++
}
function Add-Full($control) { $root.Controls.Add($control, 0, $root.RowCount); $root.SetColumnSpan($control, 2); $root.RowCount++ }
function New-Label($text, $size = 9, $bold = $false, $color = $null) {
  $l = New-Object System.Windows.Forms.Label; $l.Text = $text; $l.AutoSize = $true; $l.MaximumSize = '400,0'
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, $style); if ($color) { $l.ForeColor = $color }; $l.Margin = '0,3,0,3'; return $l
}

function Show-Config {
  $script:mode = 'config'; Clear-View
  $p = $script:init.project; $d = $script:init.defaults; $ifaces = @($script:init.network.interfaces)
  Add-Full (New-Label 'Host with Rynk' 13 $true)
  Add-Full (New-Label $p.name 11 $true)
  Add-Full (New-Label ((@($p.framework, $p.runtimeLabel, $p.packageManager) | Where-Object { $_ }) -join ' · ') 9 $false ([System.Drawing.Color]::DimGray))
  $script:tbName = New-Object System.Windows.Forms.TextBox; $tbName.Width = 260; $tbName.Text = $(if ($d.name) { $d.name } else { $p.name }); Add-Row 'Project name' $tbName
  $script:tbCmd = New-Object System.Windows.Forms.TextBox; $tbCmd.Width = 260; $tbCmd.Text = $(if ($d.command) { $d.command } else { $p.command }); Add-Row 'Start command' $tbCmd
  $script:cbRuntime = New-Object System.Windows.Forms.ComboBox; $cbRuntime.DropDownStyle = 'DropDownList'; $cbRuntime.Width = 260
  foreach ($r in $script:init.options.runtimes) { [void]$cbRuntime.Items.Add($r) }; $cbRuntime.SelectedIndex = 0; Add-Row 'Runtime' $cbRuntime
  $script:cbPort = New-Object System.Windows.Forms.ComboBox; $cbPort.Width = 260; [void]$cbPort.Items.Add('Auto')
  foreach ($x in $script:init.options.ports) { [void]$cbPort.Items.Add([string]$x) }; $cbPort.Text = [string]$d.port; Add-Row 'Port' $cbPort
  $script:cbNet = New-Object System.Windows.Forms.ComboBox; $cbNet.DropDownStyle = 'DropDownList'; $cbNet.Width = 260
  foreach ($i in $ifaces) { [void]$cbNet.Items.Add(('{0}  {1}' -f $i.name, $i.address)) }
  if ($cbNet.Items.Count) { $cbNet.SelectedIndex = 0 }; Add-Row 'Network' $cbNet
  $script:cbExp = New-Object System.Windows.Forms.ComboBox; $cbExp.DropDownStyle = 'DropDownList'; $cbExp.Width = 260
  foreach ($x in 'Local only', 'LAN', 'Public tunnel') { [void]$cbExp.Items.Add($x) }
  $cbExp.SelectedIndex = @{ local = 0; lan = 1; public = 2 }[$d.exposure]; Add-Row 'Exposure' $cbExp
  $script:nuMax = New-Object System.Windows.Forms.NumericUpDown; $nuMax.Maximum = 10000; $nuMax.Value = [int]$d.maxUsers; $nuMax.Width = 80; Add-Row 'Max active users' $nuMax
  $opts = New-Object System.Windows.Forms.FlowLayoutPanel; $opts.AutoSize = $true
  $script:chkProt = New-Object System.Windows.Forms.CheckBox; $chkProt.Text = 'Invite-only'; $chkProt.Checked = [bool]$d.protected; $chkProt.AutoSize = $true
  $script:chkRestart = New-Object System.Windows.Forms.CheckBox; $chkRestart.Text = 'Auto restart'; $chkRestart.Checked = [bool]$d.autoRestart; $chkRestart.AutoSize = $true
  $script:chkHealth = New-Object System.Windows.Forms.CheckBox; $chkHealth.Text = 'Health check'; $chkHealth.Checked = [bool]$d.healthCheck; $chkHealth.AutoSize = $true
  $script:chkAdv = New-Object System.Windows.Forms.CheckBox; $chkAdv.Text = 'Discovery'; $chkAdv.Checked = [bool]$d.advertise; $chkAdv.AutoSize = $true
  $opts.Controls.AddRange(@($chkProt, $chkRestart, $chkHealth, $chkAdv)); Add-Row 'Options' $opts
  $btns = New-Object System.Windows.Forms.FlowLayoutPanel; $btns.AutoSize = $true; $btns.FlowDirection = 'RightToLeft'; $btns.Dock = 'Right'
  $start = New-Object System.Windows.Forms.Button; $start.Text = 'Start Hosting'; $start.AutoSize = $true
  $cancel = New-Object System.Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.AutoSize = $true
  $start.Add_Click({ Start-Hosting }); $cancel.Add_Click({ Send @{ type = 'cancel' }; $form.Close() })
  $btns.Controls.AddRange(@($start, $cancel)); Add-Full $btns
  $form.AcceptButton = $start; $form.CancelButton = $cancel
}

function Start-Hosting {
  $ifaces = @($script:init.network.interfaces); $net = ''
  if ($cbNet.SelectedIndex -ge 0 -and $ifaces.Count) { $net = $ifaces[$cbNet.SelectedIndex].address }
  $port = $null; if ($cbPort.Text -match '^\d+$') { $port = [int]$cbPort.Text }
  Send @{ type = 'start'; settings = @{ name = $tbName.Text; command = $tbCmd.Text; runtime = [string]$cbRuntime.SelectedItem; port = $port; host = 'Auto'; network = $net
    exposure = @('local', 'lan', 'public')[$cbExp.SelectedIndex]; maxUsers = [int]$nuMax.Value; protected = $chkProt.Checked; autoRestart = $chkRestart.Checked
    healthCheck = $chkHealth.Checked; advertise = $chkAdv.Checked } }
  $script:mode = 'progress'; Clear-View; Add-Full (New-Label 'Starting…' 13 $true); $script:progress = New-Label '' 9; Add-Full $script:progress; $form.AcceptButton = $null
}

function Share-Url { $u = $script:live.urls; if ($u.public) { $u.public } elseif ($u.network) { $u.network } else { $u.local } }

function Show-Live {
  $script:mode = 'live'; Clear-View
  Add-Full (New-Label '● LIVE' 10 $true ([System.Drawing.Color]::SeaGreen))
  Add-Full (New-Label $script:live.name 13 $true)
  $script:tbLink = New-Object System.Windows.Forms.TextBox; $tbLink.ReadOnly = $true; $tbLink.Width = 300; $tbLink.Font = New-Object System.Drawing.Font('Consolas', 10); $tbLink.Text = (Share-Url); Add-Row 'Share link' $tbLink
  $acts = New-Object System.Windows.Forms.FlowLayoutPanel; $acts.AutoSize = $true
  foreach ($pair in @(@('Copy link', { [System.Windows.Forms.Clipboard]::SetText((Share-Url)); Send @{ type = 'action'; action = 'copy' } }), @('QR code', { Send @{ type = 'action'; action = 'qr' } }), @('Open', { Start-Process (Share-Url) }))) {
    $b = New-Object System.Windows.Forms.Button; $b.Text = $pair[0]; $b.AutoSize = $true; $b.Add_Click($pair[1]); $acts.Controls.Add($b) }
  Add-Full $acts
  $script:lblStatus = New-Label $script:live.health; Add-Row 'Status' $lblStatus
  Add-Row 'Port' (New-Label ([string]$script:live.port))
  $script:lblPid = New-Label ([string]$script:live.pid); Add-Row 'PID' $lblPid
  $script:lblUptime = New-Label '00:00:00'; Add-Row 'Uptime' $lblUptime
  $max = if ($script:live.access.maxUsers) { $script:live.access.maxUsers } else { '∞' }
  $script:lblUsers = New-Label ('0 / {0}' -f $max); Add-Row 'Active users' $lblUsers
  $script:lvClients = New-Object System.Windows.Forms.ListView; $lvClients.View = 'Details'; $lvClients.FullRowSelect = $true; $lvClients.Width = 360; $lvClients.Height = 90
  [void]$lvClients.Columns.Add('Address', 160); [void]$lvClients.Columns.Add('Status', 90); [void]$lvClients.Columns.Add('Since', 80); Add-Full $lvClients
  $ctl = New-Object System.Windows.Forms.FlowLayoutPanel; $ctl.AutoSize = $true
  $disc = New-Object System.Windows.Forms.Button; $disc.Text = 'Disconnect'; $disc.AutoSize = $true
  $disc.Add_Click({ if ($lvClients.SelectedItems.Count) { Send @{ type = 'disconnect'; sessionId = $lvClients.SelectedItems[0].Tag; block = $false } } })
  $script:nuLimit = New-Object System.Windows.Forms.NumericUpDown; $nuLimit.Maximum = 10000; $nuLimit.Value = [int]$script:live.access.maxUsers; $nuLimit.Width = 60
  $apply = New-Object System.Windows.Forms.Button; $apply.Text = 'Apply limit'; $apply.AutoSize = $true; $apply.Add_Click({ Send @{ type = 'limit'; maxUsers = [int]$nuLimit.Value } })
  $ctl.Controls.AddRange(@($disc, $nuLimit, $apply)); Add-Full $ctl
  $bottom = New-Object System.Windows.Forms.FlowLayoutPanel; $bottom.AutoSize = $true; $bottom.FlowDirection = 'RightToLeft'; $bottom.Dock = 'Right'
  $stop = New-Object System.Windows.Forms.Button; $stop.Text = 'Stop Hosting'; $stop.AutoSize = $true; $stop.Add_Click({ Send @{ type = 'action'; action = 'stop' } })
  $restart = New-Object System.Windows.Forms.Button; $restart.Text = 'Restart'; $restart.AutoSize = $true; $restart.Add_Click({ Send @{ type = 'action'; action = 'restart' } })
  $bottom.Controls.AddRange(@($stop, $restart)); Add-Full $bottom
}

function Handle($m) {
  switch ($m.type) {
    'init' { $script:init = $m; Show-Config }
    'progress' { if ($script:mode -eq 'progress') { $script:progress.Text = $m.text } }
    'failed' { $script:mode = 'failed'; Clear-View; Add-Full (New-Label "Couldn't start hosting" 13 $true); Add-Full (New-Label $m.message 9 $false ([System.Drawing.Color]::Firebrick)); foreach ($c in @($m.causes)) { if ($c) { Add-Full (New-Label ('• ' + $c)) } } }
    'live' { $script:live = $m; $script:started = (Get-Date).AddMilliseconds( - [double]$m.uptimeMs); Show-Live }
    'status' { if ($script:mode -eq 'live') {
        if ($m.urls) { $script:live.urls = $m.urls; $tbLink.Text = (Share-Url) }
        $lblStatus.Text = $m.health; if ($m.pid) { $lblPid.Text = [string]$m.pid }
        $lim = if ($m.users.limit) { $m.users.limit } else { '∞' }; $lblUsers.Text = ('{0} / {1}' -f $m.users.active, $lim)
        $lvClients.Items.Clear()
        foreach ($c in @($m.clients)) { if ($c) { $it = New-Object System.Windows.Forms.ListViewItem($c.clientAddress); [void]$it.SubItems.Add($c.status.ToUpper()); [void]$it.SubItems.Add(([DateTimeOffset]::FromUnixTimeMilliseconds([long]$c.connectedAt)).LocalDateTime.ToString('HH:mm')); $it.Tag = $c.sessionId; [void]$lvClients.Items.Add($it) } } } }
    'stopped' { $script:mode = 'stopped'; Clear-View; Add-Full (New-Label 'Hosting stopped' 13 $true) }
    'close' { $form.Close() }
  }
}

$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 50
$timer.Add_Tick({
  $line = $null
  while ($queue.TryDequeue([ref]$line)) { try { Handle ($line | ConvertFrom-Json) } catch { } }
  if ($script:mode -eq 'live' -and $script:started) { $span = (Get-Date) - $script:started; $lblUptime.Text = '{0:00}:{1:00}:{2:00}' -f [math]::Floor($span.TotalHours), $span.Minutes, $span.Seconds }
})
$form.Add_Shown({ $form.TopMost = $false; $form.Activate(); Send @{ type = 'ready' } })
$form.Add_FormClosing({ if ($script:mode -eq 'config') { Send @{ type = 'cancel' } } else { Send @{ type = 'closed' } } })
$timer.Start()
Clear-View; Add-Full (New-Label 'Detecting project…')
[void]$form.ShowDialog()

$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class QcFixture {[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);}'
$form=New-Object System.Windows.Forms.Form
$form.Text=$env:QC_FIXTURE_TITLE;$form.Width=600;$form.Height=350;$form.StartPosition='CenterScreen';$form.TopMost=$true
$fixtureText=New-Object System.Windows.Forms.TextBox;$fixtureText.Name='QcInput';$fixtureText.AccessibleName='QC Input';$fixtureText.SetBounds(25,30,420,35)
$button=New-Object System.Windows.Forms.Button;$button.Name='QcCommit';$button.AccessibleName='QC Commit';$button.Text='Apply';$button.SetBounds(25,90,180,40)
$button.Add_Click({@{text=$fixtureText.Text;clicked=$true} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:QC_FIXTURE_RESULT -Encoding UTF8})
$panel=New-Object System.Windows.Forms.Panel;$panel.AccessibleName='QC Canvas';$panel.SetBounds(25,160,430,100);$panel.BackColor=[System.Drawing.Color]::CornflowerBlue
$panel.Add_MouseUp({param($sender,$eventArgs) @{drag_end_x=$eventArgs.X;drag_end_y=$eventArgs.Y} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($env:QC_FIXTURE_RESULT+'.drag') -Encoding UTF8})
$form.Controls.AddRange(@($fixtureText,$button,$panel))
$form.Handle.ToInt64().ToString() | Set-Content -LiteralPath ($env:QC_FIXTURE_RESULT+'.handle')
if($env:QC_FIXTURE_VISIBLE -eq '1'){$form.Show();$null=[QcFixture]::ShowWindow($form.Handle,5);$form.Activate();$fixtureText.Focus()}
[System.Windows.Forms.Application]::Run($form)

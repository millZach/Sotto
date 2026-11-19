# A plain Win32 text box (WinForms) to check the IME sequence works at all, as a control.
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = "IME control"
$f.Width = 700; $f.Height = 240
$t = New-Object System.Windows.Forms.TextBox
$t.Multiline = $true; $t.Dock = 'Fill'; $t.Font = New-Object System.Drawing.Font('Segoe UI', 14)
$f.Controls.Add($t)
$f.Add_Shown({ $t.Focus() })
[System.Windows.Forms.Application]::Run($f)

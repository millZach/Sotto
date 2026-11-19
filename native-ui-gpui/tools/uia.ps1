# Read a window the way Narrator does: through Windows UI Automation.
#   tree:  powershell -File tools/uia.ps1 -Title "Sotto (GPUI)" -Mode tree [-Depth 12] [-Max 400]
#   focus: powershell -File tools/uia.ps1 -Title "Sotto (GPUI)" -Mode focus
#          prints the element that has keyboard focus (role, name, value).
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [ValidateSet('tree', 'focus', 'find')][string]$Mode = 'tree',
    [int]$Depth = 14,
    [int]$Max = 600,
    [string]$Name = ''
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$win = $null
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    if ($w.Current.Name -like "*$Title*") { $win = $w; break }
}
if (-not $win) { Write-Error "No window named like '$Title'"; exit 1 }

function Describe($el) {
    $c = $el.Current
    $type = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $value = ''
    try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) { $value = $vp.Current.Value }
    } catch {}
    $extra = ''
    try {
        $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($ec) { $extra += " expand=" + $ec.Current.ExpandCollapseState }
    } catch {}
    try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($tp) { $extra += " [TextPattern]" }
    } catch {}
    $name = $c.Name
    if ($name.Length -gt 90) { $name = $name.Substring(0, 90) + '...' }
    if ($value.Length -gt 60) { $value = $value.Substring(0, 60) + '...' }
    $v = if ($value) { " value='$value'" } else { '' }
    "$type '$name'$v$extra"
}

if ($Mode -eq 'focus') {
    $f = [System.Windows.Automation.AutomationElement]::FocusedElement
    Describe $f
    exit 0
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:count = 0
function Walk($el, $d) {
    if ($script:count -ge $Max) { return }
    $script:count++
    $line = ('  ' * $d) + (Describe $el)
    if ($Mode -eq 'tree' -or ($Name -and $line -like "*$Name*")) { Write-Output $line }
    if ($d -ge $Depth) { return }
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
        Walk $child ($d + 1)
        $child = $walker.GetNextSibling($child)
    }
}
Walk $win 0

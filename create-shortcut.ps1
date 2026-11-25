$WshShell = New-Object -ComObject WScript.Shell
$CurrentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronExe = Join-Path -Path $CurrentDir -ChildPath "node_modules\electron\dist\electron.exe"

$desktopPaths = @(
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop),
    "C:\Users\MAALIK\OneDrive\Desktop"
) | Select-Object -Unique

foreach ($dp in $desktopPaths) {
    if (Test-Path $dp) {
        $scPath = Join-Path $dp "PocketDesk Remote.lnk"
        $sc = $WshShell.CreateShortcut($scPath)
        $sc.TargetPath = $ElectronExe
        $sc.Arguments = "`"$CurrentDir`""
        $sc.WorkingDirectory = $CurrentDir
        $sc.Description = "PocketDesk Remote - Mobile-to-PC Remote Control"
        if (Test-Path "$CurrentDir\assets\icon.ico") {
            $sc.IconLocation = "$CurrentDir\assets\icon.ico, 0"
        }
        $sc.Save()
        Write-Host "Created shortcut at $scPath"

        $cmdLauncher = Join-Path $dp "Launch PocketDesk.cmd"
        Set-Content -Path $cmdLauncher -Value "@echo off`r`ncd /d `"$CurrentDir`"`r`nstart `"`" `"$ElectronExe`" `"$CurrentDir`"`r`n"
        Write-Host "Created cmd launcher at $cmdLauncher"
    }
}

# Check a Windows desktop build from its bytes: the NSIS installer's ProductVersion and the installed app's
# ProductVersion and CPU architecture (PE machine 0x8664 = x86_64). The NSIS stub itself is 32-bit by design,
# so the architecture is read from the app binary that the installer packs.
# Used by .github/workflows/desktop-build.yml and tested by desktop-publish-test.yml. Exit 1 on any mismatch.
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $App,
  [Parameter(Mandatory)] [string] $Version
)
$ErrorActionPreference = 'Stop'

function Assert-Version([string] $what, [string] $actual) {
  Write-Host "$what ProductVersion '$actual'"
  if ($actual -ne $Version -and $actual -ne "$Version.0") { throw "$what ProductVersion '$actual', expected $Version" }
}
function Get-PeMachine([string] $path) {
  $b = [IO.File]::ReadAllBytes((Resolve-Path $path))
  if ($b.Length -lt 64 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A) { throw "$path is not a PE file" }
  $pe = [BitConverter]::ToInt32($b, 0x3C)
  if ($pe -lt 0 -or $pe + 6 -gt $b.Length -or [BitConverter]::ToUInt32($b, $pe) -ne 0x4550) { throw "$path has no PE header" }
  return [BitConverter]::ToUInt16($b, $pe + 4)
}

Assert-Version 'installer' (Get-Item $Installer).VersionInfo.ProductVersion
Assert-Version 'app' (Get-Item $App).VersionInfo.ProductVersion
$m = Get-PeMachine $App
Write-Host ("app PE machine 0x{0:X4}" -f $m)
if ($m -ne 0x8664) { throw ("app binary is not x86_64 (PE machine 0x{0:X4})" -f $m) }
Write-Host "verified: $Installer is $Version, app is x86_64"

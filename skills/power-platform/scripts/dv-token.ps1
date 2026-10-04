<#
.SYNOPSIS
  A Dataverse bearer token with ONE sign-in: device code the first time, silent after that.

.DESCRIPTION
  Requests offline_access, caches only the refresh token in the user profile (never the repo), and
  saves the rotated refresh token on every use. Later calls are silent until tenant policy expires
  the refresh token (about 90 days in one tenant) or it is revoked. One cache serves every repo that
  targets the same org. first-run.md section 5 and tooling-and-auth.md section 2.

  Print a token (for canvas-app.json "dataverseTokenCommand" or deploy-tables.py --token-cmd):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dv-token.ps1 -OrgUrl https://yourorg.crm.dynamics.com

  Use it from another script:
    . "$PSScriptRoot/dv-token.ps1" -OrgUrl https://yourorg.crm.dynamics.com -NoPrint
    $token = Get-DvToken

  Force a fresh sign-in: add -Reset. Prove it works: -WhoAmI prints your user id.
  The device-code prompt cannot be answered inside an agent's shell: the person runs the first call
  in this session with the ! prefix, or in their own terminal, once.
#>
[CmdletBinding()]
param(
  [string]$OrgUrl = $env:DV_ORG_URL,
  [string]$ClientId = "51f81489-12ee-4a9e-aaae-a2591f45987d",  # first-party public client (Azure CLI)
  [string]$Tenant = "organizations",
  [string]$CachePath,    # default ~/.dv-token-<org>.json; point at an existing cache to keep its sign-in
  [switch]$Reset,
  [switch]$NoPrint,
  [switch]$WhoAmI
)
if (-not $OrgUrl) { throw "Pass -OrgUrl https://<org>.crm.dynamics.com (or set DV_ORG_URL)." }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$OrgUrl = $OrgUrl.TrimEnd('/')
$script:DvCache = if ($CachePath) { $CachePath } else { Join-Path $HOME (".dv-token-" + ([uri]$OrgUrl).Host.Split('.')[0] + ".json") }
$script:DvScope = "$OrgUrl/.default offline_access"
$script:DvTokenUri = "https://login.microsoftonline.com/$Tenant/oauth2/v2.0/token"
$script:DvDeviceUri = "https://login.microsoftonline.com/$Tenant/oauth2/v2.0/devicecode"
$script:DvClientId = $ClientId

function Save-DvCache([string]$RefreshToken) {
  @{ refresh_token = $RefreshToken; saved = (Get-Date).ToString("o") } | ConvertTo-Json |
    Set-Content -Path $script:DvCache -Encoding UTF8
}

function Invoke-DvDeviceCode {
  $dc = Invoke-RestMethod -Method Post -Uri $script:DvDeviceUri -ContentType "application/x-www-form-urlencoded" `
    -Body @{ client_id = $script:DvClientId; scope = $script:DvScope }
  [Console]::Error.WriteLine("`nSIGN IN TO DATAVERSE (once; then silent until the refresh token expires)")
  [Console]::Error.WriteLine("  1. Open $($dc.verification_uri)")
  [Console]::Error.WriteLine("  2. Enter the code $($dc.user_code)`n")
  $interval = [int]$dc.interval
  $deadline = (Get-Date).AddSeconds([int]$dc.expires_in)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    try {
      $t = Invoke-RestMethod -Method Post -Uri $script:DvTokenUri -ContentType "application/x-www-form-urlencoded" `
        -Body @{ grant_type = "urn:ietf:params:oauth:grant-type:device_code"; client_id = $script:DvClientId
                 device_code = $dc.device_code }
      if ($t.refresh_token) { Save-DvCache $t.refresh_token }
      return $t.access_token
    } catch {
      $err = ($_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue).error
      if ($err -eq "authorization_pending") { continue }
      if ($err -eq "slow_down") { $interval += 5; continue }
      throw "Device-code sign-in failed: $err"
    }
  }
  throw "Device-code sign-in timed out."
}

function Get-DvToken {
  if (Test-Path $script:DvCache) {
    try {
      $c = Get-Content $script:DvCache -Raw | ConvertFrom-Json
      $t = Invoke-RestMethod -Method Post -Uri $script:DvTokenUri -ContentType "application/x-www-form-urlencoded" `
        -Body @{ grant_type = "refresh_token"; client_id = $script:DvClientId; scope = $script:DvScope
                 refresh_token = $c.refresh_token }
      if ($t.refresh_token) { Save-DvCache $t.refresh_token }   # rotate: the old one may stop working
      return $t.access_token
    } catch { [Console]::Error.WriteLine("(cached sign-in no longer valid; signing in again)") }
  }
  Invoke-DvDeviceCode
}

if ($Reset -and (Test-Path $script:DvCache)) { Remove-Item $script:DvCache -Force }
if ($WhoAmI) {
  $w = Invoke-RestMethod -Uri "$OrgUrl/api/data/v9.2/WhoAmI" -Headers @{ Authorization = "Bearer $(Get-DvToken)" }
  "UserId $($w.UserId)"
} elseif (-not $NoPrint) {
  Get-DvToken
}

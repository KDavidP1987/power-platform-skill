<#
.SYNOPSIS
  Owner step template: remove named test rows from this app's own tables. Lists by default;
  deletes only with -Apply.

.DESCRIPTION
  Agents never delete Dataverse rows directly. When test data must go, the agent fills in this
  template and hands the person ONE line to run in the session:

    ! powershell -NoProfile -ExecutionPolicy Bypass -File "<absolute path>\Remove-TestData.ps1"          (list)
    ! powershell -NoProfile -ExecutionPolicy Bypass -File "<absolute path>\Remove-TestData.ps1" -Apply   (delete)

  Guards built in:
    - refuses any table whose logical name does not start with $OwnPrefix (shared and reference
      tables are never touched, whatever the filters say);
    - finds rows by explicit filters (reference numbers, a TEST title prefix, a creation day), never
      "everything created by me";
    - resolves entity set names from metadata instead of guessing plurals;
    - deletes children before parents, in the order the plan lists them;
    - prints every row before deleting and the count after.

  Fill in: $OwnPrefix, the token line, and the plan section. Keep configuration rows out of it.
#>
[CmdletBinding()]
param(
  [string]$EnvUrl = "https://yourorg.crm.dynamics.com",
  [switch]$Apply
)
$ErrorActionPreference = "Stop"
$OwnPrefix = "app_"                          # this app's tables only
$Day = "2026-01-01"                          # the day the test rows were created (UTC or local)
$api = "$($EnvUrl.TrimEnd('/'))/api/data/v9.2"
. (Join-Path $PSScriptRoot "dv-token.ps1") -OrgUrl $EnvUrl -NoPrint
$h = @{ Authorization = "Bearer $(Get-DvToken)"; "OData-MaxVersion" = "4.0"; "OData-Version" = "4.0"; Accept = "application/json" }

$sets = @{}
function SetName([string]$logical) {
  if (-not $sets[$logical]) {
    $sets[$logical] = (Invoke-RestMethod -Headers $h -Uri "$api/EntityDefinitions(LogicalName='$logical')?`$select=EntitySetName").EntitySetName
  }
  $sets[$logical]
}
function Rows([string]$logical, [string]$filter, [string]$nameCol = "$($OwnPrefix)name") {
  if ($logical -notlike "$OwnPrefix*") { throw "Refusing to touch $($logical): only $OwnPrefix tables." }
  $u = "$api/$(SetName $logical)?`$select=$($logical)id,$nameCol,createdon&`$filter=$([uri]::EscapeDataString($filter))"
  @((Invoke-RestMethod -Headers $h -Uri $u).value) | ForEach-Object {
    [pscustomobject]@{ id = $_."$($logical)id"; name = $_.$nameCol; created = $_.createdon }
  }
}
function OnDay($r) { ([datetime]$r.created).ToUniversalTime().ToString("yyyy-MM-dd") -eq $Day -or
                     ([datetime]$r.created).ToString("yyyy-MM-dd") -eq $Day }

$plan = [ordered]@{}   # logical name -> rows, CHILDREN FIRST
function Add([string]$logical, $rows) {
  if (-not $plan.Contains($logical)) { $plan[$logical] = @() }
  foreach ($r in @($rows)) { if ($r -and -not ($plan[$logical] | Where-Object { $_.id -eq $r.id })) { $plan[$logical] += $r } }
}

# ---- The plan: edit this section. Children before parents. ----------------------------------
$orders = @(Rows "app_order" "startswith(app_name,'TEST')")
foreach ($o in $orders) { Add "app_orderline" (Rows "app_orderline" "_app_order_value eq $($o.id)") }
Add "app_order" $orders
Add "app_vendor" (Rows "app_vendor" "app_name eq 'TEST vendor'" | Where-Object { OnDay $_ })
# ----------------------------------------------------------------------------------------------

$total = 0
foreach ($k in $plan.Keys) {
  if ($plan[$k].Count -eq 0) { continue }
  Write-Host "`n$k ($($plan[$k].Count))" -ForegroundColor Cyan
  foreach ($r in $plan[$k]) { Write-Host "  $($r.name)  [$($r.id)]  created $($r.created)"; $total++ }
}
Write-Host "`n$total row(s) listed." -ForegroundColor Yellow
if (-not $Apply) { Write-Host "Nothing deleted. Run again with -Apply to delete these rows."; return }

foreach ($k in $plan.Keys) {
  foreach ($r in $plan[$k]) {
    Invoke-RestMethod -Headers $h -Method Delete -Uri "$api/$(SetName $k)($($r.id))" | Out-Null
    Write-Host "  deleted $k $($r.name)"
  }
}
Write-Host "`n$total row(s) deleted." -ForegroundColor Green

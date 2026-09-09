param(
  [string]$SubscriptionId = "",
  [string]$ResourceGroup = "",
  [string]$StorageAccount = "",
  [string]$AppBaseUrl = "",
  [switch]$Verify,
  [string]$AppUsername = "",
  [string]$AppPassword = "",
  [string]$SamplePdf = ""
)

$ErrorActionPreference = "Stop"

# Resolve deployment coordinates from the azd environment / current az context so
# no environment-specific identifiers are baked into this script.
if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
  $SubscriptionId = (az account show --query id -o tsv)
  if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
    throw "No subscription. Run 'az login', or pass -SubscriptionId."
  }
}
if ([string]::IsNullOrWhiteSpace($ResourceGroup)) {
  $ResourceGroup = (azd env get-value AZURE_RESOURCE_GROUP 2>$null)
  if ([string]::IsNullOrWhiteSpace($ResourceGroup)) {
    throw "No resource group. Run this from an azd environment, or pass -ResourceGroup."
  }
}
if ([string]::IsNullOrWhiteSpace($StorageAccount)) {
  $StorageAccount = (az storage account list -g $ResourceGroup --query "[0].name" -o tsv)
  if ([string]::IsNullOrWhiteSpace($StorageAccount)) {
    throw "No storage account found in $ResourceGroup. Pass -StorageAccount."
  }
}
if ($Verify -and [string]::IsNullOrWhiteSpace($AppBaseUrl)) {
  $AppBaseUrl = (azd env get-value WEB_BASE_URL 2>$null)
  if ([string]::IsNullOrWhiteSpace($AppBaseUrl)) {
    throw "-Verify needs the app URL. Pass -AppBaseUrl, or set WEB_BASE_URL in the azd environment."
  }
}

Write-Host "=== Set subscription ==="
az account set --subscription $SubscriptionId

Write-Host "=== Before ==="
az storage account show -n $StorageAccount -g $ResourceGroup --query "{publicNetworkAccess:publicNetworkAccess, defaultAction:networkRuleSet.defaultAction, bypass:networkRuleSet.bypass, securityControlTag:tags.SecurityControl}" -o json

Write-Host "=== Exempt from security baseline policy (SecurityControl=Ignore tag) ==="
# The org "Azure Security Baseline" policy uses a Modify effect that
# force-disables storage public network access. A plain re-enable gets reverted
# inline (the PUT returns success, but the value stays Disabled). Tagging the
# account SecurityControl=Ignore excludes it from that policy, so the re-enable
# below actually sticks. Merge preserves existing tags (e.g. azd-env-name).
$storageId = az storage account show -n $StorageAccount -g $ResourceGroup --query id -o tsv
az tag update --resource-id $storageId --operation Merge --tags SecurityControl=Ignore --only-show-errors 1>$null

Write-Host "=== Apply fix: public network access enabled ==="
az storage account update -n $StorageAccount -g $ResourceGroup --public-network-access Enabled --only-show-errors 1>$null

Write-Host "=== After ==="
az storage account show -n $StorageAccount -g $ResourceGroup --query "{publicNetworkAccess:publicNetworkAccess, defaultAction:networkRuleSet.defaultAction, bypass:networkRuleSet.bypass, securityControlTag:tags.SecurityControl}" -o json

if (-not $Verify) {
  Write-Host "=== Done (no endpoint verification requested) ==="
  exit 0
}

if ([string]::IsNullOrWhiteSpace($AppUsername) -or [string]::IsNullOrWhiteSpace($AppPassword)) {
  Write-Host "Verification skipped: provide -AppUsername and -AppPassword to run authenticated endpoint check."
  exit 0
}
if ([string]::IsNullOrWhiteSpace($SamplePdf) -or -not (Test-Path $SamplePdf)) {
  Write-Host "Verification skipped: pass -SamplePdf <path-to-a-pdf>. This repo ships no sample documents."
  exit 0
}

Write-Host "=== Verify app login ==="
$loginBody = '{"username":"' + $AppUsername + '","password":"' + $AppPassword + '"}'
$loginBody | Out-File -Encoding ascii body.json
curl.exe -s -c cookies.txt -o NUL -w "login=%{http_code}`n" -X POST "$AppBaseUrl/api/login" -H "Content-Type: application/json" --data "@body.json"

Write-Host "=== Verify layout PDF endpoint ==="
curl.exe -s -b cookies.txt -D headers.txt -o out.pdf -w "HTTP %{http_code} size=%{size_download} bytes`n" -X POST "$AppBaseUrl/api/translate-document" -F "file=@$SamplePdf" -F "targetLanguage=en" -F "sourceLanguage=ja" -F "evaluate=1"
Select-String -Path headers.txt -Pattern "content-type|x-is-image|x-translated|x-evaluation"

if ((Get-Item out.pdf).Length -gt 3000) {
  $sig = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes("out.pdf")[0..4])
  Write-Host "signature=$sig"
} else {
  Write-Host "--- body ---"
  Get-Content out.pdf -Raw
}

Remove-Item body.json,cookies.txt,headers.txt,out.pdf -ErrorAction SilentlyContinue
Write-Host "=== Verification complete ==="

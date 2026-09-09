---
name: restore-layout-pdf-access
description: Re-enable Azure Storage public network access for the demo by applying the SecurityControl=Ignore policy-exemption tag, and optionally verify the authenticated layout-PDF translation endpoint.
---

Use this skill when the demo starts failing layout-preserving PDF translation with storage access errors and you need to quickly apply the known fix.

## What this does
- Sets the target subscription.
- Tags the storage account `SecurityControl=Ignore` (merged, preserving existing tags) to exempt it from the org security baseline policy.
- Enables storage account public network access — which now sticks, because the tag exempts the account from the policy that otherwise force-disables it.
- Prints before/after network state (including the exemption tag).
- Optionally performs an authenticated endpoint smoke test for layout PDF translation.

## Command
Run from the repository root:

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-layout-pdf-access.ps1

Optional endpoint verification:

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-layout-pdf-access.ps1 -Verify -AppUsername "<username>" -AppPassword "<password>"

## Optional overrides
-SubscriptionId
-ResourceGroup
-StorageAccount
-AppBaseUrl
-SamplePdf   (path to a PDF for the -Verify smoke test; none ships with this repo)

## Notes
- This is a tactical recovery for **demo continuity**, not a production pattern.
- **The tag exemption is opt-in and OFF by default.** In IaC, set
  `exemptStorageFromSecurityBaseline=true` (`infra/main.bicep`) to persist it
  across `azd up`; this script applies it to a live resource that has drifted.
- Applicability is tenant-specific: it only helps if your organization runs a
  policy with a Modify effect that force-disables storage public network access
  **and** honours a `SecurityControl: Ignore` tag. Many tenants do neither.
- **Understand what you are trading away.** Enabling public network access on the
  storage account widens its exposure. Only do this for a short-lived demo, in a
  non-production subscription, with no real data in the account.
- **Preferred durable fix:** private endpoint + VNet integration for the Container
  App, so the batch path reaches Blob Storage without public network access. Use
  the tag only if you cannot do that in time for a demo.
- Check your own organization's policy before applying an exemption — bypassing a
  security baseline may violate your internal compliance requirements.

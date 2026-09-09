# Azure Bill of Materials - Production (100 documents / month)

Companion cost estimate for [WHATS-NEXT.md](WHATS-NEXT.md) Section 3.4. Built on the public
Azure Pricing Calculator (<https://azure.microsoft.com/en-us/pricing/calculator/>).

| | |
| --- | --- |
| **Estimate date** | 2026-07-08 |
| **Scenario** | Production application-landing-zone spoke, **100 documents / month** |
| **Region** | Southeast Asia (per module) |
| **Currency** | USD |
| **Term** | Pay-as-you-go (PAYG) |
| **Total estimated monthly cost** | **USD 37.48** |
| **Annualised** | **~USD 449.76** |
| **Pricing calculator share link** | https://azure.com/e/95a3d929bc124a869ad3d11942fe548d |

![Populated Azure Pricing Calculator estimate](azure-bom-100docs.png)

> Prices are retail estimates from the Azure Pricing Calculator and vary by agreement,
> currency and date. This models the **Preserve-layout (image-off)** flagship path; the
> AI meter is the dominant, volume-linear driver.

---

## Volumetric Assumptions

Inputs that drive each line item, for **100 documents / month**:

- **Representative document:** ~2 MB, ~15 pages, ~15,000 source characters (~1,000 chars/page,
  the measured density of the evaluation corpus in [EVALUATION.md](EVALUATION.md)).
- **Monthly volume:** 100 documents -> ~1,500 pages -> **~1,500,000 document characters**.
- **Translation path modeled:** Preserve-layout, **image-text OFF** (Standard Document
  Translation, 1.5M characters). Text-view mode (Document Intelligence OCR + Translator Text)
  is a slightly cheaper alternative and is **not** double-counted here.
- **Target language:** one per document (extra languages multiply only translation characters).
- **Container Apps:** web + worker on the Consumption plan, 0.5 vCPU / 1 GiB. At this volume the
  active usage (~0.05M requests/mo plus batch processing) sits **within the free monthly grant**
  (180,000 vCPU-s + 360,000 GiB-s + 2M requests), so compute rounds to $0. A **warm min-1
  replica** to remove cold starts would add **~USD 13/month** (idle rate) that the Consumption
  calculator does not itemize - treated as an optional adder below.
- **Private endpoints:** 2 (Azure AI + Storage blob), 730 hours each, ~2 GB in / ~2 GB out.
- **Storage:** ~10 GB (working blobs auto-deleted after 1 day, plus the Table durable store for
  job status / shared history); ~10,000 operations per category.
- **Azure Monitor / Log Analytics:** ~0.1 GB/day (~3 GB/month) Analytics Logs - **within the
  5 GB/month free Pay-As-You-Go allowance**, so it rounds to $0.
- **Key Vault:** Standard, ~100,000 operations/month (secret reads).
- **Platform-shared, billed to the platform landing zone (excluded here):** hub Azure Firewall,
  Private DNS zones, shared Container Registry (AcrPull), connectivity. **No charge / excluded:**
  spoke VNet, managed identity, Container Apps environment. **Optional / excluded:** Azure Front
  Door + WAF (only if the app is exposed publicly; the target is internal-only).

---

## Bill of Materials

| # | Service | Configuration | Region | Monthly (USD) |
| --- | --- | --- | --- | ---: |
| 1 | **Azure Container Apps** | Consumption; 0.5 vCPU / 1 GiB; web + worker; ~0.05M requests/mo; active usage within free grant | Southeast Asia | **0.00** |
| 2 | **Azure AI Translator** (Foundry Tools) | S1; Standard Document Translation; **1,500,000** document characters/mo | Southeast Asia | **22.50** |
| 3 | **Azure Private Link** | 2 private endpoints x 730 h; 2 GB outbound + 2 GB inbound data processed | Southeast Asia | **14.64** |
| 4 | **Storage Accounts** | Block Blob, GP v2, LRS, Hot; 10 GB; ~10k ops/category; 1-day lifecycle; also Table durable store | Southeast Asia | **0.31** |
| 5 | **Azure Monitor** (Log Analytics / App Insights) | Analytics Logs ~0.1 GB/day (~3 GB/mo); within 5 GB free tier | Southeast Asia | **0.00** |
| 6 | **Azure Key Vault** | Standard; ~100,000 operations/mo | Southeast Asia | **0.03** |
| | | | **Total** | **37.48** |

**Optional adder (not in total):** Container Apps **warm min-1 replica** (no cold start)
~**USD 13/month** -> production-with-warm-replica total ~**USD 50/month**.

---

## Cost drivers

| Rank | Line item | Monthly | % of total | Notes / optimisation |
| --- | --- | ---: | ---: | --- |
| 1 | Azure AI Translator (Document Translation) | $22.50 | **60.0%** | The only volume-linear meter. Levers: keep **image-text OFF** for born-digital docs; use **Text view** (OCR + text translate) for cheaper reading; evaluate **commitment tiers** at sustained high volume. |
| 2 | Azure Private Link (2 endpoints) | $14.64 | **39.1%** | Fixed cost of private networking (AI + Storage). Data processing at this volume is ~$0.04. Not reducible without giving up private endpoints. |
| 3 | Storage Accounts | $0.31 | 0.8% | Already minimal (1-day lifecycle auto-deletes working blobs). |
| 4 | Key Vault | $0.03 | 0.1% | Negligible. |
| 5 | Container Apps + Azure Monitor | $0.00 | 0.0% | Within Azure free monthly grants at 100 docs/mo. Add ~$13 for a warm replica if cold starts are unacceptable. |

**Reconciliation with [WHATS-NEXT.md](WHATS-NEXT.md) Section 3.4:** the doc estimated ~USD 58/mo
TCO (layout image-off) at 100 docs = ~$35 fixed + ~$23 variable. The calculator confirms the
**variable AI cost (~$22.50 vs ~$23)** and shows the **fixed infrastructure is leaner than the
conservative estimate at this low volume**, because Container Apps compute and Log Analytics
ingestion fall within Azure's free monthly grants. Adding the optional warm replica (~$13) brings
the total to ~**USD 50/mo**; the pure scale-to-zero configuration is **USD 37.48/mo**.

---

## Changelog

### 2026-07-08 - Initial estimate (production, 100 docs/month)

| # | Change | Before | After | Δ | Why |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Add Azure AI Translator - Document Translation, 1.5M chars (S1) | — | $22.50 | +$22.50 | Variable AI cost for 100 docs x 15k chars, layout image-off path (WHATS-NEXT.md §3.4) |
| 2 | Add Azure Private Link - 2 private endpoints + minimal data | — | $14.64 | +$14.64 | Private endpoints for AI + Storage (permanent fix for the storage public-access policy issue) |
| 3 | Add Storage Accounts - Blob GP v2 LRS Hot, 10 GB + Table durable store | — | $0.31 | +$0.31 | Working blobs (1-day lifecycle) + shared job/history state |
| 4 | Add Azure Key Vault - ~100k operations | — | $0.03 | +$0.03 | Secret storage for the app (managed identity) |
| 5 | Add Azure Container Apps - Consumption 0.5 vCPU/1 GiB | — | $0.00 | +$0.00 | Within free monthly grant at 100 docs/mo (scale-to-zero) |
| 6 | Add Azure Monitor - Log Analytics ~3 GB/mo | — | $0.00 | +$0.00 | Within 5 GB/mo free Pay-As-You-Go allowance |
| | **Net total** | — | **$37.48/mo** | **+$37.48** | Production scale-to-zero baseline, 100 docs/mo |

**Decisions documented during this pass**
- Modeled the **Preserve-layout (image-off)** flagship path only (Document Translation 1.5M chars);
  did not add a separate Document Intelligence line to avoid double-counting (Text-view mode is a
  cheaper alternative, noted for reference).
- **Container Apps** active usage falls within the free grant at 100 docs/mo -> $0; the production
  **warm min-1 replica (~$13/mo)** is called out as an optional adder rather than forced through the
  Consumption calculator (which bills active usage only, not idle).
- **Durable store** modeled as **Table Storage** (folded into the Storage Accounts line); Azure Cosmos
  DB serverless is the alternative if richer querying is needed (~$1-5/mo at this volume).
- **Shared platform ACR** reused via AcrPull (platform-billed) - no Premium registry cost on this workload.
- **Front Door + WAF excluded** - the target is an internal-only ALZ spoke.

---

## Reproducing this estimate

1. Open the **Azure Pricing Calculator**: <https://azure.microsoft.com/en-us/pricing/calculator/>
   (Currency: **USD**; set each module's Region to **Southeast Asia**; term **PAYG**).
2. Add and configure these products:
   - **Azure Container Apps** - Consumption; vCPU **0.5**, Memory **1 GiB**; requests ~**0.05** (x1M).
   - **Foundry Tools** -> API **Azure Translator in Foundry Tools**; Instance **S1**; set
     **Standard Document Translation = 1.5** (x1M document characters).
   - **Azure Private Link** - **Endpoints = 2** x 730 hours; Outbound **2 GB**, Inbound **2 GB**.
   - **Storage Accounts** - Block Blob, GP v2, LRS, Hot; Capacity **10 GB**; Write/List/Read ops **1**
     (x10,000) each.
   - **Azure Monitor** - expand **Log Data Ingestion**; **Analytics Logs = 0.1** GB/day.
   - **Key Vault** - Operations **10** (x10,000).
3. Confirm the **Estimated monthly cost = ~USD 37.48**.
4. To finalise: click **Log in** (top-right of the estimate panel) and sign in with your Microsoft
   account; then **Save estimate** (name it), **Export** for Excel/CSV, and/or **Share Estimate**
   for a link. Paste the share link into the header above.

> The Save / Export / Share buttons are disabled until you sign in - that step is yours to complete.

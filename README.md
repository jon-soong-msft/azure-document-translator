# Azure Document Translator

A Next.js web app that lets you **upload a document (PDF, Word, images, etc.) and translate it with Azure AI**, then shows the original and translated versions **side by side**. It offers two modes:

| Mode | What it does | Azure service |
| ---- | ------------ | ------------- |
| **Text view** | Runs OCR to extract text, translates it, shows before/after **text** | **Document Intelligence** (`prebuilt-read`) + **Translator** (Text v3.0) |
| **Preserve layout** | Translates the whole file **keeping tables, formatting & layout**; for images, renders the translation **back onto the picture** (like the Google Translate camera) | **Translator → Document Translation** (sync) + **Document Intelligence** for PDF |

![Before & after layout](https://learn.microsoft.com/azure/ai-services/translator/media/translator-overview.png)

---

## Features

- Drag-and-drop or browse to upload a document
- **Two modes** — switch with the toggle at the top:
  - **Text view**: OCR + side-by-side translated text. Supports PDF, DOCX, XLSX, PPTX, PNG, JPG, TIFF, BMP, HEIF, HTML.
  - **Preserve layout**: layout-faithful document translation with inline before/after preview and downloads. Supports PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, ODT/ODP/ODS, HTML, TXT, CSV, TSV, RTF, MD, XLF, and images (PNG/JPG/BMP/WebP rendered in place).
- Automatic source-language detection
- Pick from 30+ target languages
- Clean, responsive **before / after** comparison view
- No database, no storage — files are processed in-memory and discarded

---

## 1. Prerequisites

- **Node.js 18.18+** (works on Node 20 / 22 / 24)
- An **Azure subscription** with Document Intelligence + Translator capability.
  A single **multi-service Cognitive Services** (a.k.a. Azure AI Services)
  resource covers both; or use two single-service resources.

This app supports **two authentication modes** — pick one:

| Mode | When to use | What you provide |
| ---- | ----------- | ---------------- |
| **A. Microsoft Entra ID (keyless)** — recommended | Your resource has keys disabled (`disableLocalAuth = true`), or you prefer keyless | Endpoint, region, Translator resource ID, plus the **Cognitive Services User** role and `az login` |
| **B. Resource key** | Simple local testing with keys enabled | Endpoint, region, and the resource key(s) |

### Option A — Microsoft Entra ID (keyless)

1. Sign in once so `DefaultAzureCredential` can get tokens:
   ```powershell
   az login
   ```
2. Grant yourself (or your app's managed identity) the **Cognitive Services User**
   role on the resource:
   ```powershell
   az role assignment create `
     --assignee <your-user-or-identity-object-id> `
     --role "Cognitive Services User" `
     --scope <resource-id>
   ```
3. Collect: the resource **endpoint**, its **region**, and its full **resource ID**
   (`/subscriptions/.../providers/Microsoft.CognitiveServices/accounts/<name>`).
   Leave the `*_KEY` variables unset.

### Option B — Resource key

1. In the [Azure portal](https://portal.azure.com), open your resource's
   **Keys and Endpoint** page.
2. Copy **Key 1**, the **Endpoint**, and the **Region**.

---

## 2. Configure environment variables

Copy the example file and fill in the values for your chosen mode:

```powershell
Copy-Item .env.example .env.local
```

**Option A — keyless (Entra ID):**

```ini
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com/

AZURE_TRANSLATOR_REGION=<your-region>
AZURE_TRANSLATOR_RESOURCE_ID=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<name>
AZURE_TRANSLATOR_ENDPOINT=https://api.cognitive.microsofttranslator.com
# No keys — DefaultAzureCredential uses your az login session.
```

**Option B — resource key:**

```ini
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com/
AZURE_DOCUMENT_INTELLIGENCE_KEY=<your-key>

AZURE_TRANSLATOR_KEY=<your-key>
AZURE_TRANSLATOR_REGION=<your-region>
AZURE_TRANSLATOR_ENDPOINT=https://api.cognitive.microsofttranslator.com
```

> `.env.local` is git-ignored, so your config stays local. In keyless mode there
> are **no Azure secrets** in the file at all.

### Sign-in gate (required)

The app is protected by a username/password gate. There are **no default
credentials** — the app fails to start until you set all three:

```ini
APP_USERNAME=<choose-a-username>
APP_PASSWORD=<choose-a-strong-password>
# Must be >= 32 chars of high-entropy random data. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
AUTH_SECRET=<random-string-used-to-sign-the-session-cookie>
```

> `AUTH_SECRET` signs session cookies and job tokens. Never derive it from
> predictable values (subscription id, environment name, etc.) — anyone who can
> guess the inputs can forge a valid session.

The app decides the mode per service automatically: if a `*_KEY` is present it
uses the key; otherwise it falls back to Microsoft Entra ID.

---

## 3. Install & run

```powershell
npm install
npm run dev
```

Open <http://localhost:3000>, upload a document, choose a target language, and click **Translate document**.

To run a production build:

```powershell
npm run build
npm start
```

---

## Deploy to Azure with `azd`

This repo is a ready-to-deploy [Azure Developer CLI](https://aka.ms/azd) project.
A single command provisions **a brand-new resource group with all required
resources** and deploys the app to **Azure Container Apps**:

```powershell
azd auth login

# The sign-in gate has no defaults - set these before provisioning.
azd env set APP_USERNAME "<choose-a-username>"
azd env set APP_PASSWORD "<choose-a-strong-password>"
azd env set AUTH_SECRET "$([Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 })))"

azd up
```

You'll be prompted for an environment name, subscription, and region
(e.g. `southeastasia`). `azd up` then:

1. Creates a resource group `rg-<env>` containing:
   - **Azure AI Services** (multi-service: OCR + Translator), keyless (Entra ID) only
   - **Storage account** with `source`/`target` containers for batch PDF translation
   - **Container Registry**, **Container Apps Environment** + **Container App**
   - **Log Analytics**, and a **user-assigned managed identity**
2. Assigns least-privilege roles (Cognitive Services User, Storage Blob Data
   Contributor, AcrPull) to the app identity, and grants the Translator's own
   identity blob access so it can perform batch PDF jobs.
3. Builds the Docker image, pushes it to the registry, and deploys the app.
4. Prints the public app URL.

Everything is wired via environment variables on the Container App — **no secrets**,
keyless end to end. Tear it all down with `azd down`.

The infrastructure lives in [`infra/`](infra/) (`main.bicep` + `resources.bicep`)
and the container build in [`Dockerfile`](Dockerfile).

> **Layout-preserving PDF:** because `azd` provisions Blob Storage and wires the
> Translator identity, the deployed app can translate **PDFs while preserving
> layout** (via Azure's asynchronous batch API). Running locally, PDFs use Text
> view unless you also set the `AZURE_STORAGE_*` variables (see `.env.example`).

---

## How it works

```
 Browser (upload + mode)
      │  multipart/form-data
      ├─► Text view ──► /api/translate
      │      1. POST bytes → Document Intelligence prebuilt-read → OCR text
      │      2. POST text  → Translator v3.0 /translate          → translated text
      │      ◄ JSON { original, translated, detectedLanguage } → before/after text
      │
      └─► Preserve layout ──► /api/translate-document
             POST file → Translator Document Translation (sync, on the resource
             endpoint /translator/document:translate) → translated file bytes
             • Documents (PDF/DOCX/PPTX/XLSX/HTML…) keep layout & tables
             • Images (PNG/JPG/BMP/WebP) get text rendered back in place
             ◄ translated file → inline before/after preview + downloads
```

Key files:

| File | Purpose |
| ---- | ------- |
| `src/lib/azure.ts` | Server-side calls: OCR, text translation, and document/image translation |
| `src/app/api/translate/route.ts` | Text-view handler (OCR + text translation) |
| `src/app/api/translate-document/route.ts` | Preserve-layout handler (document/image translation) |
| `src/app/page.tsx` | Upload UI, mode toggle, before/after comparison |
| `src/components/DocumentPane.tsx` | Reusable text pane (text view) |
| `src/components/DocumentPreview.tsx` | Inline file preview + download (preserve layout) |
| `src/lib/languages.ts` | Supported target languages |

---

## Notes & limits

- Max upload size is **20 MB** (configurable in the route handlers).
- **Text view** extracts **plain text** (reading order preserved); it does not
  re-create the document's visual layout — use **Preserve layout** for that.
- **Preserve layout** uses the synchronous Document Translation endpoint on your
  resource's custom domain. Native/digital PDFs give the best fidelity; scanned
  PDFs translate via OCR and keep layout best-effort. Translated text length can
  differ from the source, so some reflow is normal.
- Standalone **image** translation (text rendered back onto the picture) uses the
  newer Document Translation API version and is rendered server-side.
- **Text inside embedded images is translated in Preserve layout mode.** The batch
  PDF path uses Document Translation API `2026-03-01` with `translateTextWithinImage`,
  so text baked into charts, figures, screenshots and stamps is OCR'd and re-rendered
  in the target language (measured ~100 % coverage, up from ~90 % on image-heavy PDFs).
  The trade-off is a larger output file and slightly higher cost — see
  [docs/EVALUATION.md](docs/EVALUATION.md).
- Inline preview in the browser works for PDF, images, and HTML/text. Office
  formats (DOCX/PPTX/XLSX) are offered as **downloads** (browsers can't render
  them inline) with full formatting preserved.
- Document Intelligence `prebuilt-read` supports printed and handwritten text in
  [many languages](https://learn.microsoft.com/azure/ai-services/document-intelligence/language-support/ocr).
- Translator supports [100+ languages](https://learn.microsoft.com/azure/ai-services/translator/language-support);
  this demo lists a popular subset in `src/lib/languages.ts`.

---

## Documentation

- [docs/EVALUATION.md](docs/EVALUATION.md) — translation-accuracy evaluation
  (Japanese → English), the image-text translation result
  (now ~100 % coverage in Preserve layout), and the **per-document Azure cost** breakdown.
  The source PDFs are not redistributed here; point the scripts at your own documents.
- [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) — the Azure infrastructure the
  app needs (components, RBAC, security posture, standing monthly cost).
- [scripts/evaluate.mjs](scripts/evaluate.mjs) — reproducible evaluation script
  (writes [docs/evaluation-results.json](docs/evaluation-results.json)).

---

## Security

- Azure keys are only read **server-side** from environment variables and are
  never exposed to the browser.
- Uploaded files are processed in memory and are not persisted.

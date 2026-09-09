# AGENTS.md

Guidance for AI coding agents working in this repository.

## Workflow rules

### Always test locally before deploying to Azure

After completing any feature development or change, **stop and let me test locally first**. Do **not** deploy to Azure (`azd up`, `azd deploy`, etc.) until I have verified the change locally and explicitly approved deployment.

1. Implement the change.
2. Run/serve it locally for me to verify:
   - `npm run dev` (requires `az login` for keyless Azure auth).
3. **Wait for my confirmation** that local testing passed.
4. Only then proceed to deploy (`azd up` / `azd deploy web`) — and only when I ask.

Never deploy as part of finishing a feature unless I have explicitly said to deploy.

## Project quick reference

- Next.js app: upload doc → Azure Document Intelligence OCR → Azure Translator → before/after view.
- Local dev: `npm run dev`
- Deploy: `azd up` (full) or `azd deploy web` (app only). Teardown: `azd down`.
- Keyless Microsoft Entra ID auth (`DefaultAzureCredential`); local runs need `az login`.
- See `docs/INFRASTRUCTURE.md` and `docs/EVALUATION.md` for infra and accuracy details.

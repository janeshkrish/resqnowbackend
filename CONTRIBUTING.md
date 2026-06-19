# Contributing Guidelines

This is a proprietary private project. Contributions are accepted only from authorized collaborators with explicit permission from the owner.

## Access Rules

- Do not fork, clone, download, mirror, redistribute, or reuse this repository unless the owner has explicitly authorized it.
- Do not share repository access, source code, credentials, operational data, database exports, or internal documentation with third parties.
- Do not use this codebase for external commercial work, derivative products, client projects, training material, or public examples without written permission.

## Development Workflow

1. Create a branch from the protected base branch.
2. Use a clear branch name, for example `feature/dispatch-worker-retry` or `fix/payment-webhook-signature`.
3. Keep pull requests focused and small enough to review.
4. Include validation notes in the pull request.
5. Include migration notes for database changes.
6. Request review from the CODEOWNERS.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Use PowerShell on Windows:

```powershell
Copy-Item .env.example .env
npm run dev
```

Never commit the `.env` file.

## Required Checks

Run these checks before opening or merging a pull request:

```bash
npm run build
npm run test:technician-pricing
npm run test:towing-phase2
npm audit
```

If a check cannot be run, document the reason in the pull request.

## Code Standards

- Follow existing Express route, controller, service, and repository patterns.
- Keep authentication and authorization checks explicit.
- Validate and normalize external input before using it in database, payment, dispatch, notification, or provider calls.
- Keep database schema changes documented and reversible where practical.
- Add tests for pricing, payment, dispatch, auth, and service request lifecycle changes.
- Keep runtime uploads, logs, APK files, debug artifacts, and local data out of commits unless explicitly approved by the owner.
- Update README and `.env.example` when environment variables, scripts, endpoints, deployment steps, or worker requirements change.

## Security

- Report vulnerabilities privately according to `SECURITY.md`.
- Do not run destructive tests against production.
- Do not commit secrets, credentials, database exports, signing keys, private certificates, runtime uploads, or real customer data.
- Rotate any credential that is accidentally committed or shared.

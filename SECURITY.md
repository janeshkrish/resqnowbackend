# Security Policy

## Supported Versions

This is a private proprietary project. Only the active production branch and current release candidates are supported for security review.

## Reporting a Vulnerability

Do not open public GitHub issues for security vulnerabilities.

Report suspected vulnerabilities privately to the repository owner or authorized maintainer:

- GitHub: `@janeshkrish`
- Project: ResQNow

Include:

- A clear description of the issue.
- Affected route, controller, service, worker, database table, dependency, or configuration.
- Steps to reproduce in a non-production environment.
- Potential impact.
- Suggested remediation, if known.

## Security Rules

- Do not test against production systems without written authorization.
- Do not access, copy, modify, export, or delete real user, technician, payment, or operational data.
- Do not run destructive tests, denial-of-service tests, credential stuffing, spam, scraping, or social engineering.
- Do not disclose vulnerabilities publicly until the owner confirms remediation and disclosure approval.
- Do not commit secrets, `.env` files, tokens, private keys, certificates, production credentials, debug logs, database dumps, APK signing materials, runtime uploads, or customer data.

## Secret Handling

- Backend secrets must be stored only in environment variables or deployment secret managers.
- Rotate any credential that is committed, logged, shared publicly, or packaged in an artifact.
- Restrict public Google, Firebase, and Razorpay keys by domain, package name, SHA certificate fingerprint, and API scope where supported.
- Keep Razorpay secrets, JWT secrets, database passwords, SMTP credentials, Redis credentials, and Firebase Admin private keys out of source control.

## Maintainer Checklist

- Enable GitHub secret scanning and push protection.
- Enable Dependabot alerts and security updates.
- Protect the default branch.
- Require pull requests and CODEOWNERS review.
- Require signed commits for protected branches.
- Review dependency audit results before production release.
- Remove generated artifacts and runtime uploads from git history where feasible.

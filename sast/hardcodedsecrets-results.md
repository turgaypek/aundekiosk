# Hardcoded Secrets Analysis Results: AundeKiosk

## Executive Summary
- Candidates analyzed: 0
- Vulnerable: 0
- Likely Vulnerable: 0
- Not Vulnerable: 0
- Needs Manual Review: 0

No vulnerabilities found.

## Notes

AundeKiosk has no external API integrations (no AWS, Stripe, Google, Slack, etc.) and all authentication credentials are stored at runtime in `/opt/aundekiosk/auth.db` (a root-owned JSON file on the Pi). The codebase contains no API keys, private keys, or service credentials in any form.

All string literals matching `password`/`secret` variable names in the codebase are in test files (`*_test.ts`, `recovery/server_test.ts`) and use obvious placeholder values (`"a-long-enough-password"`, `"the-old-password"`, etc.) that are not real credentials.

The dashboard is a server-side Deno application. There are no client-bundled JavaScript files that could expose server secrets to browser inspection.

# Cloudflare Pages version identity

The Pages `nanoflow` project uses `npm run build:strict`. Production and preview deployments must set these non-secret identity values in the Cloudflare Pages build environment:

| Variable | Production | Preview |
|---|---|---|
| `NG_APP_SENTRY_ENVIRONMENT` | `production` | `preview` |
| `NG_APP_DEPLOYMENT_TARGET` | `production` | `preview` |
| `NG_APP_SUPABASE_PROJECT_ALIAS` | `production` | `preview` |

The executable contract is `scripts/cloudflare-pages-version-identity-contract.json`. `build:strict` fails before the Angular build when a production identity is missing or falls back to `local`/`development`.

The generic `scripts/generate-version-json.cjs` remains environment-aware. Local builds retain their existing local defaults; published Pages artifacts must be read back from `/version.json` and match the configured identity and target Git SHA.

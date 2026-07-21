# Custom House Creator Marketplace

## Non-negotiable rules
- Preserve Shopify React Router authentication, Prisma session storage, App Bridge, and webhook patterns.
- Use Admin GraphQL only. Never expose access tokens, secrets, database URLs, or raw GraphQL errors.
- Shopify customer identity comes only from authenticated admin/app-proxy context; never trust a browser customer ID.
- Global products are merchant-owned (`global` + `customizable`). Creator products are generated only by admin approval (`creator` + `buy_only`). Never use `creator_base`.
- Manual InkyBay saved-design URLs are the only enabled provider. Do not invent, scrape, or call an undocumented API.
- Creator-profile metaobject sync is optional and must never block approval or publishing.
- Do not bulk-change products or remove Helium/Flow without explicit merchant confirmation.

## Architecture
- `app/services`: domain, validation, Shopify GraphQL, creator, submission, publishing, setup, and rate-limit services.
- `app/routes/app.*`: authenticated embedded-admin pages.
- `app/routes/proxy.*`: authenticated app-proxy JSON endpoints.
- `extensions/customhouse-creator-storefront`: Liquid blocks and scoped storefront assets.
- `prisma`: PostgreSQL schema and reviewed migrations. All environments require `DATABASE_URL`; production runs `prisma migrate deploy`.

## Commands
`npm install`, `npm run setup`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## Testing requirements
- Mock the Shopify GraphQL abstraction; never require a live shop for unit tests.
- Cover authorization, ownership, status transitions, URL allowlists, idempotency, tag conflicts, and publishing retry safety.
- Do not weaken TypeScript or tests to pass validation.

## Merchant-owned setup
Scopes/reinstall, app proxy URL, product metafield definitions, publication selection, theme deployment/blocks, Global Product tagging, and InkyBay product configuration require merchant verification.

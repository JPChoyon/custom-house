# Zakeke Marketplace Integration POC

## Status

The integration is implemented behind three production-off feature flags. It is
not approved for production use until the complete browser and order proof of
concept passes.

Current POC status: **BLOCKED / NOT PASSED**

The repository does not contain Zakeke API credentials, a verified Zakeke plan,
an allowlisted test product mapping, or evidence from two completed repeat
purchases and their print-ready files. Compilation or mocked tests must not be
treated as proof that the live Zakeke account supports the required APIs.

## Repository architecture

- Shopify React Router TypeScript application in `app`.
- Shopify authentication and Prisma session storage in `app/shopify.server.ts`.
- Authenticated embedded-admin routes in `app/routes/app.*`.
- Authenticated App Proxy routes under `/proxy`, exposed at
  `/apps/customhouse`.
- PostgreSQL/Neon Prisma schema and reviewed migrations in `prisma`.
- Theme App Extension in `extensions/customhouse-creator-storefront`.
- Vercel production runtime using the React Router server build.

## Customizer inventory

| Area | Classification | Decision |
| --- | --- | --- |
| Manual InkyBay saved-design submission | KEEP | Current production rollback flow remains available. |
| InkyBay compatibility app embed | KEEP | No selectors or product configuration were removed. |
| App Proxy authentication | REUSE | Zakeke storefront routes use the installed Shopify helper. |
| Creator approval/status/collection services | REUSE | Creator publish permissions and collections remain authoritative. |
| Draft-first Shopify product publishing | REUSE | Generated products remain DRAFT until configuration and publication complete. |
| Fabric.js POC | REMOVE AFTER POC | Default-off and preserved for rollback; it was not removed. |
| Polotno/Kickflip/Customily | UNKNOWN/ABSENT | No active implementation was found in the repository. |
| Existing `DesignSession` and `CreatorDesign` | REUSE | Extended for a provider-aware Zakeke flow; no duplicate creator model was added. |
| Existing product App Proxy placeholders | REPLACE LATER | New exact Zakeke endpoints are used without deleting old paths. |

## Official Zakeke contracts used

Only documented contracts are implemented:

- OAuth token: `POST https://api.zakeke.com/token`
- Design detail: `GET /v3/designs/{designID}/{quantity}`
- Duplicate design: `POST /v2/designs/{designID}`
- Design items: `GET /v1/designs/{designID}/items`
- Print ZIP: `GET /v1/designs/{designID}/outputfiles/zip`
- Order registration: `POST /v2/order`
- Customizer UI:
  `https://portal.zakeke.com/scripts/integration/apiV2/customizer.js`

References:

- <https://docs.zakeke.com/docs/API/authentication-and-authorization>
- <https://docs.zakeke.com/docs/API/designs-API>
- <https://docs.zakeke.com/docs/API/Integration/Visual-Product-Customizer/customizer-UI-API>
- <https://docs.zakeke.com/docs/API/Integration/Visual-Product-Customizer/order-registration-customizer>

No undocumented Zakeke cart property or API endpoint is used.

## Feature flags

```env
ZAKEKE_INTEGRATION_ENABLED=false
ZAKEKE_CREATOR_PUBLISHING_ENABLED=false
ZAKEKE_FIXED_PURCHASE_ENABLED=false
ZAKEKE_ADMIN_DIAGNOSTICS_ENABLED=false
```

Enable flags in Preview only, in this order:

1. Integration only.
2. Creator publishing after normal customization passes.
3. Fixed purchase after creator publishing passes.

Never enable all three automatically in Production.

## Required environment variables

```env
ZAKEKE_CLIENT_ID=
ZAKEKE_CLIENT_SECRET=
ZAKEKE_API_BASE_URL=https://api.zakeke.com
ZAKEKE_INTEGRATION_ENABLED=false
ZAKEKE_CREATOR_PUBLISHING_ENABLED=false
ZAKEKE_FIXED_PURCHASE_ENABLED=false
ZAKEKE_TEST_SHOPIFY_PRODUCT_ID=
ZAKEKE_TEST_PRODUCT_CODE=
ZAKEKE_TOKEN_ENCRYPTION_SECRET=
DESIGN_PURCHASE_SIGNING_SECRET=
```

Both signing secrets must be high-entropy values at least 32 characters long.
The client secret and S2S bearer token are server-only. The C2S token is created
server-side and is returned only to the short-lived Customizer UI page, as
required by Zakeke.

Temporary actor diagnostics are available only through the authenticated Admin
route `/app/zakeke/actor-diagnostic?customer_id=SHOPIFY_CUSTOMER_ID` when
`ZAKEKE_ADMIN_DIAGNOSTICS_ENABLED=true`. Keep this flag `false` outside a
short verification window. The response contains IDs, normalized status, and
authorized modes only; it never contains contact data or credentials.

## Product mapping

Use the embedded **Zakeke** admin page to validate and save one test mapping.
The test product must have:

```text
customhouse.product_type = global_customizable
customhouse.zakeke_enabled = true
```

Legacy `product_origin=global` plus `design_mode=customizable` remains accepted
during the POC.

Example explicit variant mapping:

```json
{
  "variants": [
    {
      "shopifyVariantId": "gid://shopify/ProductVariant/123",
      "sku": "TEE-S-BLACK",
      "attributes": {
        "size": "S",
        "color": "black"
      },
      "enabled": true
    }
  ]
}
```

Only variants explicitly marked compatible are copied to a fixed creator
product. An untested size or color must remain absent.

## Storefront behavior

Add **Zakeke Product Actions** to the one test product template.
Disable the standard Zakeke Shopify product-page launcher on that hidden test
template. The standard launcher opens Zakeke's native Shopify integration and
cannot receive the Custom House signed `CREATOR_PUBLISH` mode or the
`cartButtonText` override.

- Normal customers see **Customize This Product**.
- Approved active creators see **Customize & Buy** and
  **Create for My Collection**.
- The first button opens
  `/apps/customhouse/zakeke/designer?...&intent=creator_buy`.
- The collection button opens
  `/apps/customhouse/zakeke/designer?...&intent=creator_publish`.
- Pending, rejected, suspended, and ordinary customer accounts use
  `intent=customer_buy`.
- Pending, rejected, suspended, and logged-out customers cannot publish.
- `creator_fixed` products never load the Zakeke Customizer UI.
- Fixed purchase duplicates the source Zakeke design once per independent
  idempotent purchase operation.

Enable **Zakeke Cart Privacy** to hide Custom House private line-item properties
in the current theme. Verify both the full cart and Ajax cart drawer after every
theme change.

## Database and migration

Migration:

```text
prisma/migrations/20260730010000_zakeke_marketplace_poc/migration.sql
```

It is additive and preserves existing data. It adds:

- Provider-aware fields to `DesignSession` and `CreatorDesign`.
- `GlobalProductMapping`.
- `DesignPurchase`.
- Immutable order attribution in `OrderDesignSnapshot`.
- Webhook idempotency in `WebhookDelivery`.
- Database-backed order retry state in `ZakekeOrderJob`.

Never run `prisma migrate reset`. Apply the migration to Preview first with:

```bash
npx prisma migrate deploy
```

## Shopify configuration

The production configuration preserves all prior scopes and adds:

```text
read_orders
```

It adds:

```text
orders/create
orders/cancelled
refunds/create
products/update
```

Deploy configuration only after Preview validation:

```bash
shopify app deploy --config production
```

`read_orders` requires merchant scope approval/reinstallation before order
processing can be considered ready.

## Preview deployment sequence

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run lint
npm run typecheck
npm test
npm run build
vercel
```

Then add Zakeke credentials to Vercel Preview only and test the flags in the
required order. Do not add Zakeke secrets to source control or screenshots.

## Mandatory live POC

The POC passes only after all of these are verified:

1. One hidden/allowlisted T-shirt with S/M and Black/White.
2. Normal customer customization and Shopify checkout.
3. Zakeke order registration and correct print-ready file.
4. Approved creator **Add to My Collection**.
5. One fixed Shopify product in the creator collection with no editor.
6. Two independent purchases of that fixed product.
7. Two different duplicated Zakeke design IDs.
8. Both Zakeke orders and both correct production files.
9. Creator suspension hides collection/products and blocks direct purchase.
10. Reactivation restores only suspension-hidden resources.

If API credentials, design duplication, repeat order registration, variant
compatibility, or print files are unavailable on the selected plan, mark the
POC failed and keep the old production system.

## Rollback

Fast application rollback:

1. Set all three Zakeke flags to `false`.
2. Redeploy the last known-good Vercel production deployment.
3. Disable or remove the Zakeke theme blocks from the test template.
4. Leave additive database tables intact to preserve audit/order evidence.
5. Set any POC Shopify products to DRAFT if they were created.

Git rollback branch:

```bash
git checkout -b rollback/pre-zakeke pre-zakeke-integration
```

Do not reverse the migration by deleting production tables and do not uninstall
InkyBay until the complete Zakeke acceptance flow passes.

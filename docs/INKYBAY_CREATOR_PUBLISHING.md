# InkyBay creator publishing

## Supported integration

Custom House keeps the existing InkyBay **Customize & Buy** flow unchanged. Creator publishing uses the `MANUAL_PUBLISH_BRIDGE` because InkyBay has not supplied a documented saved-design export API or an official callback contract for this store.

An approved, non-suspended creator can start an owned app-proxy session for a product explicitly enabled with these product metafields:

- `customhouse.product_type = global_customizable`
- `customhouse.inkybay_enabled = true`
- `customhouse.creator_publishing_enabled = true`

The creator must provide an allowed HTTPS saved-design URL and matching `tid`, a public preview, a private production-ready PNG or PDF, a title, and at least one compatible variant. The generated Shopify product is created as DRAFT first and becomes active only after its metadata, preview, collection membership, and publication are all configured.

Creator fixed products use `customhouse.product_type = creator_fixed`, `creator-fixed`, and `custom-house-creator-product`. They do not render or load the InkyBay creator actions. Private artwork keys and URLs are never written to public Shopify metafields.

## Feature flags

Keep all flags disabled until the Preview database migration, private storage, and duplicate-theme tests are complete:

```text
INKYBAY_CREATOR_PUBLISHING_ENABLED=false
INKYBAY_CUSTOM_CALLBACK_ENABLED=false
INKYBAY_MANUAL_PUBLISH_BRIDGE_ENABLED=false
```

For the Preview POC, enable creator publishing and the manual bridge only. Keep the callback flag false unless InkyBay supplies and the team verifies an official signed contract.

Private production artwork should use a **Private** Vercel Blob store when the
app is hosted on Vercel:

```text
PRIVATE_STORAGE_PROVIDER=vercel_blob
BLOB_STORE_ID=
BLOB_READ_WRITE_TOKEN=
```

`BLOB_STORE_ID` plus the Vercel runtime OIDC token is supported. A project-scoped
read/write token may be used where OIDC is unavailable. Never expose either value
to storefront code. The application stores only the private pathname and streams
admin downloads through the authenticated embedded route.

An HTTPS S3-compatible private bucket remains supported as a fallback:

```text
PRIVATE_STORAGE_PROVIDER=s3
PRIVATE_STORAGE_ENDPOINT=
PRIVATE_STORAGE_REGION=
PRIVATE_STORAGE_BUCKET=
PRIVATE_STORAGE_ACCESS_KEY_ID=
PRIVATE_STORAGE_SECRET_ACCESS_KEY=
PRIVATE_STORAGE_FORCE_PATH_STYLE=false
```

The store or bucket must be private. Grant only object read/write access for this application. Configure lifecycle/retention rules according to the merchant's production policy. S3 admin downloads use short-lived signed URLs.

Optional validation limits are documented in `.env.example`. `DESIGN_SIGNING_SECRET` must remain a server-only, high-entropy secret because it signs creator session tokens.

## Database rollout

Migration: `20260731000000_inkybay_creator_publishing`.

1. Create an isolated Neon Preview branch from the current production schema.
2. Assign that branch's pooled `DATABASE_URL` and direct `DIRECT_DATABASE_URL` only to the Vercel Preview environment.
3. Run `npx prisma migrate deploy` against the Preview branch.
4. Run the full automated suite and duplicate-theme POC.
5. After acceptance and immediately before the production app release, run `npx prisma migrate deploy` against production.

Never run `prisma migrate reset` or use `prisma db push` as the production migration strategy.

## Preview acceptance

Use one active InkyBay-enabled test T-shirt and an unpublished duplicate theme. Confirm:

- normal customers see and complete only the existing Customize & Buy flow;
- approved creators see both actions and repeated clicks reuse one session;
- pending, rejected, and suspended creators cannot start or publish;
- saved URL/tid, file validation, variants, and retry states work;
- publishing creates exactly one fixed product in the creator collection;
- the fixed product has no InkyBay editor and remains normally purchasable;
- order creation stores an immutable private-artwork snapshot;
- suspension hides eligible resources and reactivation restores only those hidden by suspension.

Do not publish the duplicate theme or enable every global product during the POC.

The repository includes `shopify.app.inkybay-preview.toml` for the separate development app only. Its app proxy is `/apps/customhouse-inkybay-preview`; configure that value in the test theme block. Never deploy this file as the production app configuration. The live block keeps `/apps/customhouse` by default.

## Operations

The embedded **InkyBay Publishing** page shows sessions, waiting assets, published/failed designs, fixed product references, order snapshots, safe error references, retry/hide/archive controls, and authenticated private-artwork downloads.

The `products/update` webhook removes deleted/inactive compatible variants without deleting historical designs. Changed designs become safely retryable; inactive or variant-less source products hide linked products. The `orders/create` webhook records creator fixed-product snapshots before running the existing Zakeke/InkyBay order path.

## Rollback

Code rollback point: Git tag `pre-inkybay-creator-publishing`.

If a Preview or live smoke test fails:

1. Set `INKYBAY_CREATOR_PUBLISHING_ENABLED=false` and redeploy.
2. Keep the manual/callback flags disabled.
3. Restore the previously published theme if the live theme was changed.
4. Roll Vercel back to the last stable deployment or deploy the tagged commit.
5. Preserve sessions, designs, order snapshots, and private files for diagnosis.
6. Keep any partially created Shopify creator product DRAFT.

The migration is additive and should not be rolled back by deleting production data. A database rollback requires a separately reviewed forward migration.

## Merchant-owned steps

- Verify the one test product's metafields, variants, InkyBay collection membership, minimum quantity, and normal Add to Cart behavior.
- Create/connect a private Vercel Blob store (recommended) or supply private S3-compatible storage through the hosting dashboard; never send credentials in chat.
- Create and select the unpublished duplicate theme, then add/configure the InkyBay Creator Actions block.
- Verify app scopes, app proxy, Online Store publication selection, and theme extension deployment.
- Approve production rollout only after every Preview acceptance check passes.

# Fabric.js Product Designer POC

## Safety boundary

This is a one-product validation POC. It does not replace InkyBay or the
existing manual saved-design workflow.

The POC is disabled unless all of the following are true:

1. `CUSTOM_HOUSE_DESIGNER_ENABLED=true`
2. A valid test product GID is configured.
3. A public HTTPS mockup is configured.
4. `DESIGN_SIGNING_SECRET` contains at least 32 characters.
5. The database migration has been deployed.

When the flag is false, the storefront button stays hidden and the Fabric.js
bundle is not requested.

## Environment variables

Required to enable the POC:

```dotenv
CUSTOM_HOUSE_DESIGNER_ENABLED=false
CUSTOM_HOUSE_DESIGNER_PRODUCT_ID=
CUSTOM_HOUSE_DESIGNER_MOCKUP_URL=
CUSTOM_HOUSE_DESIGNER_ALLOWED_VARIANTS=
DESIGN_SIGNING_SECRET=
```

Optional print-template overrides are listed in `.env.example`. Defaults are a
900 × 1100 canvas, a 400 × 500 front print area at 250 × 250, and a 2400 ×
3000 artwork export. Print and export aspect ratios must match.

`CUSTOM_HOUSE_DESIGNER_ALLOWED_VARIANTS` is a comma-separated list of Shopify
ProductVariant GIDs. An empty list keeps all variants for the configured test
product. For the manual POC, configure only the explicitly approved size/color
variants.

## Storage and rendering

- Source uploads use the existing Shopify Files staged-upload flow.
- File bytes, extension, MIME signature, size, and dimensions are validated.
- Fabric JSON may reference only HTTPS Shopify CDN images.
- Large base64 image payloads are rejected.
- Preview and transparent artwork are re-rendered by Fabric.js on the server.
- The product mockup is composed only into the preview; it is not present in
  transparent artwork.
- Neon stores URLs and serialized JSON, not PNG/base64 blobs.

## Database

Migration:

`prisma/migrations/20260730000000_fabric_designer_poc/migration.sql`

It creates:

- `DesignSession` for versioned customer and creator drafts.
- `CreatorDesign` for idempotent Shopify product synchronization.
- Designer mode, session status, creator design status, and sync status enums.

Existing Session, ShopConfig, Creator, CreatorApplication, DesignSubmission,
and AuditLog data is preserved.

## Local test

1. Use a disposable PostgreSQL/Neon branch.
2. Copy `.env.example` to `.env` and supply development-only values.
3. Keep `CUSTOM_HOUSE_DESIGNER_ENABLED=false`.
4. Run:

   ```bash
   npm ci
   npx prisma generate
   npx prisma migrate deploy
   npm run lint
   npm run typecheck
   npm test
   npm run build
   ```

5. Deploy the theme extension to a development store.
6. Add the **Fabric Designer POC** app block to only the test product template.
7. Set the test product metafields:

   ```text
   customhouse.product_origin = global
   customhouse.design_mode = customizable
   ```

8. Set the product and allowed variant GIDs in the local environment.
9. Set a mockup URL that permits cross-origin image loading.
10. Set a random secret of at least 32 characters.
11. Change the feature flag to `true` only in the development environment.
12. Test at 375, 390, 430, 768, 1024, and 1440 pixels.

## Acceptance flow

Customer:

1. Sign in to a Shopify customer account.
2. Open the configured global T-shirt.
3. Open the customizer, add text or an uploaded image, and preview it.
4. Click **Customize & Buy**.
5. Confirm the original variant is in cart with signed private design
   properties.

Creator:

1. Sign in as one approved, active creator.
2. Open the same global T-shirt.
3. Select **Create for my collection**.
4. Save a draft, reload it, and click **Add to My Collection**.
5. Confirm exactly one fixed product exists, with only allowlisted variants,
   the preview image, creator/design/base-product metafields, and the tags
   `creator-fixed` and `custom-house-creator-product`.
6. Confirm the editor stays hidden on the generated product.

Suspension:

1. Suspend the creator from the existing admin workflow.
2. Confirm Fabric-created products become DRAFT/unpublished and the creator
   collection is unpublished.
3. Confirm creator publish endpoints return 403.
4. Reactivate the creator and confirm only records marked hidden by suspension
   are restored.

## Vercel preview deployment

1. Create a Neon preview branch; do not point an unapproved preview at the
   production database.
2. Add the standard Shopify variables plus all required designer variables to
   the Vercel **Preview** environment.
3. Keep `CUSTOM_HOUSE_DESIGNER_ENABLED=false` for the first deployment.
4. Run the migration against the preview database:

   ```bash
   npx prisma migrate deploy
   ```

5. Deploy the branch to Vercel Preview.
6. Verify `/health` and the embedded `/app/designer-poc` page.
7. Configure the preview URL in a separate Shopify development app/store if
   end-to-end proxy testing is required.
8. Enable the flag only after the theme block, test product, variant allowlist,
   mockup CORS, Shopify Files scopes, publication, and signing secret are
   confirmed.

## Production limitations

- This POC does not send artwork to a print provider.
- A production order webhook must verify the signed token against
  `DesignSession`; cart properties alone are not trusted by this code.
- It does not implement royalties, payouts, 3D, AI, clipart, or multi-product
  templates.
- Shopify Files are used as the current storage provider. A later production
  storage adapter can add private source-object retention and lifecycle rules.
- The POC uses server-side `canvas`, which must be included successfully in the
  Vercel Node runtime before enabling production traffic.

## Rollback

1. Set `CUSTOM_HOUSE_DESIGNER_ENABLED=false` and redeploy.
2. Remove or hide the Fabric Designer POC theme block.
3. Leave the additive database tables in place so drafts and audit evidence are
   retained.
4. Manually set any POC-created test products to DRAFT/unpublished if required.
5. Revert the application commit only after the flag is disabled. Do not run
   `prisma migrate reset` and do not delete existing creator or submission data.


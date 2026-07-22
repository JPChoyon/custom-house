# Shopify Flow setup for Helium creator applications

No active Flow workflow was changed by this repository update. Record screenshots of every trigger, condition, and action before editing Shopify Flow. Do not disable or delete a workflow without merchant approval.

## Discover the real Helium form identifier

1. In Shopify Admin, open **Apps → Customer Fields → Forms**.
2. Open **Creator Application – Storefront**.
3. Record the immutable form ID used by the Customer Fields Flow trigger; do not rely only on its display name.
4. For every custom field, record its Shopify customer metafield namespace, key, and type.
5. In Custom House Creator, open **Settings → Helium Customer Fields metafields**. The app queries live Customer metafield definitions; select each recorded definition and enable it.
6. Save, then run **Creators → Helium Migration → Dry run**. Resolve missing mappings and conflicts before confirming import.

## Helium Creator Form → Pending bridge

1. In **Apps → Shopify Flow**, create or inspect the workflow named **Helium Creator Form → Pending**.
2. Trigger: **Customer Fields → Customer submitted form**.
3. Condition: submitted form ID equals the recorded ID for **Creator Application – Storefront**.
4. Add conditions requiring `creator-approved`, `creator-suspended`, and `creator-pending` to be absent.
5. Add customer tags `creator-applicant` and `creator-pending`.
6. Remove `creator-rejected`. Remove `creator-approved` and `creator-suspended` only within this guarded first-application branch; never reset an approved or suspended creator after a profile edit.
7. Do not add a tag that is also the workflow trigger. Save without activating until the merchant reviews the backup and conditions.

## Existing workflows requiring merchant review

- **New Creator Applications**: trigger when `creator-pending` is added; notification actions only. Remove any action that adds `creator-pending` again.
- **Creator Application - Approved**: trigger when `creator-approved` is added; notification actions only. Do not update authoritative status or re-add the tag.
- **Creator Application - Rejected**: trigger when `creator-rejected` is added; notification actions only. Do not re-add the tag.
- **Creator Application - Suspend**: trigger when `creator-suspended` is added; notification actions only. Do not re-add the tag.

After editing, test each workflow with a dedicated customer and confirm a single run without recursive executions. Helium and all workflows remain installed and active until the full acceptance test passes and the merchant explicitly approves a change.

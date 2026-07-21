CREATE TABLE "ShopConfig" (
  "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "creatorApplicationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "automaticCollectionCreationEnabled" BOOLEAN NOT NULL DEFAULT true, "requireAdminApproval" BOOLEAN NOT NULL DEFAULT true,
  "collectionTitleTemplate" TEXT NOT NULL DEFAULT '{creatorName} Designs', "collectionHandleSuffix" TEXT NOT NULL DEFAULT 'designs',
  "creatorTagsJson" TEXT NOT NULL DEFAULT '{}', "onlineStorePublicationId" TEXT, "creatorProfileMetaobjectType" TEXT,
  "creatorProfileFieldMapJson" TEXT, "creatorStatusMetafieldNamespace" TEXT, "creatorStatusMetafieldKey" TEXT,
  "inkybayAllowedHostsJson" TEXT NOT NULL DEFAULT '[]', "inkybayBuyOnlyHiddenSelectorsJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ShopConfig_shop_key" ON "ShopConfig"("shop");

CREATE TABLE "Creator" (
  "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "customerId" TEXT NOT NULL, "displayName" TEXT NOT NULL,
  "handle" TEXT NOT NULL, "bio" TEXT, "portfolioUrl" TEXT, "profileImageUrl" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "collectionId" TEXT, "creatorProfileMetaobjectId" TEXT, "approvedAt" DATETIME, "rejectedAt" DATETIME, "suspendedAt" DATETIME,
  "rejectionReason" TEXT, "suspensionReason" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Creator_shop_customerId_key" ON "Creator"("shop", "customerId");
CREATE UNIQUE INDEX "Creator_shop_handle_key" ON "Creator"("shop", "handle");
CREATE INDEX "Creator_shop_status_idx" ON "Creator"("shop", "status");

CREATE TABLE "CreatorApplication" (
  "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "creatorId" TEXT NOT NULL, "answersJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "reviewerNote" TEXT, "reviewedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "CreatorApplication_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorApplication_shop_status_idx" ON "CreatorApplication"("shop", "status");
CREATE INDEX "CreatorApplication_creatorId_createdAt_idx" ON "CreatorApplication"("creatorId", "createdAt");

CREATE TABLE "DesignSubmission" (
  "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "creatorId" TEXT NOT NULL, "baseProductId" TEXT NOT NULL,
  "baseVariantId" TEXT, "designName" TEXT NOT NULL, "inkybayDesignId" TEXT, "savedDesignUrl" TEXT NOT NULL,
  "previewUrl" TEXT, "creatorMessage" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING', "idempotencyKey" TEXT NOT NULL,
  "createdProductId" TEXT, "publishError" TEXT, "reviewedAt" DATETIME, "publishedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DesignSubmission_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DesignSubmission_shop_idempotencyKey_key" ON "DesignSubmission"("shop", "idempotencyKey");
CREATE INDEX "DesignSubmission_shop_status_idx" ON "DesignSubmission"("shop", "status");
CREATE INDEX "DesignSubmission_creatorId_createdAt_idx" ON "DesignSubmission"("creatorId", "createdAt");
CREATE INDEX "DesignSubmission_shop_createdProductId_idx" ON "DesignSubmission"("shop", "createdProductId");

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "actorType" TEXT NOT NULL, "actorId" TEXT, "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL, "beforeJson" TEXT, "afterJson" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuditLog_shop_createdAt_idx" ON "AuditLog"("shop", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

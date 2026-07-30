export type StorefrontCreatorStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "SUSPENDED";

export type StorefrontActorRole = "GUEST" | "CUSTOMER" | "CREATOR";

export type AuthorizedDesignerMode =
  | "CUSTOMER_BUY"
  | "CREATOR_BUY"
  | "CREATOR_PUBLISH";

export type StorefrontActor = {
  customerId: string | null;
  role: StorefrontActorRole;
  creatorId: string | null;
  creatorStatus: StorefrontCreatorStatus | null;
  isApprovedCreator: boolean;
  isSuspended: boolean;
  authorizedDesignerModes: AuthorizedDesignerMode[];
};

export function normalizeStorefrontActor(input: {
  customerId: string | null;
  creator: {
    id: string;
    status: StorefrontCreatorStatus;
    suspendedAt: Date | string | null;
  } | null;
}): StorefrontActor {
  const isSuspended = Boolean(
    input.creator &&
      (input.creator.status === "SUSPENDED" ||
        input.creator.suspendedAt),
  );
  const isApprovedCreator = Boolean(
    input.creator?.status === "APPROVED" && !isSuspended,
  );
  return {
    customerId: input.customerId,
    role: input.creator
      ? "CREATOR"
      : input.customerId
        ? "CUSTOMER"
        : "GUEST",
    creatorId: input.creator?.id ?? null,
    creatorStatus: input.creator?.status ?? null,
    isApprovedCreator,
    isSuspended,
    authorizedDesignerModes: [
      "CUSTOMER_BUY",
      ...(isApprovedCreator
        ? (["CREATOR_BUY", "CREATOR_PUBLISH"] as const)
        : []),
    ],
  };
}

import { useNavigation, useRouteError } from "react-router";

type SubmitButtonProps = {
  children: React.ReactNode;
  name?: string;
  value?: string;
  confirmMessage?: string;
};

export function SubmitButton({
  children,
  name,
  value,
  confirmMessage,
}: SubmitButtonProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={submitting}
      aria-busy={submitting}
      onClick={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {submitting ? "Working…" : children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const label =
    {
      PENDING: "Pending",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      SUSPENDED: "Suspended",
      PUBLISHING: "Publishing",
      PUBLISHED: "Published",
      FAILED: "Failed",
      ARCHIVED: "Archived",
    }[status] ?? "Unknown";

  return (
    <span className={`status-badge status-badge--${status.toLowerCase()}`}>
      {label}
    </span>
  );
}

export function AdminStyles() {
  return (
    <style>{`
      .dashboard-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
      }
      .dashboard-card {
        min-width: 0;
        padding: 18px;
        border: 1px solid #e3e3e3;
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .05);
      }
      .dashboard-card h3 { margin: 0 0 8px; overflow-wrap: anywhere; }
      .dashboard-card p { margin: 6px 0; overflow-wrap: anywhere; }
      .dashboard-actions, .dashboard-filters {
        display: flex;
        flex-wrap: wrap;
        align-items: end;
        gap: 12px;
        margin-top: 16px;
      }
      .dashboard-field { display: grid; gap: 5px; min-width: min(100%, 220px); }
      .dashboard-field input, .dashboard-field textarea, .dashboard-field select {
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        min-height: 38px;
      }
      .dashboard-avatar {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        object-fit: cover;
        border: 1px solid #dedede;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 3px 9px;
        border-radius: 999px;
        background: #e8e8e8;
        color: #303030;
        font-size: 12px;
        font-weight: 650;
      }
      .status-badge--approved, .status-badge--published { background: #cdfee1; color: #0c5132; }
      .status-badge--pending, .status-badge--publishing { background: #fff1b8; color: #5e4200; }
      .status-badge--rejected, .status-badge--failed, .status-badge--suspended { background: #fee4e2; color: #8e1f0b; }
      button:disabled { cursor: wait; opacity: .6; }
      @media (max-width: 600px) {
        .dashboard-grid { grid-template-columns: 1fr; }
        .dashboard-actions > *, .dashboard-filters > * { width: 100%; }
        .dashboard-actions button, .dashboard-filters button { min-height: 44px; }
      }
    `}</style>
  );
}

export function SafeAdminError({
  heading = "We could not load this page",
}: {
  heading?: string;
}) {
  useRouteError();

  return (
    <s-page heading={heading}>
      <AdminStyles />
      <s-banner tone="critical">
        We could not load this information. Please try again. If the problem
        continues, contact support with the approximate time of the error.
      </s-banner>
    </s-page>
  );
}

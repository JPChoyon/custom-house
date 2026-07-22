const DASHBOARD_ENDPOINT = "/apps/customhouse/api/creator-dashboard";

export function resolveDashboardState(data) {
  if (!data || typeof data !== "object") return { state: "CREATOR_RECORD_MISSING", message: "No creator application was found." };
  switch (data.state) {
    case "LOGGED_OUT": return { state: "LOGGED_OUT", message: "Please sign in to access your creator dashboard." };
    case "APPLICATION_NOT_SUBMITTED": return { state: "APPLICATION_NOT_SUBMITTED", message: "No creator application was found. Apply to become a creator." };
    case "NOT_APPLIED": return { state: "NOT_APPLIED", message: "No creator application was found." };
    case "SYNC_CONFLICT": return { state: "SYNC_CONFLICT", message: "Your creator account needs administrator review.", data };
    case "PENDING": return { state: "PENDING", message: "Your creator application is under review.", data };
    case "APPROVED": return { state: "APPROVED", message: `Welcome, ${data.displayName}.`, data };
    case "REJECTED": return { state: "REJECTED", message: data.rejectionReason ? `Your creator application was rejected: ${data.rejectionReason}` : "Your creator application was rejected.", data };
    case "SUSPENDED": return { state: "SUSPENDED", message: data.suspensionReason ? `Your creator account is suspended: ${data.suspensionReason}` : "Your creator account is suspended.", data };
    default: return { state: "CREATOR_RECORD_MISSING", message: "No creator application was found." };
  }
}

export async function loadDashboardState(request, emit) {
  emit({ state: "LOADING", loading: true, message: "Loading…" });
  try {
    emit({ ...resolveDashboardState(await request()), loading: false });
  } catch {
    emit({ state: "API_ERROR", loading: false, message: "We couldn't load your creator dashboard. Please try again." });
  } finally {
    emit({ state: "LOADING_COMPLETE", loading: false });
  }
}

async function requestDashboard() {
  const response = await fetch(DASHBOARD_ENDPOINT, { credentials: "same-origin", headers: { Accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || !body?.ok) throw new Error("Dashboard request failed");
  return body.data;
}

function renderDashboard(root, view) {
  const loading = root.querySelector("[data-dashboard-loading]");
  if (view.state === "LOADING_COMPLETE") { loading.hidden = true; return; }
  root.dataset.dashboardState = view.state.toLowerCase();
  loading.hidden = !view.loading;
  const message = root.querySelector("[data-dashboard-message]");
  message.hidden = view.state === "LOADING";
  message.textContent = view.state === "LOADING" ? "" : view.message;
  message.classList.toggle("customhouse-error", view.state === "API_ERROR");
  root.querySelector("[data-dashboard-login]").hidden = view.state !== "LOGGED_OUT";
  root.querySelector("[data-dashboard-apply]").hidden = !["NOT_APPLIED", "APPLICATION_NOT_SUBMITTED", "CREATOR_RECORD_MISSING", "REJECTED"].includes(view.state);

  const profile = root.querySelector("[data-dashboard-profile]");
  profile.hidden = view.state !== "APPROVED";
  if (view.state !== "APPROVED") return;
  profile.querySelector("[data-dashboard-name]").textContent = view.data.displayName;
  profile.querySelector("[data-dashboard-status]").textContent = view.data.status;
  profile.querySelector("[data-dashboard-bio]").textContent = view.data.bio || "";
  const image = profile.querySelector("[data-dashboard-image]");
  image.hidden = !view.data.profileImageUrl?.startsWith("https://");
  if (!image.hidden) { image.src = view.data.profileImageUrl; image.alt = `${view.data.displayName} profile`; }
  const portfolio = profile.querySelector("[data-dashboard-portfolio]");
  portfolio.hidden = !view.data.portfolioUrl;
  if (view.data.portfolioUrl) portfolio.href = view.data.portfolioUrl;
  const collection = profile.querySelector("[data-dashboard-collection]");
  collection.hidden = !view.data.collectionUrl;
  if (view.data.collectionUrl) collection.href = view.data.collectionUrl;
  const submissions = profile.querySelector("[data-dashboard-submissions]");
  submissions.replaceChildren();
  const recent = Array.isArray(view.data.submissions) ? view.data.submissions : [];
  if (!recent.length) {
    const item = document.createElement("li");
    item.textContent = "No design submissions yet.";
    submissions.append(item);
    return;
  }
  recent.forEach((submission) => {
    const item = document.createElement("li");
    item.textContent = `${submission.designName}: ${submission.status}`;
    submissions.append(item);
  });
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-customhouse-dashboard]").forEach((root) => {
    void loadDashboardState(requestDashboard, (view) => renderDashboard(root, view));
  });
}

(() => {
  const api = (path, options = {}) => fetch(`/apps/customhouse/api/${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error?.message || "Request failed");
    return body.data;
  });

  const message = (element, text, error = false) => {
    if (!element) return;
    element.hidden = false;
    element.textContent = text;
    element.classList.toggle("customhouse-error", error);
  };

  document.querySelectorAll("[data-customhouse-application]").forEach(async (element) => {
    const loading = element.querySelector("[data-application-loading]");
    const notice = element.querySelector("[data-application-message]");
    const form = element.querySelector("[data-application-form]");
    const login = element.querySelector("[data-application-login]");
    const dashboard = element.querySelector("[data-application-dashboard]");
    const show = (state, text, error = false) => { element.dataset.applicationState = state; message(notice, text, error); };
    try {
      const me = await api("me");
      if (!me.loggedIn) { show("logged-out", "Please sign in to apply as a creator."); login.hidden = false; return; }
      if (!me.creator) { show("ready", "Complete the application below."); form.hidden = false; return; }
      if (me.creator.status === "PENDING") show("pending", "Your creator application is under review.");
      if (me.creator.status === "APPROVED") { show("approved", "Your creator application is approved."); dashboard.hidden = false; }
      if (me.creator.status === "REJECTED") show("rejected", "Your creator application was rejected.");
      if (me.creator.status === "SUSPENDED") show("suspended", "Your creator account is suspended.");
    } catch { show("server-error", "The application form could not be loaded. Please try again.", true); }
    finally { loading.hidden = true; }

    form?.addEventListener("submit", async (event) => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const button = form.querySelector("button[type=submit]"); button.disabled = true;
      try {
        const values = new FormData(form); let profileImageUrl;
        const image = values.get("profileImage");
        if (image instanceof File && image.size) { const uploadForm = new FormData(); uploadForm.append("profileImage", image); profileImageUrl = (await api("creator-profile-upload", { method: "POST", headers: {}, body: uploadForm })).profileImageUrl; }
        const socialLinks = String(values.get("socialLinks") || "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
        const body = { legalName: values.get("legalName"), displayName: values.get("displayName"), country: values.get("country"), city: values.get("city"), bio: values.get("bio"), portfolioUrl: values.get("portfolioUrl") || undefined, socialLinks, profileImageUrl, message: values.get("message") || undefined, termsAccepted: values.get("termsAccepted") === "on" };
        await api("creator-applications", { method: "POST", body: JSON.stringify(body) });
        form.hidden = true; dashboard.hidden = false; show("pending", "Application submitted. Your creator application is under review.");
      } catch (error) { show("validation-error", error instanceof Error ? error.message : "Application submission failed.", true); button.disabled = false; }
    });
  });

  document.querySelectorAll("[data-customhouse-submission]").forEach(async (element) => {
    const status = element.querySelector("[data-status]");
    try {
      const me = await api("me");
      if (!me.creator || me.creator.status !== "APPROVED") { message(status, "Only approved creators can submit designs."); return; }
      element.querySelector("form").hidden = false;
    } catch (error) {
      message(status, error instanceof Error ? error.message : "Request failed", true);
    }
    element.querySelector("form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      data.baseProductId = element.dataset.productGid;
      try {
        await api("design-submissions", { method: "POST", body: JSON.stringify(data) });
        message(status, "Design submitted for review.");
        event.currentTarget.reset();
      } catch (error) {
        message(status, error instanceof Error ? error.message : "Request failed", true);
      }
    });
  });

  document.querySelectorAll("[data-customhouse-buy-only]").forEach((element) => {
    document.body.classList.add("customhouse-buy-only");
    let selectors = [];
    try { selectors = JSON.parse(element.dataset.selectors || "[]"); } catch { selectors = []; }
    const hide = () => selectors.forEach((selector) => {
      try { document.querySelectorAll(selector).forEach((node) => node.classList.add("customhouse-configured-hidden")); } catch { /* Ignore invalid merchant selectors. */ }
    });
    hide();
    new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
  });
})();

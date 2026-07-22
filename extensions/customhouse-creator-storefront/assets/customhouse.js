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

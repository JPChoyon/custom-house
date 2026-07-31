(() => {
  const ROOT_SELECTOR = "[data-customhouse-inkybay-actions]";

  function selectedVariant(root) {
    const form =
      root.closest("section")?.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]');
    const value = form?.querySelector('[name="id"]')?.value;
    return value && /^\d+$/.test(value)
      ? `gid://shopify/ProductVariant/${value}`
      : root.dataset.currentVariantId;
  }

  function showStatus(root, text, error = false) {
    const message = root.querySelector("[data-inkybay-message]");
    if (!message || root.dataset.showStatus !== "true") return;
    message.hidden = !text;
    message.textContent = text;
    message.dataset.error = String(error);
  }

  async function json(url, options) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...options,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      throw new Error(
        body?.error?.message ||
          "Creator publishing is temporarily unavailable.",
      );
    }
    return body.data;
  }

  function existingInkyBayButton(root) {
    const automatic = document.querySelector(
      "[data-inkybay-customize-trigger]",
    );
    if (automatic && !root.contains(automatic)) return automatic;

    const selector = root.dataset.existingSelector?.trim();
    if (!selector) return null;
    try {
      const button = document.querySelector(selector);
      return button && !root.contains(button) ? button : null;
    } catch {
      return null;
    }
  }

  function setLoading(root, loading) {
    const loadingState = root.querySelector("[data-inkybay-loading]");
    if (loadingState) loadingState.hidden = !loading;
  }

  function enableCustomerAction(root, existingButton) {
    const group = root.querySelector("[data-inkybay-customer-actions]");
    const buy = root.querySelector("[data-inkybay-buy]");
    if (!group || !buy || !existingButton) return false;
    group.hidden = false;
    buy.disabled = false;
    buy.addEventListener("click", () => existingButton.click());
    return true;
  }

  function bindCreatorAction(root, endpoint) {
    const group = root.querySelector("[data-inkybay-creator-actions]");
    const create = root.querySelector("[data-inkybay-create]");
    if (!group || !create) return;
    group.hidden = false;
    create.disabled = false;
    create.addEventListener("click", async () => {
      if (root.dataset.creating === "true") return;
      const variantId = selectedVariant(root);
      if (!variantId) {
        showStatus(root, "Choose an available size or color first.", true);
        return;
      }
      root.dataset.creating = "true";
      create.disabled = true;
      showStatus(root, "Preparing your secure creator workspace…");
      try {
        const idempotencyKey =
          root.dataset.sessionKey ||
          crypto.randomUUID?.().replaceAll("-", "") ||
          `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        root.dataset.sessionKey = idempotencyKey;
        const session = await json(`${endpoint}/creator-designs/start`, {
          method: "POST",
          body: JSON.stringify({
            productId: root.dataset.productId,
            variantId,
            idempotencyKey,
          }),
        });
        window.location.assign(session.workspaceUrl);
      } catch (error) {
        showStatus(
          root,
          error instanceof Error
            ? error.message
            : "The creator workspace could not be started.",
          true,
        );
        root.dataset.creating = "false";
        create.disabled = false;
      }
    });
  }

  async function initialize(root) {
    if (root.dataset.ready === "true") return;
    root.dataset.ready = "true";
    root.hidden = false;
    setLoading(root, true);

    const configuredProxyRoot = root.dataset.appProxyRoot?.trim() || "";
    const proxyRoot = /^\/apps\/[a-z0-9][a-z0-9-]*$/i.test(configuredProxyRoot)
      ? configuredProxyRoot
      : "/apps/customhouse-inkybay-preview";
    const endpoint = `${proxyRoot}/api/inkybay`;
    const existingButton = existingInkyBayButton(root);
    const customerActionReady = enableCustomerAction(root, existingButton);

    if (root.dataset.creatorPublishingEnabled !== "true") {
      setLoading(root, false);
      if (!customerActionReady) {
        showStatus(
          root,
          "Use the existing InkyBay control to customize this product.",
        );
      }
      return;
    }

    try {
      const query = new URLSearchParams({
        product_id: root.dataset.productId,
      });
      const eligibility = await json(`${endpoint}/eligibility?${query}`);
      if (
        eligibility.creatorPublishAvailable &&
        eligibility.isApprovedCreator &&
        !eligibility.isSuspendedCreator
      ) {
        bindCreatorAction(root, endpoint);
      }
    } catch {
      showStatus(
        root,
        customerActionReady
          ? "Creator publishing is unavailable, but normal InkyBay customization remains available."
          : "Creator publishing is temporarily unavailable.",
        true,
      );
    } finally {
      setLoading(root, false);
    }
  }

  function initializeAll(scope = document) {
    scope.querySelectorAll(ROOT_SELECTOR).forEach(initialize);
  }

  function updateVariant(event) {
    const input = event.target.closest?.(
      'form[action*="/cart/add"] [name="id"]',
    );
    if (!input || !/^\d+$/.test(input.value)) return;
    document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
      root.dataset.currentVariantId = `gid://shopify/ProductVariant/${input.value}`;
    });
  }

  if (!window.__customHouseInkyBayCreatorActionsBound) {
    window.__customHouseInkyBayCreatorActionsBound = true;
    document.addEventListener("change", updateVariant);
    document.addEventListener("shopify:section:load", (event) =>
      initializeAll(event.target),
    );
    document.addEventListener("shopify:block:select", (event) =>
      initializeAll(event.target),
    );
  }
  initializeAll();
})();

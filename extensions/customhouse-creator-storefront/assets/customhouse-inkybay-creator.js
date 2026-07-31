(() => {
  const endpoint = "/apps/customhouse/api/inkybay";

  function selectedVariant(root) {
    const form =
      root.closest("section")?.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]');
    const value = form?.querySelector('[name="id"]')?.value;
    return value && /^\d+$/.test(value)
      ? `gid://shopify/ProductVariant/${value}`
      : root.dataset.currentVariantId;
  }

  function status(root, text, error = false) {
    const message = root.querySelector("[data-inkybay-message]");
    message.hidden = false;
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
        body?.error?.message || "Creator publishing is temporarily unavailable.",
      );
    }
    return body.data;
  }

  function existingInkyBayButton(root) {
    const selector = root.dataset.existingSelector?.trim();
    if (!selector) return null;
    try {
      const button = document.querySelector(selector);
      return button && !root.contains(button) ? button : null;
    } catch {
      return null;
    }
  }

  document
    .querySelectorAll("[data-customhouse-inkybay-creator]")
    .forEach(async (root) => {
      const existingButton = existingInkyBayButton(root);
      const buy = root.querySelector("[data-inkybay-buy]");
      if (existingButton) {
        existingButton.textContent = "Customize & Buy";
        buy.hidden = false;
        buy.addEventListener("click", () => existingButton.click());
      }
      try {
        const query = new URLSearchParams({
          product_id: root.dataset.productId,
        });
        const eligibility = await json(`${endpoint}/eligibility?${query}`);
        if (!eligibility.creatorPublishAvailable) return;
        const create = root.querySelector("[data-inkybay-create]");
        create.hidden = false;
        create.disabled = false;
        create.addEventListener("click", async () => {
          const variantId = selectedVariant(root);
          if (!variantId) {
            status(root, "Choose an available size or color first.", true);
            return;
          }
          create.disabled = true;
          status(root, "Preparing your secure creator workspace…");
          try {
            const idempotencyKey =
              root.dataset.sessionKey ||
              (crypto.randomUUID?.().replaceAll("-", "") ||
                `${Date.now()}_${Math.random().toString(36).slice(2)}`);
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
            status(
              root,
              error instanceof Error
                ? error.message
                : "The creator workspace could not be started.",
              true,
            );
            create.disabled = false;
          }
        });
      } catch (error) {
        if (existingButton) {
          status(
            root,
            "Creator publishing is unavailable, but normal InkyBay customization remains available.",
            true,
          );
        }
      }
    });
})();

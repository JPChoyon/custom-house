(() => {
  const endpoint = "/apps/customhouse/api/zakeke";

  function variantId(root) {
    const form =
      root.closest("section")?.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]');
    const value = form?.querySelector('[name="id"]')?.value;
    return value && /^\d+$/.test(value)
      ? `gid://shopify/ProductVariant/${value}`
      : root.dataset.currentVariantId;
  }

  function setStatus(root, message, error = false) {
    const status = root.querySelector("[data-zakeke-status]");
    status.textContent = message;
    status.dataset.error = String(error);
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
        body?.error?.message || "The customization request failed.",
      );
    }
    return body.data;
  }

  function openDesigner(root, intent) {
    const selectedVariant = variantId(root);
    if (!selectedVariant) {
      setStatus(root, "Choose an available product option first.", true);
      return;
    }
    const url = new URL("/apps/customhouse/zakeke/designer", location.origin);
    url.searchParams.set("product_id", root.dataset.productId);
    url.searchParams.set("variant_id", selectedVariant);
    url.searchParams.set("intent", intent);
    location.assign(url.toString());
  }

  async function addFixedDesign(root, button, designId) {
    const selectedVariant = variantId(root);
    if (!selectedVariant) {
      setStatus(root, "Choose an available product option first.", true);
      return;
    }
    button.disabled = true;
    setStatus(root, "Preparing this fixed creator design…");
    try {
      const data = await json(
        `${endpoint}/creator-designs/${encodeURIComponent(designId)}/purchase`,
        {
          method: "POST",
          body: JSON.stringify({
            variantId: selectedVariant,
            quantity: Number(
              document.querySelector('form[action*="/cart/add"] [name="quantity"]')
                ?.value || 1,
            ),
            idempotencyKey:
              crypto.randomUUID?.().replaceAll("-", "") ||
              `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          }),
        },
      );
      const cart = await fetch("/cart/add.js", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: [data.cart] }),
      });
      if (!cart.ok) throw new Error("The product could not be added to cart.");
      location.assign("/cart");
    } catch (error) {
      setStatus(
        root,
        error instanceof Error
          ? error.message
          : "The creator design could not be added to cart.",
        true,
      );
      button.disabled = false;
    }
  }

  document.querySelectorAll("[data-customhouse-zakeke]").forEach(async (root) => {
    try {
      const query = new URLSearchParams({
        product_id: root.dataset.productId,
        product_type: root.dataset.productType,
      });
      const data = await json(`${endpoint}/eligibility?${query}`);
      if (data.productType === "creator_fixed") {
        if (!data.fixedPurchaseAvailable || !data.design) {
          setStatus(root, "This creator design is not available for purchase.");
          return;
        }
        root.querySelector("[data-zakeke-creator-byline]").hidden = false;
        root.querySelector(
          "[data-zakeke-creator-byline]",
        ).textContent = `Designed by ${data.design.creator.displayName}`;
        const collection = root.querySelector("[data-zakeke-collection]");
        collection.hidden = !data.collectionUrl;
        if (data.collectionUrl) collection.href = data.collectionUrl;
        const button = root.querySelector("[data-zakeke-fixed-purchase]");
        button.hidden = false;
        button.addEventListener("click", () =>
          addFixedDesign(root, button, data.design.id),
        );
        setStatus(root, "Artwork is fixed and cannot be edited.");
        return;
      }
      root.querySelector("[data-zakeke-global-actions]").hidden = false;
      root
        .querySelector("[data-zakeke-customer]")
        .addEventListener("click", () => openDesigner(root, "customer"));
      const creator = root.querySelector("[data-zakeke-creator]");
      creator.hidden = !data.creatorPublishAvailable;
      if (!creator.hidden) {
        root.querySelector("[data-zakeke-customer]").textContent =
          "Customize & Buy";
        creator.addEventListener("click", () => openDesigner(root, "creator"));
      }
      setStatus(
        root,
        data.creatorPublishAvailable
          ? "Choose personal purchase or publish to your creator collection."
          : "Customize this product and add it to your cart.",
      );
    } catch (error) {
      setStatus(
        root,
        error instanceof Error
          ? error.message
          : "Customization is unavailable.",
        true,
      );
    }
  });
})();

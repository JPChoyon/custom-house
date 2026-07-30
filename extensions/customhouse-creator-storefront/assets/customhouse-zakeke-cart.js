(() => {
  const privateNames = new Set([
    "_custom_house_mode",
    "_custom_house_design_id",
    "_custom_house_purchase_id",
    "_custom_house_design_token",
    "_custom_house_creator_design_id",
    "_custom_house_zakeke_design_id",
    "_custom_house_purchase_token",
  ]);

  const hide = () => {
    document
      .querySelectorAll(
        "[data-cart-item-property], .product-option, .cart-item__property, dt",
      )
      .forEach((node) => {
        const text = node.textContent?.trim().split(":")[0] || "";
        if (!privateNames.has(text)) return;
        const row = node.closest(
          "[data-cart-item-property], .product-option, dl > div",
        );
        (row || node).hidden = true;
      });
  };

  hide();
  new MutationObserver(hide).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();

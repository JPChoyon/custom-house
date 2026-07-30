function scriptJson(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function zakekeDesignerHtml(input: {
  customizerScriptUrl: string;
  sessionToken: string;
  tokenOauth: string;
  mode: "CUSTOMER_BUY" | "CREATOR_PUBLISH";
  product: {
    id: string;
    title: string;
    price: number;
    attributes: Record<string, string>;
  };
}) {
  const attributePairs = Object.entries(input.product.attributes);
  const attributes = attributePairs.map(([code, value]) => ({
    code,
    label: code,
    values: [{ code: value, label: value }],
  }));
  const variants = [
    attributePairs.map(([code, value]) => ({
      code,
      value: { code: value },
    })),
  ];
  const publicConfig = {
    sessionToken: input.sessionToken,
    mode: input.mode,
    product: input.product,
    attributes: { attributes, variants },
  };
  const modeLabel =
    input.mode === "CREATOR_PUBLISH"
      ? "Create for My Collection"
      : "Customize & Buy";
  const cartLabel =
    input.mode === "CREATOR_PUBLISH"
      ? "Add to My Collection"
      : "Add to Cart";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(modeLabel)} · Custom House</title>
  <style>
    :root{color-scheme:light;--ink:#111827;--muted:#64748b;--brand:#6d28d9;--line:#e2e8f0}
    *{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:#f8fafc}
    .shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr}.bar{display:flex;align-items:center;gap:16px;padding:14px 20px;background:#fff;border-bottom:1px solid var(--line)}
    .back{appearance:none;border:1px solid var(--line);background:#fff;border-radius:999px;padding:9px 14px;cursor:pointer}.title{min-width:0;flex:1}.title strong,.title span{display:block}.title span{color:var(--muted);font-size:13px;margin-top:2px}.mode{background:#ede9fe;color:#5b21b6;padding:7px 11px;border-radius:999px;font-size:13px;font-weight:700}
    .publish{display:${input.mode === "CREATOR_PUBLISH" ? "grid" : "none"};grid-template-columns:minmax(180px,320px) minmax(240px,1fr);gap:10px;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line)}
    .publish input,.publish textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}.publish textarea{min-height:42px;resize:vertical}
    #zakeke-container{min-height:calc(100vh - 76px);background:#fff}.status{position:fixed;z-index:20;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(90vw,680px);padding:12px 16px;border-radius:12px;background:#111827;color:#fff;box-shadow:0 10px 30px #0f172a33}.status[hidden]{display:none}.status.error{background:#991b1b}
    @media(max-width:700px){.bar{align-items:flex-start;flex-wrap:wrap}.mode{order:3}.publish{grid-template-columns:1fr}.title{min-width:170px}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="bar">
      <button class="back" type="button" id="back-button">Back to product</button>
      <div class="title"><strong>${escapeHtml(
        input.product.title,
      )}</strong><span>Custom House Creator Marketplace</span></div>
      <span class="mode">${escapeHtml(modeLabel)}</span>
    </header>
    <section class="publish" aria-label="Creator publish details">
      <input id="design-title" maxlength="120" placeholder="Design title" value="My creator design">
      <textarea id="design-description" maxlength="2000" placeholder="Short product description (optional)"></textarea>
    </section>
    <div id="zakeke-container" aria-live="polite"></div>
  </main>
  <div class="status" id="status">Loading secure designer…</div>
  <script>window.__CUSTOM_HOUSE_ZAKEKE__=${scriptJson(publicConfig)};</script>
  <script src="${escapeHtml(input.customizerScriptUrl)}"></script>
  <script>
  (() => {
    const state = window.__CUSTOM_HOUSE_ZAKEKE__;
    const status = document.getElementById("status");
    const show = (message, error = false) => {
      status.hidden = false;
      status.textContent = message;
      status.classList.toggle("error", error);
    };
    document.getElementById("back-button").addEventListener("click", () => history.back());
    if (typeof window.ZakekeDesigner !== "function") {
      show("The Zakeke designer is unavailable. Please try again.", true);
      return;
    }
    const complete = async (payload) => {
      show(state.mode === "CREATOR_PUBLISH" ? "Publishing your design…" : "Preparing your cart…");
      const response = await fetch("/apps/customhouse/api/zakeke/callback", {
        method: "POST",
        credentials: "same-origin",
        headers: {"Content-Type":"application/json","Accept":"application/json"},
        body: JSON.stringify({
          sessionToken: state.sessionToken,
          designId: payload.designId,
          quantity: payload.quantity || 1,
          selectedAttributes: payload.selectedattributes || [],
          title: document.getElementById("design-title")?.value || "",
          description: document.getElementById("design-description")?.value || ""
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        throw new Error(body?.error?.message || "The design could not be completed.");
      }
      if (state.mode === "CREATOR_PUBLISH") {
        show("Your design has been added to your collection.");
        return { url: body.data.productUrl || "/pages/creator-dashboard" };
      }
      const cartResponse = await fetch("/cart/add.js", {
        method: "POST",
        headers: {"Content-Type":"application/json","Accept":"application/json"},
        body: JSON.stringify({items:[body.data.cart]})
      });
      if (!cartResponse.ok) throw new Error("The customized product could not be added to cart.");
      window.location.assign("/cart");
      return { url: "/cart" };
    };
    const designer = new window.ZakekeDesigner();
    designer.createIframe({
      tokenOauth: ${scriptJson(input.tokenOauth)},
      productId: state.product.id,
      productName: state.product.title,
      quantity: 1,
      selectedattributes: state.product.attributes,
      cartButtonText: ${scriptJson(cartLabel)},
      isSaveDesign: state.mode === "CREATOR_PUBLISH",
      getProductInfo: (data) => ({
        price: state.product.price + Number(data?.price || 0),
        isOutOfStock: false
      }),
      getProductPrice: (data) => ({
        price: state.product.price + Number(data?.price || 0),
        isOutOfStock: false
      }),
      getProductAttribute: () => state.attributes,
      addToCart: (data) => complete(data).catch((error) => {
        show(error instanceof Error ? error.message : "The design could not be completed.", true);
        return {url: window.location.href};
      }),
      editAddToCart: (data) => complete(data).catch((error) => {
        show(error instanceof Error ? error.message : "The design could not be completed.", true);
        return {url: window.location.href};
      }),
      onBackClicked: () => history.back()
    });
    status.hidden = true;
  })();
  </script>
</body>
</html>`;
}

export function zakekeUnavailableHtml(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Customizer unavailable</title><style>body{font-family:system-ui;margin:0;background:#f8fafc;color:#111827}.card{max-width:680px;margin:10vh auto;background:white;border:1px solid #e2e8f0;border-radius:18px;padding:32px}.button{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:999px;background:#111827;color:white;text-decoration:none}</style></head><body><main class="card"><h1>Customizer unavailable</h1><p>${escapeHtml(
    message,
  )}</p><a class="button" href="/">Return to store</a></main></body></html>`;
}

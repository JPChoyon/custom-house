import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type PublicContract = {
  buildCartSelectionContract(input: {
    value?: Record<string, unknown>;
    source?: Record<string, unknown>;
    snapshot?: Record<string, unknown> | null;
    config: Record<string, unknown>;
  }): {
    selections: Array<Record<string, unknown>>;
    selectionCount: number;
    totalQuantity: number;
  };
};

const configuredVariants = [
  {
    variantId: "101",
    variantGid: "gid://shopify/ProductVariant/101",
    color: "Green",
    size: "M",
    available: true,
  },
  {
    variantId: "102",
    variantGid: "gid://shopify/ProductVariant/102",
    color: "Green",
    size: "L",
    available: true,
  },
];

function loadContract(): PublicContract {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(
    readFileSync(
      "theme-live-cart/assets/customhouse-pitchprint-public-contract.js",
      "utf8",
    ),
    sandbox,
  );
  return sandbox.CustomHousePublicPitchPrintContract as PublicContract;
}

test("canonical public cart selections supersede an invalid legacy snapshot", () => {
  const contract = loadContract();
  const result = contract.buildCartSelectionContract({
    value: {
      variantSelections: [
        { variantId: "101", color: "Green", size: "M", quantity: 1 },
        { variantId: "102", color: "Green", size: "L", quantity: 1 },
      ],
    },
    snapshot: { variantId: 0, quantity: 0 },
    config: { variants: configuredVariants, colors: ["Green"], sizes: ["M", "L"] },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    selections: [
      {
        variantId: "101",
        variantGid: "gid://shopify/ProductVariant/101",
        color: "Green",
        size: "M",
        quantity: 1,
      },
      {
        variantId: "102",
        variantGid: "gid://shopify/ProductVariant/102",
        color: "Green",
        size: "L",
        quantity: 1,
      },
    ],
    selectionCount: 2,
    totalQuantity: 2,
  });
});

test("legacy single-variant fallback remains available only when canonical selections are absent", () => {
  const contract = loadContract();
  const result = contract.buildCartSelectionContract({
    value: {},
    snapshot: { variantId: 101, quantity: 2 },
    config: { variants: configuredVariants, colors: ["Green"], sizes: ["M", "L"] },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    selections: [
      {
        variantId: "101",
        variantGid: "gid://shopify/ProductVariant/101",
        color: "Green",
        size: "M",
        quantity: 2,
      },
    ],
    selectionCount: 1,
    totalQuantity: 2,
  });
});

test("the same nested source selections are not counted twice", () => {
  const contract = loadContract();
  const source = {
    variantSelections: [
      { variantId: "101", color: "Green", size: "M", quantity: 1 },
      { variantId: "102", color: "Green", size: "L", quantity: 1 },
    ],
  };
  const result = contract.buildCartSelectionContract({
    value: { source },
    source,
    snapshot: { variantId: 101, quantity: 1 },
    config: { variants: configuredVariants, colors: ["Green"], sizes: ["M", "L"] },
  });

  assert.equal(result.selectionCount, 2);
  assert.equal(result.totalQuantity, 2);
});

type BridgeHarness = {
  dispatchMessage(event: Record<string, unknown>): void;
  emitClient(eventName: string, data: Record<string, unknown>): void;
  flush(): Promise<void>;
  requests: Array<{ url: string; payload: Record<string, unknown> }>;
  acknowledgements: Array<Record<string, unknown>>;
  clientFires: Array<{ eventName: string; data: Record<string, unknown> }>;
  location: { href: string; origin: string };
  logs: Array<{ level: string; message: string; detail?: unknown }>;
};

function bridgeHarness(): BridgeHarness {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const requests: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const acknowledgements: Array<Record<string, unknown>> = [];
  const clientFires: Array<{ eventName: string; data: Record<string, unknown> }> = [];
  const clientListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const logs: Array<{ level: string; message: string; detail?: unknown }> = [];
  const status = { textContent: "", hidden: true, classList: { toggle() {} } };
  const pricing = {
    version: 1,
    currency: "SEK",
    productionMethodPricing: {
      EMBROIDERY: {
        label: "Embroidery",
        surchargeMinor: 0,
        embroiderySubtypes: {
          TEXT_ONLY: {
            label: "Embroidery — Text only",
            surchargeMinor: 1000,
            feeVariantId: "9004",
          },
          IMAGE_OR_LOGO: {
            label: "Embroidery — Image / Logo",
            surchargeMinor: 30000,
            feeVariantId: "9005",
          },
        },
      },
      DTF: { label: "DTF", surchargeMinor: 2000, feeVariantId: "9002" },
      DTG: { label: "DTG", surchargeMinor: 3000, feeVariantId: "9003" },
    },
  };
  const form = {
    querySelector(selector: string) {
      if (selector === 'input[name="id"]') return { value: "101" };
      if (selector.includes('input[name="quantity"]')) return { value: "1" };
      return null;
    },
  };
  const actions = {
    dataset: {
      customhousePitchprintRequired: "true",
      productId: "gid://shopify/Product/100",
      productHandle: "t-shirt",
      productTitle: "T-shirt",
      productOptionNames: JSON.stringify(["Color", "Size"]),
      productVariants: JSON.stringify([
        { id: 101, title: "Green / M", available: true, price: 10000, options: ["Green", "M"] },
        { id: 102, title: "Green / L", available: true, price: 10000, options: ["Green", "L"] },
      ]),
      sizeOptionPosition: "2",
      colorOptionPosition: "1",
      currency: "SEK",
      initialVariantId: "101",
      initialQuantity: "1",
    },
    querySelector(selector: string) {
      if (selector === 'form[data-customhouse-pitchprint-form="true"]') return form;
      if (selector === "[data-customhouse-production-pricing-json]") {
        return { textContent: JSON.stringify(pricing) };
      }
      return null;
    },
  };
  const root = {
    querySelector(selector: string) {
      if (selector === "[data-marked-product-actions]") return actions;
      if (selector === 'form[data-customhouse-pitchprint-form="true"]') return form;
      if (selector === "[data-cart-status]") return status;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const location = { href: "https://customhouse.se/products/t-shirt", origin: "https://customhouse.se" };

  class FakeXmlHttpRequest {
    status = 0;
    responseText = "";
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    timeout = 0;
    url = "";
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body: string) {
      const payload = JSON.parse(body) as Record<string, unknown>;
      requests.push({ url: this.url, payload });
      if (this.url.includes("public-production-cart")) {
        this.status = 200;
        this.responseText = JSON.stringify({
          ok: true,
          data: {
            items: [
              { id: "101", quantity: 1, properties: { _customhouse_fee_key: "fee-key" } },
              { id: "102", quantity: 1, properties: { _customhouse_fee_key: "fee-key" } },
              {
                id: "9005",
                quantity: 2,
                properties: {
                  _customhouse_fee_key: "fee-key",
                  _customhouse_production_fee: "true",
                },
              },
            ],
          },
        });
      } else {
        this.status = 200;
        this.responseText = JSON.stringify({ items: [] });
      }
      queueMicrotask(() => this.onload?.());
    }
  }

  const windowObject: Record<string, unknown> & {
    __customHousePitchPrintOrderHandoffState?: { snapshot: unknown };
  } = {
    location,
    Shopify: { routes: { root: "/" } },
    ppclient: {
      vars: { designId: "base_design_123", projectId: "" },
      on(eventName: string, listener: (event: Record<string, unknown>) => void) {
        clientListeners.set(eventName, [...(clientListeners.get(eventName) || []), listener]);
      },
      fire(eventName: string, data: Record<string, unknown>) {
        clientFires.push({ eventName, data });
      },
    },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
  };
  const documentObject = {
    querySelector(selector: string) {
      return selector === '[data-customhouse-pitchprint-required="true"]' ? root : null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-customhouse-pitchprint-required="true"]' ? [root] : [];
    },
    addEventListener() {},
  };
  const sandbox: Record<string, unknown> = {
    window: windowObject,
    document: documentObject,
    XMLHttpRequest: FakeXmlHttpRequest,
    URL,
    Intl,
    Map,
    Set,
    Element: class {},
    requestAnimationFrame(callback: () => void) { callback(); },
    queueMicrotask,
    console: {
      log(message: string, detail?: unknown) { logs.push({ level: "log", message, detail }); },
      warn(message: string, detail?: unknown) { logs.push({ level: "warn", message, detail }); },
    },
  };
  vm.runInNewContext(
    readFileSync("theme-live-cart/assets/customhouse-pitchprint-public-contract.js", "utf8"),
    sandbox,
  );
  vm.runInNewContext(
    readFileSync("theme-live-cart/assets/customhouse-pitchprint-order-handoff.js", "utf8"),
    sandbox,
  );
  windowObject.__customHousePitchPrintOrderHandoffState!.snapshot = {
    root,
    form,
    variantId: 0,
    quantity: 0,
    productId: "gid://shopify/Product/100",
  };

  return {
    dispatchMessage(event) {
      for (const listener of listeners.get("message") || []) listener(event);
    },
    emitClient(eventName, data) {
      for (const listener of clientListeners.get(eventName) || []) {
        listener({ type: eventName, data });
      }
    },
    async flush() {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    },
    requests,
    acknowledgements,
    clientFires,
    location,
    logs,
  };
}

test("allowed PitchPrint cart-ready message atomically adds all prepared lines, acknowledges, and redirects", async () => {
  const harness = bridgeHarness();
  const source = {
    postMessage(message: Record<string, unknown>) {
      harness.acknowledgements.push(message);
    },
  };
  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source,
    data: {
      type: "CUSTOMHOUSE_PP_CART_READY",
      payload: {
        projectId: "project_123",
        designId: "design_123",
        productionMethod: "EMBROIDERY",
        artworkType: "IMAGE_OR_LOGO",
        embroiderySubtype: "IMAGE_OR_LOGO",
        placementCount: 1,
        totalQuantity: 2,
        legalConfirmations: { rightsAccepted: true, termsAccepted: true },
        artworkSource: { pages: [{ name: "Front", objects: [{ type: "image" }] }] },
        variantSelections: [
          { variantId: "101", color: "Green", size: "M", quantity: 1 },
          { variantId: "102", color: "Green", size: "L", quantity: 1 },
        ],
      },
    },
  });
  await harness.flush();

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0]?.url, "/apps/customhouse/api/public-production-cart");
  assert.deepEqual(
    (harness.requests[0]?.payload.variantSelections as Array<Record<string, unknown>>).map(({ variantId, quantity }) => ({ variantId, quantity })),
    [
      { variantId: "101", quantity: 1 },
      { variantId: "102", quantity: 1 },
    ],
  );
  assert.deepEqual(
    (harness.requests[1]?.payload.items as Array<Record<string, unknown>>).map(({ id, quantity }) => ({ id, quantity })),
    [
      { id: "101", quantity: 1 },
      { id: "102", quantity: 1 },
      { id: "9005", quantity: 2 },
    ],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(harness.acknowledgements)), [
    {
      type: "CUSTOMHOUSE_PP_CART_READY_ACK",
      payload: { ok: true, projectId: "project_123" },
    },
  ]);
  assert.equal(harness.location.href, "/cart");
});

test("foreign cart-ready postMessage cannot mutate the Shopify cart", async () => {
  const harness = bridgeHarness();
  harness.dispatchMessage({
    origin: "https://malicious.example",
    source: { postMessage() {} },
    data: { type: "CUSTOMHOUSE_PP_CART_READY", payload: { projectId: "attack" } },
  });
  await harness.flush();

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.location.href, "https://customhouse.se/products/t-shirt");
});

test("new public design config exposes explicit save-on-continue identity", () => {
  const harness = bridgeHarness();
  const messages: Array<Record<string, unknown>> = [];
  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source: {
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    },
    data: { type: "CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST" },
  });

  const response = messages[0] as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  assert.equal(response.type, "CUSTOMHOUSE_PP_ORDER_CONFIG_DATA");
  assert.equal(response.payload?.projectIdentityMode, "SAVE_ON_CONTINUE");
  assert.equal(
    response.payload?.pitchprintProjectId,
    "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
  );
  assert.equal(
    response.payload?.pitchprintDesignId,
    "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
  );
});

test("new public design saves first, then adds real PitchPrint identity to cart", async () => {
  const harness = bridgeHarness();
  const source = {
    postMessage(message: Record<string, unknown>) {
      harness.acknowledgements.push(message);
    },
  };

  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source,
    data: {
      type: "CUSTOMHOUSE_PP_CART_READY",
      payload: {
        projectId: "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
        designId: "base_design_123",
        productionMethod: "EMBROIDERY",
        artworkType: "IMAGE_OR_LOGO",
        embroiderySubtype: "IMAGE_OR_LOGO",
        placementCount: 1,
        totalQuantity: 1,
        legalConfirmations: { rightsAccepted: true, termsAccepted: true },
        artworkSource: { pages: [{ name: "Front", objects: [{ type: "image" }] }] },
        variantSelections: [
          { variantId: "101", color: "Green", size: "M", quantity: 1 },
        ],
      },
    },
  });
  await harness.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(harness.clientFires)), [
    { eventName: "start-save", data: {} },
  ]);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.acknowledgements.length, 0);

  harness.emitClient("project-saved", {
    projectId: "project_real_123",
    designId: "design_real_123",
    previews: ["https://pitchprint.io/previews/project_real_123_1.jpg"],
    source: {
      designId: "design_real_123",
      pages: [{ name: "Front", objects: [{ type: "image" }] }],
    },
  });
  await harness.flush();

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0]?.payload.pitchprintProjectId, "project_real_123");
  assert.equal(harness.requests[0]?.payload.pitchprintDesignId, "design_real_123");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.acknowledgements)), [
    {
      type: "CUSTOMHOUSE_PP_CART_READY_ACK",
      payload: { ok: true, projectId: "project_real_123" },
    },
  ]);
  assert.equal(harness.location.href, "/cart");
});

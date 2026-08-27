(() => {
  const state = window.__customHousePitchPrintOrderHandoffState = window.__customHousePitchPrintOrderHandoffState || {
    initialized: false,
    listenerBound: false,
    propertyHookInstalled: false,
    propertyHookUnavailable: false,
    snapshot: null,
    config: null,
    inFlight: false,
    handledProjects: new Set(),
  };

  if (!(state.handledProjects instanceof Set)) state.handledProjects = new Set();
  if (state.initialized) return;
  state.initialized = true;

  const rootSelector = '[data-customhouse-pitchprint-required="true"]';
  const triggerSelector = '[data-pitchprint-customize-trigger]';
  const formSelector = 'form[data-customhouse-pitchprint-form="true"]';
  const log = (message, detail) => {
    if (detail) {
      console.log(`[CustomHouse PitchPrint] ${message}`, detail);
    } else {
      console.log(`[CustomHouse PitchPrint] ${message}`);
    }
  };
  const warn = (message) => console.warn(`[CustomHouse PitchPrint] ${message}`);

  const route = (path) => {
    const root = window.Shopify?.routes?.root || '/';
    return root.replace(/\/?$/, '/') + String(path || '').replace(/^\//, '');
  };

  const setStatus = (root, message = '', isError = false) => {
    const status = root?.querySelector?.('[data-cart-status]');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !message;
  };

  const validUrl = (value) => {
    const url = String(value || '').trim();
    if (!/^https?:\/\//i.test(url)) return '';
    try {
      const parsed = new URL(url);
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  };

  const previewFrom = (value) => {
    const direct = validUrl(value);
    if (direct || !value || typeof value !== 'object') return direct;
    for (const key of ['url', 'src', 'preview', 'image']) {
      const found = validUrl(value[key]);
      if (found) return found;
    }
    return '';
  };

  const firstPreviewUrl = (previews) => {
    for (const preview of (Array.isArray(previews) ? previews : [previews])) {
      const found = previewFrom(preview);
      if (found) return found;
    }
    return '';
  };

  const getRootProductId = (root) => String(root?.querySelector?.('[data-marked-product-actions]')?.dataset.productId || '').trim();

  const METHOD_DETAILS = {
    EMBROIDERY: {
      id: 'embroidery',
      label: 'Embroidery',
      maxWidthCm: 8,
      maxHeightCm: 8,
    },
    DTF: {
      id: 'dtf',
      label: 'DTF printing',
      maxWidthCm: 35,
      maxHeightCm: 40,
    },
    DTG: {
      id: 'dtg',
      label: 'DTG printing',
      maxWidthCm: 35,
      maxHeightCm: 40,
    },
  };

  const parseJson = (value, fallback = null) => {
    try {
      return JSON.parse(value || '');
    } catch {
      return fallback;
    }
  };

  const normalizeVariantId = (value) => {
    const text = String(value || '').trim();
    const match = text.match(/(\d+)$/);
    return match ? match[1] : text;
  };

  const optionValues = (actions, position, selector) => {
    if (!Number.isFinite(position) || position <= 0) return [];
    const values = Array.from(actions.querySelectorAll(selector))
      .map((element) => String(element.dataset.colorOptionValue || element.dataset.sizeOptionValue || '').trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  };

  const selectedVariantId = (actions) => {
    const form = actions?.querySelector?.(formSelector);
    return String(
      form?.querySelector?.('input[name="id"]')?.value ||
      actions?.dataset.initialVariantId ||
      ''
    ).trim();
  };

  const selectedQuantity = (actions) => {
    const form = actions?.querySelector?.(formSelector);
    const quantityInput = form?.querySelector?.('input[name="quantity"]') || actions?.querySelector?.('.marked-product-actions__qty-input[name="quantity"]');
    const quantity = Number(quantityInput?.value || actions?.dataset.initialQuantity || 1);
    return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  };

  const normalizeProductionMethods = (pricing) => {
    const methods = pricing?.productionMethodPricing || {};
    return Object.keys(METHOD_DETAILS).map((code) => {
      const detail = METHOD_DETAILS[code];
      const configured = methods[code] || (Array.isArray(pricing?.productionMethods)
        ? pricing.productionMethods.find((method) => String(method?.id || '').toUpperCase() === code)
        : null);
      const surchargeMinor = Number(configured?.surchargeMinor || 0);
      return {
        id: detail.id,
        label: detail.label,
        surchargeMinor: Number.isFinite(surchargeMinor) && surchargeMinor > 0 ? Math.round(surchargeMinor) : 0,
        maxWidthCm: detail.maxWidthCm,
        maxHeightCm: detail.maxHeightCm,
      };
    });
  };

  const buildProductConfig = (root) => {
    const actions = root?.querySelector?.('[data-marked-product-actions]');
    if (!actions || actions.dataset.customhousePitchprintRequired !== 'true') return null;

    const rawPricing = actions.querySelector('[data-customhouse-production-pricing-json]')?.textContent || '';
    const pricing = parseJson(rawPricing, null);
    const productionMethods = normalizeProductionMethods(pricing);
    if (!productionMethods.some((method) => method.surchargeMinor > 0)) return null;

    const variants = parseJson(actions.dataset.productVariants, []).map((variant) => ({
      id: normalizeVariantId(variant.id),
      gid: String(variant.admin_graphql_api_id || variant.gid || ''),
      title: variant.title || '',
      price: variant.price,
      priceMinor: Number(variant.price || 0),
      available: variant.available !== false,
      options: Array.isArray(variant.options) ? variant.options : [variant.option1, variant.option2, variant.option3].filter(Boolean),
    }));
    const sizePosition = Number(actions.dataset.sizeOptionPosition || 0);
    const colorPosition = Number(actions.dataset.colorOptionPosition || 0);

    return {
      version: 1,
      productId: String(actions.dataset.productId || ''),
      productHandle: String(actions.dataset.productHandle || ''),
      productTitle: String(actions.dataset.productTitle || ''),
      currency: String(pricing?.currency || actions.dataset.currency || 'SEK').toUpperCase(),
      variants,
      colors: optionValues(actions, colorPosition, '[data-color-option-value]'),
      sizes: optionValues(actions, sizePosition, '[data-size-option-value]'),
      selectedColor: String(actions.dataset.selectedColor || ''),
      selectedSize: String(actions.dataset.selectedSize || ''),
      initialVariantId: selectedVariantId(actions),
      initialQuantity: selectedQuantity(actions),
      productionMethods,
      productionMethodPricing: Object.fromEntries(
        productionMethods.map((method) => [
          method.id,
          {
            label: method.label,
            surchargeMinor: method.surchargeMinor,
            maxWidthCm: method.maxWidthCm,
            maxHeightCm: method.maxHeightCm,
          },
        ])
      ),
    };
  };

  const refreshPublicConfig = () => {
    const root = document.querySelector(rootSelector);
    const config = buildProductConfig(root);
    if (!config) return null;
    state.config = config;
    window.CustomHousePublicPitchPrintConfig = config;
    log('Public PitchPrint config ready', {
      productId: config.productId,
      productionMethods: config.productionMethods.map((method) => ({
        id: method.id,
        surchargeMinor: method.surchargeMinor,
      })),
    });
    return config;
  };

  const respondWithProductConfig = (targetWindow) => {
    const config = refreshPublicConfig();
    if (!config || !targetWindow || typeof targetWindow.postMessage !== 'function') return false;
    targetWindow.postMessage({
      type: 'CUSTOMHOUSE_PP_ORDER_CONFIG_DATA',
      payload: config,
    }, '*');
    return true;
  };

  const captureSnapshotFromRoot = (root, message = 'Variant snapshot', triggerMatched = false) => {
    const form = root?.querySelector?.(formSelector);
    const variantInput = form?.querySelector?.('input[name="id"]');
    const variantId = Number(variantInput?.value || 0);
    const quantityInput = form?.querySelector?.('input[name="quantity"]') || root?.querySelector?.('.marked-product-actions__qty-input[name="quantity"]');
    const quantity = Math.max(1, Number(quantityInput?.value || 1));
    const detail = {
      variantId,
      quantity,
      triggerMatched,
      formMatched: Boolean(form),
    };

    if (!root || !form || !Number.isFinite(variantId) || variantId <= 0 || !Number.isFinite(quantity)) {
      warn('Missing snapshot');
      setStatus(root, 'Please select a valid product option before customizing.', true);
      return null;
    }

    state.snapshot = { root, form, variantId, quantity, productId: getRootProductId(root) };
    log(message, detail);
    setStatus(root, '', false);
    return state.snapshot;
  };

  const recoverSnapshotAtProjectSave = (source, value) => {
    const pitchPrintProductId = String(source.productId || source.product?.id || value.productId || '').trim();
    const roots = Array.from(document.querySelectorAll(rootSelector));
    let matchedRoots = [];

    if (pitchPrintProductId) {
      matchedRoots = roots.filter((root) => getRootProductId(root) === pitchPrintProductId);
    }

    if (matchedRoots.length !== 1) {
      matchedRoots = roots.length === 1 && roots[0].querySelectorAll(formSelector).length === 1 ? roots : [];
    }

    if (matchedRoots.length !== 1) return null;
    return captureSnapshotFromRoot(matchedRoots[0], 'Snapshot recovered at project save', false);
  };

  async function addProjectToCart(projectId, previewUrl) {
  const snapshot = state.snapshot;
  const root = snapshot?.root;

  if (!snapshot) {
    warn('Missing snapshot');
    return;
  }

  const variantId = Number(snapshot.variantId);
  const quantity = Number(snapshot.quantity);

  if (
    !Number.isFinite(variantId) ||
    variantId <= 0 ||
    !Number.isFinite(quantity) ||
    quantity < 1
  ) {
    warn('Invalid variant');
    setStatus(
      root,
      'Please select a valid product option before customizing.',
      true
    );
    return;
  }

  if (state.inFlight) {
    warn('Request already in flight');
    return;
  }

  if (state.handledProjects.has(projectId)) {
    warn('Project already handled');
    return;
  }

  const properties = {
    _pitchprint: projectId,
  };

  if (previewUrl) {
    properties._pitchprint_preview = previewUrl;
  }

  const payload = {
    items: [
      {
        id: variantId,
        quantity,
        properties,
      },
    ],
  };

  state.inFlight = true;

  log('Cart add started');

  setStatus(
    root,
    'Adding your custom product to the cart...',
    false
  );

  try {
    await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();

      request.open(
        'POST',
        route('cart/add.js'),
        true
      );

      request.withCredentials = true;

      request.setRequestHeader(
        'Accept',
        'application/json'
      );

      request.setRequestHeader(
        'Content-Type',
        'application/json'
      );

      request.onload = () => {
        if (
          request.status >= 200 &&
          request.status < 300
        ) {
          resolve();
          return;
        }

        let message =
          `Shopify cart request failed with status ${request.status}`;

        try {
          const responseData = JSON.parse(
            request.responseText || '{}'
          );

          message =
            responseData?.description ||
            responseData?.message ||
            message;
        } catch (_) {
          // Keep the default safe error message.
        }

        const error = new Error(message);
        error.status = request.status;

        reject(error);
      };

      request.onerror = () => {
        const error = new Error(
          'A network error occurred while adding the customized product.'
        );

        error.status = request.status || 0;

        reject(error);
      };

      request.ontimeout = () => {
        const error = new Error(
          'The cart request timed out. Please try again.'
        );

        error.status = 0;

        reject(error);
      };

      request.timeout = 20000;
      request.send(JSON.stringify(payload));
    });
  } catch (error) {
    state.inFlight = false;

    console.warn(
      '[CustomHouse PitchPrint] Cart add failed',
      {
        status: error?.status,
        message: error?.message || 'request failed',
      }
    );

    setStatus(
      root,
      'We could not add your custom product to the cart. Please try again.',
      true
    );

    return;
  }

  // The Shopify request has definitely succeeded at this point.
  state.handledProjects.add(projectId);
  state.inFlight = false;

  log('Cart add succeeded');
  setStatus(root, '', false);

  // Keep navigation outside the request error boundary.
  window.location.href = route('cart');
}

  function handleProjectSaved(event) {
    log('Project saved');
    const message = event?.data ?? event ?? {};
    const value = message?.value ?? message ?? {};
    const source = value?.source ?? {};
    const projectId = String(source.projectId || value.projectId || '').trim();

    if (!state.snapshot && !recoverSnapshotAtProjectSave(source, value)) {
      warn('Missing snapshot');
      setStatus(state.snapshot?.root, 'Please customize this product again before adding it to the cart.', true);
      return;
    }

    if (!projectId) {
      warn('Missing project ID');
      setStatus(state.snapshot?.root, 'We could not receive your saved design. Please try submitting it again.', true);
      return;
    }

    addProjectToCart(projectId, firstPreviewUrl(value.previews));
  }

  function bindPitchPrintClient(client) {
    if (state.listenerBound) return true;
    if (!client || typeof client.on !== 'function') return false;

    try {
      client.on('project-saved', handleProjectSaved);
      state.listenerBound = true;
      setStatus(state.snapshot?.root, '', false);
      log('Listener bound');
      return true;
    } catch (error) {
      warn(`Client unavailable: ${error?.message || 'listener registration failed'}`);
      return false;
    }
  }

  function installPitchPrintClientHook() {
    if (state.propertyHookInstalled || state.listenerBound) return;

    const descriptor = Object.getOwnPropertyDescriptor(window, 'ppclient');
    if (descriptor && descriptor.configurable === false) {
      state.propertyHookUnavailable = true;
      warn('Client unavailable');
      return;
    }

    let storedValue = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    const readValue = () => descriptor?.get ? descriptor.get.call(window) : storedValue;

    state.propertyHookInstalled = true;
    Object.defineProperty(window, 'ppclient', {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : true,
      get() {
        return readValue();
      },
      set(value) {
        if (descriptor?.set) {
          descriptor.set.call(window, value);
        } else if (!descriptor || descriptor.writable !== false) {
          storedValue = value;
        }
        bindPitchPrintClient(value);
      },
    });

    bindPitchPrintClient(readValue());
  }

  function ensurePitchPrintListener() {
    if (state.listenerBound) return true;
    if (bindPitchPrintClient(window.ppclient)) return true;
    installPitchPrintClientHook();
    return state.listenerBound;
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest(triggerSelector)?.closest?.(rootSelector);
    if (!root) return;

    captureSnapshotFromRoot(root, 'Variant snapshot', true);
    if (!ensurePitchPrintListener() && state.propertyHookUnavailable) {
      requestAnimationFrame(ensurePitchPrintListener);
    }
  }, true);

  window.addEventListener('message', (event) => {
    const message = event?.data || {};
    if (message?.type !== 'CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST') return;
    respondWithProductConfig(event.source);
  });

  window.addEventListener('customhouse:pitchprint-order-config-request', (event) => {
    const detail = event?.detail || {};
    const targetWindow = detail.contentWindow || detail.source || detail.iframe?.contentWindow || detail.targetWindow || null;
    respondWithProductConfig(targetWindow);
  });

  log('Initialized');
  refreshPublicConfig();
  ensurePitchPrintListener();
})();

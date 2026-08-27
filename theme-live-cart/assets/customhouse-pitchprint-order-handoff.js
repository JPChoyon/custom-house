(() => {
  const state = window.__customHousePitchPrintOrderHandoffState = window.__customHousePitchPrintOrderHandoffState || {
    initialized: false,
    listenerBound: false,
    propertyHookInstalled: false,
    propertyHookUnavailable: false,
    snapshot: null,
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

  const selectedProductionMethod = (root) => {
    const option = root?.querySelector?.('[data-production-method-option]:checked');
    return String(option?.value || '').trim();
  };

  const selectedVariantSelections = (snapshot) => {
    const variantId = Number(snapshot?.variantId || 0);
    const quantity = Math.max(1, Number(snapshot?.quantity || 1));
    return [{ variantId: String(variantId), quantity }];
  };

  const parseProductionPricing = (root) => {
    const source = root?.querySelector?.('[data-marked-product-actions]')?.dataset.productionMethodPricing || '';
    if (!source) return null;
    try {
      return JSON.parse(source);
    } catch {
      return null;
    }
  };

  const formatMinorMoney = (minor, currency) => {
    const amount = Number(minor || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'SEK',
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency || ''}`.trim();
    }
  };

  const updateProductionMethodDisplay = (root) => {
    const total = root?.querySelector?.('[data-production-method-total]');
    if (!total) return;
    const config = parseProductionPricing(root);
    const method = selectedProductionMethod(root);
    const methodConfig = config?.methods?.[method];
    if (!methodConfig) {
      total.textContent = '';
      return;
    }
    total.textContent = `Printing surcharge: ${formatMinorMoney(methodConfig.surchargeMinor, config.currency)} per item`;
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

    const productionMethod = selectedProductionMethod(root);
    if (!productionMethod) {
      warn('Missing production method');
      setStatus(root, 'Please choose a printing method before customizing.', true);
      return null;
    }

    state.snapshot = { root, form, variantId, quantity, productId: getRootProductId(root), productionMethod };
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

  state.inFlight = true;

  log('Cart add started');

  setStatus(
    root,
    'Adding your custom product to the cart...',
    false
  );

  try {
    const prepareResponse = await fetch(route('/apps/customhouse/api/public-production-cart'), {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        shopifyProductId: snapshot.productId,
        pitchprintProjectId: projectId,
        productionMethod: snapshot.productionMethod,
        selections: selectedVariantSelections(snapshot),
        previewUrl,
      }),
    });
    const prepared = await prepareResponse.json().catch(() => ({}));
    if (!prepareResponse.ok || !prepared?.data?.items) {
      throw new Error(
        prepared?.error?.message ||
        prepared?.message ||
        'Production pricing could not be prepared.'
      );
    }
    const payload = {
      items: prepared.data.items,
    };
    if (!payload.items.some((item) => item?.properties?._customhouse_fee_key)) {
      throw new Error('Production fee line is missing.');
    }
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

  document.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest?.('[data-production-method-option]')?.closest?.(rootSelector);
    if (!root) return;
    updateProductionMethodDisplay(root);
  });

  document.querySelectorAll(rootSelector).forEach(updateProductionMethodDisplay);

  log('Initialized');
  ensurePitchPrintListener();
})();

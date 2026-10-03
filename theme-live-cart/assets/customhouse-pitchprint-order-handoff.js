(() => {
  const state = window.__customHousePitchPrintOrderHandoffState = window.__customHousePitchPrintOrderHandoffState || {
    initialized: false,
    listenerBound: false,
    propertyHookInstalled: false,
    propertyHookUnavailable: false,
    snapshot: null,
    config: null,
    configRevision: '',
    acknowledgedRevision: '',
    loggedRevision: '',
    lastSaved: null,
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
  const publicContract = window.CustomHousePublicPitchPrintContract;

  if (!publicContract) {
    warn('Public customization contract unavailable');
    state.initialized = false;
    return;
  }

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

  const moneyFromMinor = (minor, currency) => {
    const amount = Number(minor || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'SEK',
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency || 'SEK'}`;
    }
  };

  const methodCode = (value) => {
    const text = String(value || '').trim().toUpperCase();
    if (text === 'EMBROIDERY' || text === 'DTF' || text === 'DTG') return text;
    if (text === 'EMBROIDERY PRINTING') return 'EMBROIDERY';
    if (text.includes('EMBROIDERY')) return 'EMBROIDERY';
    if (text.includes('DTF')) return 'DTF';
    if (text.includes('DTG')) return 'DTG';
    return '';
  };

  const normalizedOptionValue = (value) => String(value || '').trim().toLowerCase();

  const directProductionMethod = (record) => {
    if (!record || typeof record !== 'object') return '';
    const candidates = [
      record.productionMethod,
      record.production_method,
      record.method,
      record.printMethod,
      record.print_method,
      record.printingMethod,
      record.printing_method,
      record.selectedProductionMethod,
      record.selected_production_method,
    ];
    for (const candidate of candidates) {
      const code = methodCode(candidate);
      if (code) return code;
    }
    return '';
  };

  const findProductionMethodDeep = (value, depth = 0, seen = new Set()) => {
    const direct = methodCode(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return '';
    seen.add(value);

    const recordDirect = directProductionMethod(value);
    if (recordDirect) return recordDirect;

    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value);
    for (const [key, entryValue] of entries) {
      const keyText = String(key || '').toLowerCase();
      if (
        keyText.includes('method') ||
        keyText.includes('printing') ||
        keyText.includes('print') ||
        keyText.includes('production')
      ) {
        const keyed = methodCode(entryValue);
        if (keyed) return keyed;
      }
      const nested = findProductionMethodDeep(entryValue, depth + 1, seen);
      if (nested) return nested;
    }
    return '';
  };

  const selectedProductionMethod = (value, source) => {
    for (const candidate of [value, source]) {
      const code = findProductionMethodDeep(candidate);
      if (code) return code;
    }
    return '';
  };

  const numberFrom = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return Math.floor(number);
    }
    return 0;
  };

  const optionValueFrom = (item, keys, allowedValues = []) => {
    if (!item || typeof item !== 'object') return '';
    for (const key of keys) {
      const value = normalizedOptionValue(item[key]);
      if (value) return value;
    }
    const allowed = allowedValues.map(normalizedOptionValue).filter(Boolean);
    if (!allowed.length) return '';
    const values = Object.values(item).map(normalizedOptionValue).filter(Boolean);
    return allowed.find((allowedValue) => values.includes(allowedValue)) || '';
  };

  const selectionFromOptions = (item, config) => {
    if (!item || typeof item !== 'object' || !config) return null;
    const quantity = numberFrom(item.quantity, item.qty, item.count, item.amount, 1);
    const color = optionValueFrom(
      item,
      ['color', 'colour', 'colorValue', 'colourValue', 'selectedColor', 'selected_colour'],
      config.colors
    );
    const size = optionValueFrom(
      item,
      ['size', 'sizeValue', 'selectedSize', 'selected_size'],
      config.sizes
    );
    if (!color && !size) return null;
    const variant = (config.variants || []).find((candidate) => {
      if (color && normalizedOptionValue(candidate.color) !== color) return false;
      if (size && normalizedOptionValue(candidate.size) !== size) return false;
      return true;
    });
    if (!variant) return null;
    return {
      variantId: normalizeVariantId(variant.variantId || variant.id),
      variantGid: String(variant.variantGid || variant.gid || ''),
      color: String(variant.color || ''),
      size: String(variant.size || ''),
      quantity,
    };
  };

  const selectionFrom = (item, config) => {
    if (!item || typeof item !== 'object') return null;
    const variantId = normalizeVariantId(item.variantId || item.variantGid || item.variant_id || item.id || item.merchandiseId || item.merchandise_id);
    const quantity = numberFrom(item.quantity, item.qty, item.count, item.amount);
    if (variantId && quantity) {
      const variant = (config?.variants || []).find((candidate) =>
        normalizeVariantId(candidate.variantId || candidate.id) === variantId
      );
      if (!variant) return null;
      return {
        variantId,
        variantGid: String(variant.variantGid || variant.gid || ''),
        color: String(variant.color || ''),
        size: String(variant.size || ''),
        quantity,
      };
    }
    return selectionFromOptions(item, config);
  };

  const mergeSelections = (selections) => {
    const byVariant = new Map();
    for (const selection of selections) {
      if (!selection?.variantId || !selection.quantity) continue;
      const existing = byVariant.get(selection.variantId);
      byVariant.set(selection.variantId, {
        variantId: selection.variantId,
        variantGid: selection.variantGid || existing?.variantGid || '',
        color: selection.color || existing?.color || '',
        size: selection.size || existing?.size || '',
        quantity: Number(existing?.quantity || 0) + selection.quantity,
      });
    }
    return Array.from(byVariant.values());
  };

  const collectSelections = (value, config, depth = 0, seen = new Set()) => {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return [];
    seen.add(value);

    if (Array.isArray(value)) {
      const direct = value.map((item) => selectionFrom(item, config)).filter(Boolean);
      if (direct.length) return direct;
      return value.flatMap((item) => collectSelections(item, config, depth + 1, seen));
    }

    const selections = [];
    for (const [key, nestedValue] of Object.entries(value)) {
      const keyText = String(key || '').toLowerCase();
      if (
        Array.isArray(nestedValue) &&
        (
          keyText.includes('selection') ||
          keyText.includes('line') ||
          keyText.includes('item') ||
          keyText.includes('variant') ||
          keyText.includes('color') ||
          keyText.includes('colour') ||
          keyText.includes('size')
        )
      ) {
        selections.push(...collectSelections(nestedValue, config, depth + 1, seen));
      } else if (nestedValue && typeof nestedValue === 'object') {
        selections.push(...collectSelections(nestedValue, config, depth + 1, seen));
      }
    }
    return selections;
  };

  const savedSelections = (value, source, snapshot, config) => {
    const selections = mergeSelections([
      ...collectSelections(value, config),
      ...collectSelections(source, config),
    ]);
    if (selections.length) return selections;
    const fallbackVariant = (config?.variants || []).find((variant) =>
      normalizeVariantId(variant.variantId || variant.id) === String(snapshot.variantId)
    );
    return [
      {
        variantId: String(snapshot.variantId),
        variantGid: String(fallbackVariant?.variantGid || fallbackVariant?.gid || ''),
        color: String(fallbackVariant?.color || ''),
        size: String(fallbackVariant?.size || ''),
        quantity: snapshot.quantity,
      },
    ];
  };

  const postJson = (url, payload) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open('POST', url, true);
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = () => {
      const responseData = parseJson(request.responseText || '{}', {});
      if (request.status >= 200 && request.status < 300) {
        resolve(responseData);
        return;
      }

      const message =
        responseData?.error?.message ||
        responseData?.description ||
        responseData?.message ||
        `Request failed with status ${request.status}`;
      const error = new Error(message);
      error.status = request.status;
      reject(error);
    };
    request.onerror = () => {
      const error = new Error('A network error occurred while preparing your customized product.');
      error.status = request.status || 0;
      reject(error);
    };
    request.ontimeout = () => {
      const error = new Error('The cart request timed out. Please try again.');
      error.status = 0;
      reject(error);
    };
    request.timeout = 20000;
    request.send(JSON.stringify(payload));
  });

  const normalizeProductionMethods = (pricing) => {
    const methods = pricing?.productionMethodPricing || {};
    const rawEmbroideryPricing = pricing?.embroideryPricing || methods?.EMBROIDERY?.embroiderySubtypes || {};
    const normalizeRate = (rate, fallbackLabel, maxWidthCm, maxHeightCm) => {
      const surchargeMinor = Number(rate?.surchargeMinor || 0);
      const feeVariantGid = String(rate?.feeVariantGid || rate?.productionFeeVariantId || rate?.shopifyFeeVariantId || '').trim();
      const feeVariantId = String(rate?.feeVariantId || normalizeVariantId(feeVariantGid)).trim();
      return {
        label: String(rate?.label || fallbackLabel),
        surchargeMinor: Number.isFinite(surchargeMinor) && surchargeMinor > 0 ? Math.round(surchargeMinor) : 0,
        ...(feeVariantId ? { feeVariantId } : {}),
        ...(feeVariantGid ? { feeVariantGid } : {}),
        maxWidthCm,
        maxHeightCm,
      };
    };
    const embroiderySubtypes = {
      TEXT_ONLY: normalizeRate(rawEmbroideryPricing.TEXT_ONLY, 'Embroidery — Text only', 8, 8),
      IMAGE_OR_LOGO: normalizeRate(rawEmbroideryPricing.IMAGE_OR_LOGO || rawEmbroideryPricing.IMAGE_LOGO, 'Embroidery — Image / Logo', 8, 8),
    };
    return Object.keys(METHOD_DETAILS).map((code) => {
      const detail = METHOD_DETAILS[code];
      const configured = methods[code] || (Array.isArray(pricing?.productionMethods)
        ? pricing.productionMethods.find((method) => String(method?.id || '').toUpperCase() === code)
        : null);
      const surchargeMinor = Number(configured?.surchargeMinor || 0);
      const feeVariantGid = String(configured?.feeVariantGid || configured?.productionFeeVariantId || configured?.shopifyFeeVariantId || '').trim();
      const feeVariantId = String(configured?.feeVariantId || normalizeVariantId(feeVariantGid)).trim();
      const isEmbroidery = code === 'EMBROIDERY';
      return {
        id: detail.id,
        label: detail.label,
        surchargeMinor: isEmbroidery
          ? 0
          : Number.isFinite(surchargeMinor) && surchargeMinor > 0
            ? Math.round(surchargeMinor)
            : 0,
        ...(!isEmbroidery && feeVariantId ? { feeVariantId } : {}),
        ...(!isEmbroidery && feeVariantGid ? { feeVariantGid } : {}),
        ...(isEmbroidery ? { embroiderySubtypes } : {}),
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

    const sizePosition = Number(actions.dataset.sizeOptionPosition || 0);
    const colorPosition = Number(actions.dataset.colorOptionPosition || 0);
    const optionNames = parseJson(actions.dataset.productOptionNames, []);
    const currency = String(pricing?.currency || actions.dataset.currency || 'SEK').toUpperCase();
    const variants = publicContract.buildVariantMatrix({
      variants: parseJson(actions.dataset.productVariants, []),
      optionNames,
      colorPosition,
      sizePosition,
      currency,
    });
    const colors = Array.from(new Set(variants.map((variant) => variant.color).filter(Boolean)));
    const sizes = Array.from(new Set(variants.map((variant) => variant.size).filter(Boolean)));

    const baseConfig = {
      version: 2,
      contractVersion: publicContract.CONTRACT_VERSION,
      productId: String(actions.dataset.productId || ''),
      productHandle: String(actions.dataset.productHandle || ''),
      productTitle: String(actions.dataset.productTitle || ''),
      currency,
      optionNames,
      variants,
      colors,
      sizes,
      optionGroups: [
        {
          id: 'color',
          label: 'Color',
          values: colors,
          multiple: true,
        },
        {
          id: 'size',
          label: 'Size',
          values: sizes,
          multiple: true,
        },
      ],
      supportsMultipleSelections: true,
      selectedColor: String(actions.dataset.selectedColor || ''),
      selectedSize: String(actions.dataset.selectedSize || ''),
      initialVariantId: selectedVariantId(actions),
      initialQuantity: selectedQuantity(actions),
      productionMethods,
      embroideryPricing:
        productionMethods.find((method) => method.id === 'embroidery')?.embroiderySubtypes || {},
      productionMethodPricing: publicContract.buildProductionMethodPricing(productionMethods),
    };
    const revision = publicContract.revisionFor({
      productId: baseConfig.productId,
      optionNames,
      variants,
      productionMethods,
      currency,
    });
    return {
      ...baseConfig,
      revision,
      configRevision: revision,
      integrationSettings: publicContract.integrationSettings(revision),
    };
  };

  const refreshPublicConfig = () => {
    const root = document.querySelector(rootSelector);
    const candidate = buildProductConfig(root);
    if (!candidate) return state.config;
    const config = publicContract.chooseCanonicalConfig(state.config, candidate);
    state.config = config;
    state.configRevision = config.revision;
    window.CustomHousePublicPitchPrintConfig = config;
    window.CustomHousePitchPrintBridgeDebug = {
      getFeeMappings() {
        const currentConfig = refreshPublicConfig() || state.config;
        return (currentConfig?.productionMethods || []).map((method) => ({
          id: method.id,
          label: method.label,
          surchargeMinor: method.surchargeMinor,
          feeVariantId: method.feeVariantId || '',
          feeVariantGid: method.feeVariantGid || '',
          embroiderySubtypes: method.embroiderySubtypes || null,
        }));
      },
    };
    if (state.loggedRevision !== config.revision) {
      state.loggedRevision = config.revision;
      const embroideryRates = config.embroideryPricing || {};
      const dtfRate = config.productionMethodPricing?.DTF || {};
      const dtgRate = config.productionMethodPricing?.DTG || {};
      const variantPricesComplete = config.variants.length > 0 && config.variants.every((variant) =>
        Number.isSafeInteger(variant.priceMinor) && variant.priceMinor >= 0 && variant.currency === config.currency
      );
      log('Public PitchPrint config ready', {
        PUBLIC_CONFIG_PRODUCT_ID: config.productId,
        PUBLIC_CONFIG_KEYS: Object.keys(config),
        PUBLIC_CONFIG_VARIANT_COUNT: config.variants.length,
        PUBLIC_CONFIG_COLORS: config.colors,
        PUBLIC_CONFIG_SIZES: config.sizes,
        PUBLIC_CONFIG_CURRENCY: config.currency,
        PUBLIC_CONFIG_EMBROIDERY_TEXT_PRICE: Number(embroideryRates.TEXT_ONLY?.surchargeMinor || 0),
        PUBLIC_CONFIG_EMBROIDERY_IMAGE_PRICE: Number(embroideryRates.IMAGE_OR_LOGO?.surchargeMinor || 0),
        PUBLIC_CONFIG_DTF_PRICE: Number(dtfRate.surchargeMinor || 0),
        PUBLIC_CONFIG_DTG_PRICE: Number(dtgRate.surchargeMinor || 0),
        PUBLIC_CONFIG_HAS_VARIANT_PRICES: variantPricesComplete,
        PUBLIC_PRICE_CONFIG_REVISION: config.revision,
        PUBLIC_PRICE_TEXT: Number(embroideryRates.TEXT_ONLY?.surchargeMinor || 0),
        PUBLIC_PRICE_IMAGE: Number(embroideryRates.IMAGE_OR_LOGO?.surchargeMinor || 0),
        PUBLIC_PRICE_DTF: Number(dtfRate.surchargeMinor || 0),
        PUBLIC_PRICE_DTG: Number(dtgRate.surchargeMinor || 0),
        PUBLIC_PRODUCT_ID: config.productId,
        PUBLIC_VARIANT_COUNT: config.variants.length,
        PUBLIC_OPTION_NAMES: config.optionNames,
        PUBLIC_COLORS: config.colors,
        PUBLIC_SIZES: config.sizes,
        PUBLIC_EMBROIDERY_TEXT_PRICE: Number(embroideryRates.TEXT_ONLY?.surchargeMinor || 0),
        PUBLIC_EMBROIDERY_IMAGE_PRICE: Number(embroideryRates.IMAGE_OR_LOGO?.surchargeMinor || 0),
        PUBLIC_DTF_PRICE: Number(dtfRate.surchargeMinor || 0),
        PUBLIC_DTG_PRICE: Number(dtgRate.surchargeMinor || 0),
        PUBLIC_GENERIC_EMBROIDERY_PRICE_USED: false,
        PUBLIC_PRODUCTION_METHODS: config.productionMethods.map((method) => ({
          id: method.id,
          surchargeMinor: method.surchargeMinor,
          embroiderySubtypes: method.embroiderySubtypes || null,
        })),
        PUBLIC_HAS_INTEGRATION_SETTINGS: Boolean(config.integrationSettings),
        PUBLIC_CONFIG_REVISION: config.revision,
      });
    }
    return config;
  };

  const respondWithProductConfig = (targetWindow) => {
    const config = refreshPublicConfig();
    if (!config || !targetWindow || typeof targetWindow.postMessage !== 'function') return false;
    targetWindow.postMessage({
      type: 'CUSTOMHOUSE_PP_ORDER_CONFIG_DATA',
      payload: config,
    }, '*');
    log('PUBLIC_CONFIG_SENT', {
      PUBLIC_CONFIG_REVISION: config.revision,
      PUBLIC_CONFIG_SENT_VARIANTS: config.variants.length,
      PUBLIC_CONFIG_SENT_TEXT_PRICE: Number(config.embroideryPricing?.TEXT_ONLY?.surchargeMinor || 0),
    });
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

  const embroiderySubtypeCode = (value) => {
    const raw = String(value || '').trim().toUpperCase();
    const normalized = raw === 'IMAGE_LOGO' ? 'IMAGE_OR_LOGO' : raw;
    return normalized === 'TEXT_ONLY' || normalized === 'IMAGE_OR_LOGO' ? normalized : '';
  };

  const selectedEmbroiderySubtype = (value, source) => {
    const candidates = [
      value?.embroiderySubtype,
      value?.artworkType,
      source?.embroiderySubtype,
      source?.artworkType,
      value?.production?.embroiderySubtype,
      source?.production?.embroiderySubtype,
    ];
    for (const candidate of candidates) {
      const subtype = embroiderySubtypeCode(candidate);
      if (subtype) return subtype;
    }
    return '';
  };

  const firstPositiveInteger = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number > 0) return number;
    }
    return 0;
  };

  const accepted = (value) => value === true || value === 1 || value === '1' || value === 'true' || value === 'Accepted';

  const legalConfirmationsFrom = (value, source) => {
    const legal = value?.legalConfirmations || source?.legalConfirmations || {};
    return {
      rightsAccepted: accepted(
        value?.rightsAccepted ?? value?.copyrightAccepted ?? source?.rightsAccepted ?? source?.copyrightAccepted ?? legal.rightsAccepted ?? legal.copyrightAccepted
      ),
      termsAccepted: accepted(
        value?.termsAccepted ?? source?.termsAccepted ?? legal.termsAccepted
      ),
    };
  };

  const artworkSourceFrom = (value, source) => {
    const candidates = [
      value?.artworkSource,
      value?.projectData,
      value?.savedProject,
      source?.artworkSource,
      source?.projectData,
      source?.savedProject,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') return candidate;
    }
    if (Array.isArray(value?.pages) || Array.isArray(value?.canvases) || Array.isArray(value?.surfaces)) return value;
    if (Array.isArray(source?.pages) || Array.isArray(source?.canvases) || Array.isArray(source?.surfaces)) return source;
    return null;
  };

  async function addProjectToCart(projectId, previewUrl, value = {}, source = {}) {
  const snapshot = state.snapshot;
  const root = snapshot?.root;
  const config = refreshPublicConfig() || state.config;

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

  const productionMethod = selectedProductionMethod(value, source);
  const configuredMethod = config?.productionMethodPricing?.[productionMethod] ||
    (config?.productionMethods || []).find((method) => methodCode(method.id) === productionMethod);
  const embroiderySubtype = productionMethod === 'EMBROIDERY'
    ? selectedEmbroiderySubtype(value, source)
    : '';
  const configuredRate = productionMethod === 'EMBROIDERY'
    ? configuredMethod?.embroiderySubtypes?.[embroiderySubtype]
    : configuredMethod;

  if (!productionMethod || !configuredMethod) {
    warn('Missing production method');
    setStatus(
      root,
      'Choose a printing method before adding this custom product to the cart.',
      true
    );
    return;
  }

  if (productionMethod === 'EMBROIDERY' && !embroiderySubtype) {
    warn('Missing embroidery artwork type');
    setStatus(
      root,
      'The embroidery artwork type could not be determined. Please save the design again.',
      true
    );
    return;
  }

  if (!configuredRate || Number(configuredRate.surchargeMinor || 0) <= 0 || !configuredRate.feeVariantId) {
    warn('Missing production fee variant');
    setStatus(
      root,
      `${configuredRate?.label || configuredMethod?.label || productionMethod} pricing is not configured. Please contact the store.`,
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

  const selections = savedSelections(value, source, snapshot, config);
  const placementCount = firstPositiveInteger(
    value?.placementCount,
    source?.placementCount,
    value?.production?.placementCount,
    source?.production?.placementCount
  );
  const totalQuantity = selections.reduce((sum, selection) => sum + Number(selection.quantity || 0), 0);
  const legalConfirmations = legalConfirmationsFrom(value, source);
  const artworkSource = artworkSourceFrom(value, source);
  const pitchprintDesignId = String(
    value?.designId || value?.pitchprintDesignId || source?.designId || source?.pitchprintDesignId || ''
  ).trim();
  const visibleProperties = {
    'Printing method': configuredMethod.label || productionMethod,
    'Printing charge / item': moneyFromMinor(configuredRate.surchargeMinor, config?.currency || 'SEK'),
  };

  state.inFlight = true;

  log('Cart add started', { productionMethod, embroiderySubtype, placementCount, selections });

  setStatus(
    root,
    'Adding your custom product to the cart...',
    false
  );

  try {
    const prepared = await postJson('/apps/customhouse/api/public-production-cart', {
      shopifyProductId: config?.productId || snapshot.productId,
      pitchprintProjectId: projectId,
      pitchprintDesignId,
      productionMethod,
      selectedProductionMethod: productionMethod,
      artworkType: embroiderySubtype || null,
      embroiderySubtype: embroiderySubtype || null,
      placementCount,
      placements: value?.placements || source?.placements || [],
      totalQuantity,
      selectedColors: value?.selectedColors || source?.selectedColors || [],
      artworkSource,
      legalConfirmations,
      selections,
      variantSelections: selections,
      previewUrl,
    });
    const preparedData = prepared?.data || prepared;
    const preparedItems = Array.isArray(preparedData?.items) ? preparedData.items : [];
    if (!prepared?.ok || !preparedItems.length) {
      throw new Error(prepared?.error?.message || 'Production pricing could not be prepared.');
    }

    const cartItems = preparedItems.map((item) => {
      const properties = {
        ...(item.properties || {}),
      };
      if (!properties._customhouse_fee_key) {
        throw new Error('Production fee pairing could not be prepared.');
      }
      if (properties._customhouse_production_fee === 'true') {
        properties['Printing method'] = visibleProperties['Printing method'];
      } else {
        properties['Printing method'] = visibleProperties['Printing method'];
        properties['Printing charge / item'] = visibleProperties['Printing charge / item'];
      }
      return {
        id: item.id,
        quantity: item.quantity,
        properties,
      };
    });

    await postJson(route('cart/add.js'), { items: cartItems });
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
      error?.message || 'We could not add your custom product to the cart. Please try again.',
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
    state.lastSaved = { projectId, value, source };
    setStatus(state.snapshot?.root, 'Design saved. Preparing your cart...', false);
  }

  function handleCartReady(event) {
    log('Public cart-ready contract received');
    const message = event?.detail ?? event?.data ?? event ?? {};
    const payload = message?.payload ?? message?.value ?? message?.data ?? message ?? {};
    const savedValue = state.lastSaved?.value || {};
    const value = { ...savedValue, ...payload };
    const source = value?.source ?? state.lastSaved?.source ?? {};
    const projectId = String(
      value?.projectId ||
      value?.pitchprintProjectId ||
      source?.projectId ||
      source?.pitchprintProjectId ||
      state.lastSaved?.projectId ||
      ''
    ).trim();

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
    addProjectToCart(
      projectId,
      firstPreviewUrl(value.previews || source.previews),
      value,
      source
    );
  }

  function bindPitchPrintClient(client) {
    if (state.listenerBound) return true;
    if (!client || typeof client.on !== 'function') return false;

    try {
      client.on('project-saved', handleProjectSaved);
      client.on('cart-ready', handleCartReady);
      client.on('CUSTOMHOUSE_PP_CART_READY', handleCartReady);
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
    if (message?.type === 'CUSTOMHOUSE_PP_CART_READY') {
      handleCartReady(message);
      return;
    }
    if (message?.type === 'CUSTOMHOUSE_PP_ORDER_CONFIG_ACK') {
      const acknowledgedRevision = String(
        message?.payload?.configRevision || message?.configRevision || ''
      );
      if (acknowledgedRevision && acknowledgedRevision === state.configRevision) {
        state.acknowledgedRevision = acknowledgedRevision;
        log('PUBLIC_CONFIG_ACKNOWLEDGED', {
          PUBLIC_CONFIG_REVISION: acknowledgedRevision,
          PUBLIC_CONFIG_ACK_VARIANTS: state.config?.variants?.length || 0,
          PUBLIC_CONFIG_ACK_TEXT_PRICE: Number(state.config?.embroideryPricing?.TEXT_ONLY?.surchargeMinor || 0),
        });
      }
      return;
    }
    if (message?.type !== 'CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST') return;
    respondWithProductConfig(event.source);
  });

  window.addEventListener('customhouse:pitchprint-order-config-request', (event) => {
    const detail = event?.detail || {};
    const targetWindow = detail.contentWindow || detail.source || detail.iframe?.contentWindow || detail.targetWindow || null;
    respondWithProductConfig(targetWindow);
  });

  window.addEventListener('CUSTOMHOUSE_PP_CART_READY', handleCartReady);
  window.addEventListener('customhouse:pitchprint-cart-ready', handleCartReady);

  log('Initialized');
  refreshPublicConfig();
  ensurePitchPrintListener();
})();

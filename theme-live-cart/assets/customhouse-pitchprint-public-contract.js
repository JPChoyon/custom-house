(function attachCustomHousePublicPitchPrintContract(global) {
  const CONTRACT_VERSION = 'PUBLIC_CUSTOMIZE_V2';

  const text = (value) => String(value == null ? '' : value).trim();

  const normalizeVariantId = (value) => {
    const valueText = text(value);
    const match = valueText.match(/(\d+)$/);
    return match ? match[1] : valueText;
  };

  const normalizeOptionName = (value) => text(value).toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const semanticOption = (value) => {
    const name = normalizeOptionName(value);
    if (name.includes('color') || name.includes('colour') || name.includes('farg')) return 'color';
    if (name.includes('size') || name.includes('storlek')) return 'size';
    return '';
  };

  const optionIndex = (optionNames, semantic, fallbackPosition) => {
    const semanticIndex = optionNames.findIndex((name) => semanticOption(name) === semantic);
    if (semanticIndex >= 0) return semanticIndex;
    const position = Number(fallbackPosition || 0);
    return Number.isSafeInteger(position) && position > 0 ? position - 1 : -1;
  };

  const priceMinor = (variant) => {
    const value = Number(variant?.priceMinor ?? variant?.price ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  };

  function buildVariantMatrix(input) {
    const optionNames = Array.isArray(input?.optionNames)
      ? input.optionNames.map(text)
      : [];
    const colorIndex = optionIndex(optionNames, 'color', input?.colorPosition);
    const sizeIndex = optionIndex(optionNames, 'size', input?.sizePosition);
    const currency = text(input?.currency || 'SEK').toUpperCase();

    return (Array.isArray(input?.variants) ? input.variants : []).map((variant) => {
      const values = Array.isArray(variant?.options)
        ? variant.options.map(text)
        : [variant?.option1, variant?.option2, variant?.option3].map(text);
      const variantId = normalizeVariantId(variant?.variantId || variant?.id);
      const variantGid = text(
        variant?.variantGid ||
        variant?.admin_graphql_api_id ||
        variant?.gid ||
        (variantId ? `gid://shopify/ProductVariant/${variantId}` : '')
      );
      const color = colorIndex >= 0 ? text(values[colorIndex]) : '';
      const size = sizeIndex >= 0 ? text(values[sizeIndex]) : '';
      const optionValues = {};
      optionNames.forEach((name, index) => {
        if (name && values[index]) optionValues[name] = values[index];
      });

      return {
        variantId,
        variantGid,
        id: variantId,
        gid: variantGid,
        title: text(variant?.title),
        options: {
          ...(color ? { Color: color } : {}),
          ...(size ? { Size: size } : {}),
        },
        optionValues,
        color,
        size,
        available: variant?.available !== false,
        priceMinor: priceMinor(variant),
        currency,
      };
    }).filter((variant) => variant.variantId && variant.variantGid);
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }

  function revisionFor(value) {
    const serialized = JSON.stringify(stableValue(value));
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${CONTRACT_VERSION}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function integrationSettings(revision) {
    return {
      mode: 'PUBLIC_CUSTOMIZE',
      contractVersion: CONTRACT_VERSION,
      configRevision: text(revision),
      variantSelectionMode: 'COLOR_SIZE_MATRIX',
      supportsMultipleVariantSelections: true,
      configRequestMessageType: 'CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST',
      configResponseMessageType: 'CUSTOMHOUSE_PP_ORDER_CONFIG_DATA',
      configAcknowledgementMessageType: 'CUSTOMHOUSE_PP_ORDER_CONFIG_ACK',
      cartReadyMessageType: 'CUSTOMHOUSE_PP_CART_READY',
    };
  }

  function chooseCanonicalConfig(current, candidate) {
    if (!current) return candidate;
    if (!candidate) return current;
    if (text(current.productId) !== text(candidate.productId)) return candidate;
    const currentCount = Array.isArray(current.variants) ? current.variants.length : 0;
    const candidateCount = Array.isArray(candidate.variants) ? candidate.variants.length : 0;
    if (candidateCount < currentCount) return current;
    if (candidate.revision === current.revision) return current;
    return candidate;
  }

  global.CustomHousePublicPitchPrintContract = Object.freeze({
    CONTRACT_VERSION,
    buildVariantMatrix,
    chooseCanonicalConfig,
    integrationSettings,
    normalizeVariantId,
    revisionFor,
    semanticOption,
  });
})(typeof window !== 'undefined' ? window : globalThis);

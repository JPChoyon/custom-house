const API_ROOT = "/apps/customhouse/api";

function apiError(body, fallback) {
  return body?.error?.message || fallback;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_ROOT}/${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("The designer service returned an invalid response.");
  }
  if (!response.ok || !body?.success) {
    throw new Error(apiError(body, "The designer request could not be completed."));
  }
  return body.data;
}

function gid(type, value) {
  const numeric = String(value || "").match(/\d+/)?.[0];
  return numeric ? `gid://shopify/${type}/${numeric}` : "";
}

function currentVariantId(root) {
  const productFormVariant = document.querySelector('form[action*="/cart/add"] [name="id"]');
  return gid("ProductVariant", productFormVariant?.value) || root.dataset.variantId;
}

function randomKey() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now()}${Math.random().toString(36).slice(2)}`.slice(0, 40);
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image export failed."))),
      "image/png",
    );
  });
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The product mockup could not be loaded."));
    image.src = url;
  });
}

async function createExports(canvas, config) {
  try {
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    const artworkCrop = canvas.toCanvasElement(1, {
      left: config.printArea.x,
      top: config.printArea.y,
      width: config.printArea.width,
      height: config.printArea.height,
    });
    const artwork = document.createElement("canvas");
    artwork.width = config.exportWidth;
    artwork.height = config.exportHeight;
    const artworkContext = artwork.getContext("2d");
    artworkContext.drawImage(
      artworkCrop,
      0,
      0,
      config.exportWidth,
      config.exportHeight,
    );

    const preview = document.createElement("canvas");
    preview.width = config.canvasWidth;
    preview.height = config.canvasHeight;
    const previewContext = preview.getContext("2d");
    const mockup = await loadHtmlImage(config.mockupImageUrl);
    previewContext.drawImage(mockup, 0, 0, config.canvasWidth, config.canvasHeight);
    previewContext.drawImage(canvas.toCanvasElement(1), 0, 0);
    return {
      artwork: await canvasBlob(artwork),
      preview: await canvasBlob(preview),
      previewDataUrl: preview.toDataURL("image/png"),
    };
  } catch {
    throw new Error("We could not export this design. Check the artwork and try again.");
  }
}

function setStatus(root, message, state = "idle") {
  const element = root.querySelector("[data-designer-status]");
  element.textContent = message;
  element.dataset.state = state;
}

function setBusy(root, busy) {
  root.querySelectorAll("button, input, select").forEach((control) => {
    if (control.matches("[data-designer-close], [data-designer-preview-close]")) return;
    control.disabled = busy;
  });
}

function downloadBlob(state, blob, fileName) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    state.objectUrls.delete(url);
  }, 1_000);
}

async function uploadSource(root, file) {
  const form = new FormData();
  form.set("productId", root.dataset.productId);
  form.set("variantId", currentVariantId(root));
  form.set("image", file, file.name);
  return api("designer/upload", { method: "POST", body: form });
}

async function initializeEditor(root, bootstrap) {
  setStatus(root, "Loading editor…");
  let fabric;
  try {
    fabric = await import(root.dataset.fabricModule);
  } catch {
    throw new Error("The design editor could not be loaded. Please refresh and try again.");
  }
  const config = bootstrap.config;
  const stage = root.querySelector("[data-designer-stage]");
  stage.style.aspectRatio = `${config.canvasWidth} / ${config.canvasHeight}`;
  stage.style.backgroundImage = `url("${config.mockupImageUrl.replaceAll('"', "%22")}")`;
  const print = root.querySelector("[data-designer-print-area]");
  print.style.left = `${(config.printArea.x / config.canvasWidth) * 100}%`;
  print.style.top = `${(config.printArea.y / config.canvasHeight) * 100}%`;
  print.style.width = `${(config.printArea.width / config.canvasWidth) * 100}%`;
  print.style.height = `${(config.printArea.height / config.canvasHeight) * 100}%`;

  const canvas = new fabric.Canvas(root.querySelector("[data-designer-canvas]"), {
    width: config.canvasWidth,
    height: config.canvasHeight,
    preserveObjectStacking: true,
    selectionColor: "rgba(91, 77, 247, .12)",
  });
  canvas.clipPath = new fabric.Rect({
    left: config.printArea.x,
    top: config.printArea.y,
    width: config.printArea.width,
    height: config.printArea.height,
    absolutePositioned: true,
  });
  const state = {
    mode: "CUSTOMER_CUSTOMIZE",
    clientKey: randomKey(),
    sessionId: "",
    version: 0,
    saving: false,
    history: [],
    historyIndex: -1,
    restoring: false,
    objectUrls: new Set(),
  };

  const snapshot = () => JSON.stringify(canvas.toJSON(["customHouseSource"]));
  const recordHistory = () => {
    if (state.restoring) return;
    const value = snapshot();
    if (state.history[state.historyIndex] === value) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(value);
    if (state.history.length > 30) state.history.shift();
    state.historyIndex = state.history.length - 1;
  };
  const restore = async (index) => {
    if (index < 0 || index >= state.history.length || state.restoring) return;
    state.restoring = true;
    try {
      await canvas.loadFromJSON(state.history[index]);
      state.historyIndex = index;
      canvas.requestRenderAll();
    } catch {
      setStatus(root, "That design history item could not be restored.", "error");
    } finally {
      state.restoring = false;
    }
  };
  const keepInPrintArea = (event) => {
    const object = event.target;
    if (!object) return;
    object.setCoords();
    const bounds = object.getBoundingRect();
    const right = config.printArea.x + config.printArea.width;
    const bottom = config.printArea.y + config.printArea.height;
    if (bounds.left < config.printArea.x) {
      object.left += config.printArea.x - bounds.left;
    }
    if (bounds.top < config.printArea.y) {
      object.top += config.printArea.y - bounds.top;
    }
    if (bounds.left + bounds.width > right) {
      object.left -= bounds.left + bounds.width - right;
    }
    if (bounds.top + bounds.height > bottom) {
      object.top -= bounds.top + bounds.height - bottom;
    }
    object.setCoords();
  };
  canvas.on("object:moving", keepInPrintArea);
  canvas.on("object:scaling", keepInPrintArea);
  canvas.on("object:modified", recordHistory);
  canvas.on("object:added", recordHistory);
  canvas.on("object:removed", recordHistory);
  recordHistory();

  const activeText = () => {
    const object = canvas.getActiveObject();
    return object && ["textbox", "i-text", "text", "Textbox", "IText", "FabricText"].includes(object.type)
      ? object
      : null;
  };
  root.querySelector("[data-designer-add-text]").addEventListener("click", () => {
    const value = root.querySelector("[data-designer-text]").value.trim() || "Your text";
    const text = new fabric.Textbox(value, {
      left: config.printArea.x + config.printArea.width * .15,
      top: config.printArea.y + config.printArea.height * .25,
      width: config.printArea.width * .7,
      fontSize: Number(root.querySelector("[data-designer-font-size]").value) || 48,
      fontFamily: root.querySelector("[data-designer-font]").value || "Arial",
      fill: root.querySelector("[data-designer-color]").value || "#111111",
      textAlign: "center",
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    canvas.requestRenderAll();
  });
  root.querySelector("[data-designer-text]").addEventListener("input", (event) => {
    const text = activeText();
    if (!text) return;
    text.set("text", event.target.value);
    canvas.requestRenderAll();
  });
  root.querySelector("[data-designer-font-size]").addEventListener("change", (event) => {
    const text = activeText();
    if (!text) return;
    text.set("fontSize", Math.max(12, Math.min(240, Number(event.target.value) || 48)));
    canvas.requestRenderAll();
    recordHistory();
  });
  root.querySelector("[data-designer-font]").addEventListener("change", (event) => {
    const text = activeText();
    if (!text) return;
    try {
      text.set("fontFamily", event.target.value || "Arial");
    } catch {
      text.set("fontFamily", "Arial");
      setStatus(root, "That font was unavailable, so Arial was used.", "error");
    }
    canvas.requestRenderAll();
    recordHistory();
  });
  root.querySelector("[data-designer-color]").addEventListener("input", (event) => {
    const text = activeText();
    if (!text) return;
    text.set("fill", event.target.value);
    canvas.requestRenderAll();
    recordHistory();
  });
  root.querySelector("[data-designer-upload]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!config.allowedFileTypes.includes(file.type) || file.size > config.maximumUploadBytes) {
      setStatus(root, "Use a PNG, JPEG, or WebP within the allowed file size.", "error");
      event.target.value = "";
      return;
    }
    setBusy(root, true);
    setStatus(root, "Uploading artwork…");
    try {
      const stored = await uploadSource(root, file);
      const image = await fabric.FabricImage.fromURL(stored.url, {
        crossOrigin: "anonymous",
      });
      const scale = Math.min(
        (config.printArea.width * .8) / image.width,
        (config.printArea.height * .8) / image.height,
        1,
      );
      image.set({
        left: config.printArea.x + config.printArea.width / 2,
        top: config.printArea.y + config.printArea.height / 2,
        originX: "center",
        originY: "center",
        scaleX: scale,
        scaleY: scale,
        customHouseSource: stored.url,
      });
      canvas.add(image);
      canvas.setActiveObject(image);
      canvas.requestRenderAll();
      setStatus(root, "Artwork uploaded.", "saved");
    } catch (error) {
      setStatus(root, error.message || "The image could not be loaded.", "error");
    } finally {
      setBusy(root, false);
      event.target.value = "";
    }
  });

  root.querySelector("[data-designer-delete]").addEventListener("click", () => {
    const selected = canvas.getActiveObjects();
    if (!selected.length) return;
    canvas.discardActiveObject();
    selected.forEach((object) => canvas.remove(object));
    canvas.requestRenderAll();
  });
  root.querySelector("[data-designer-forward]").addEventListener("click", () => {
    const selected = canvas.getActiveObject();
    if (selected) canvas.bringObjectForward(selected);
    canvas.requestRenderAll();
    recordHistory();
  });
  root.querySelector("[data-designer-backward]").addEventListener("click", () => {
    const selected = canvas.getActiveObject();
    if (selected) canvas.sendObjectBackwards(selected);
    canvas.requestRenderAll();
    recordHistory();
  });
  root.querySelector("[data-designer-undo]").addEventListener("click", () => {
    void restore(state.historyIndex - 1);
  });
  root.querySelector("[data-designer-redo]").addEventListener("click", () => {
    void restore(state.historyIndex + 1);
  });
  root.querySelector("[data-designer-reset]").addEventListener("click", () => {
    if (!confirm("Reset this design?")) return;
    canvas.clear();
    canvas.clipPath = new fabric.Rect({
      left: config.printArea.x,
      top: config.printArea.y,
      width: config.printArea.width,
      height: config.printArea.height,
      absolutePositioned: true,
    });
    canvas.requestRenderAll();
    recordHistory();
    setStatus(root, "Design reset.");
  });
  root.querySelector("[data-designer-export-artwork]").addEventListener("click", async () => {
    setBusy(root, true);
    setStatus(root, "Exporting transparent artwork…");
    try {
      const exported = await createExports(canvas, config);
      downloadBlob(state, exported.artwork, "custom-house-artwork.png");
      setStatus(root, "Transparent artwork exported.", "saved");
    } catch (error) {
      setStatus(root, error.message || "Artwork export failed.", "error");
    } finally {
      setBusy(root, false);
    }
  });
  root.querySelector("[data-designer-export-preview]").addEventListener("click", async () => {
    setBusy(root, true);
    setStatus(root, "Exporting preview…");
    try {
      const exported = await createExports(canvas, config);
      downloadBlob(state, exported.preview, "custom-house-preview.png");
      setStatus(root, "Preview exported.", "saved");
    } catch (error) {
      setStatus(root, error.message || "Preview export failed.", "error");
    } finally {
      setBusy(root, false);
    }
  });

  const saveDraft = async () => {
    if (state.saving) return null;
    state.saving = true;
    setBusy(root, true);
    setStatus(root, "Saving…");
    try {
      const form = new FormData();
      form.set("productId", root.dataset.productId);
      form.set("variantId", currentVariantId(root));
      form.set("clientKey", state.clientKey);
      form.set("sessionId", state.sessionId);
      form.set("expectedVersion", String(state.version));
      form.set("designJson", snapshot());
      const saved = await api("creator/designs/save", { method: "POST", body: form });
      state.sessionId = saved.id;
      state.version = saved.version;
      setStatus(root, "Saved.", "saved");
      return saved;
    } catch (error) {
      setStatus(root, error.message || "Save failed. Your last saved draft is unchanged.", "error");
      return null;
    } finally {
      state.saving = false;
      setBusy(root, false);
    }
  };

  root.querySelector("[data-designer-save]").addEventListener("click", () => {
    void saveDraft();
  });
  root.querySelector("[data-designer-preview]").addEventListener("click", async () => {
    setBusy(root, true);
    setStatus(root, "Preparing preview…");
    try {
      const exported = await createExports(canvas, config);
      root.querySelector("[data-designer-preview-image]").src = exported.previewDataUrl;
      const dialog = root.querySelector("[data-designer-preview-dialog]");
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      setStatus(root, "Preview ready.", "saved");
    } catch (error) {
      setStatus(root, error.message || "Preview failed.", "error");
    } finally {
      setBusy(root, false);
    }
  });
  root.querySelector("[data-designer-preview-close]").addEventListener("click", () => {
    const dialog = root.querySelector("[data-designer-preview-dialog]");
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  });

  const setMode = (mode) => {
    state.mode = mode;
    root.querySelectorAll("[data-designer-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.designerMode === mode));
    });
    const creator = mode === "CREATOR_PUBLISH";
    root.querySelector("[data-designer-save]").hidden = !creator;
    root.querySelector("[data-designer-title-field]").hidden = !creator;
    root.querySelector("[data-designer-primary]").textContent = creator
      ? "Add to My Collection"
      : "Customize & Buy";
  };
  root.querySelectorAll("[data-designer-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.designerMode));
  });
  if (bootstrap.creatorModeAvailable) {
    root.querySelector("[data-designer-mode-switch]").hidden = false;
  }
  setMode("CUSTOMER_CUSTOMIZE");
  const recentSessions = Array.isArray(bootstrap.recentSessions)
    ? bootstrap.recentSessions
    : [];
  if (recentSessions.length) {
    const field = root.querySelector("[data-designer-resume-field]");
    const select = root.querySelector("[data-designer-resume]");
    field.hidden = false;
    recentSessions.forEach((session) => {
      const option = document.createElement("option");
      option.value = session.id;
      option.textContent = `${session.mode === "CREATOR_PUBLISH" ? "Creator draft" : "Customer design"} · ${new Date(session.updatedAt).toLocaleString()}`;
      select.append(option);
    });
    select.addEventListener("change", async () => {
      if (!select.value || state.saving) return;
      setBusy(root, true);
      setStatus(root, "Loading saved design…");
      try {
        const saved = await api(`designer/sessions/${encodeURIComponent(select.value)}`);
        state.restoring = true;
        await canvas.loadFromJSON(JSON.parse(saved.designJson));
        canvas.clipPath = new fabric.Rect({
          left: config.printArea.x,
          top: config.printArea.y,
          width: config.printArea.width,
          height: config.printArea.height,
          absolutePositioned: true,
        });
        state.clientKey = saved.clientKey;
        state.sessionId = saved.id;
        state.version = saved.version;
        state.history = [];
        state.historyIndex = -1;
        state.restoring = false;
        recordHistory();
        if (saved.mode !== "CREATOR_PUBLISH" || bootstrap.creatorModeAvailable) {
          setMode(saved.mode);
        }
        canvas.requestRenderAll();
        setStatus(root, "Saved design loaded.", "saved");
      } catch (error) {
        state.restoring = false;
        setStatus(root, error.message || "The saved design could not be loaded.", "error");
      } finally {
        setBusy(root, false);
      }
    });
  }

  root.querySelector("[data-designer-primary]").addEventListener("click", async () => {
    if (state.saving) return;
    if (state.mode === "CREATOR_PUBLISH") {
      const saved = await saveDraft();
      if (!saved) return;
      state.saving = true;
      setBusy(root, true);
      setStatus(root, "Publishing to your collection…");
      try {
        await api("creator/designs/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: state.sessionId,
            title: root.querySelector("[data-designer-title]").value,
          }),
        });
        setStatus(root, "Your fixed product is now in your creator collection.", "saved");
      } catch (error) {
        setStatus(root, error.message || "Publishing failed. Your draft is safe.", "error");
      } finally {
        state.saving = false;
        setBusy(root, false);
      }
      return;
    }
    state.saving = true;
    setBusy(root, true);
    setStatus(root, "Preparing your customized product…");
    try {
      const form = new FormData();
      form.set("productId", root.dataset.productId);
      form.set("variantId", currentVariantId(root));
      form.set("clientKey", state.clientKey);
      form.set("sessionId", state.sessionId);
      form.set("expectedVersion", String(state.version));
      form.set("designJson", snapshot());
      const result = await api("designs/customer/finalize", {
        method: "POST",
        body: form,
      });
      state.sessionId = result.designSession.id;
      state.version = result.designSession.version;
      const cartResponse = await fetch("/cart/add.js", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: [result.cart] }),
      });
      if (!cartResponse.ok) throw new Error("The customized product could not be added to cart.");
      window.location.assign("/cart");
    } catch (error) {
      setStatus(root, error.message || "The customized product could not be added to cart.", "error");
    } finally {
      state.saving = false;
      setBusy(root, false);
    }
  });

  root.__customHouseDesignerCleanup = () => {
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    canvas.dispose();
  };
  setStatus(root, "Ready.", "saved");
}

async function boot(root) {
  const query = new URLSearchParams({
    productId: root.dataset.productId,
    variantId: currentVariantId(root),
  });
  let bootstrap;
  try {
    bootstrap = await api(`designer/config?${query}`);
  } catch {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const open = root.querySelector("[data-designer-open]");
  if (!bootstrap.loggedIn) {
    root.querySelector("[data-designer-login]").hidden = false;
    open.hidden = true;
    return;
  }
  open.hidden = false;
  let initialized = false;
  open.addEventListener("click", async () => {
      if (initialized) {
        open.hidden = true;
        root.querySelector("[data-designer-app]").hidden = false;
        return;
      }
      open.disabled = true;
      try {
        await initializeEditor(root, bootstrap);
        initialized = true;
        open.hidden = true;
        root.querySelector("[data-designer-app]").hidden = false;
      } catch (error) {
        open.disabled = false;
        const message = error.message || "The editor could not be opened.";
        const boundary = root.querySelector("[data-designer-bootstrap-error]");
        boundary.textContent = message;
        boundary.hidden = false;
        setStatus(root, message, "error");
      }
    });
  root.querySelector("[data-designer-close]").addEventListener("click", () => {
    root.querySelector("[data-designer-app]").hidden = true;
    open.hidden = false;
    open.disabled = false;
  });
  window.addEventListener(
    "pagehide",
    () => root.__customHouseDesignerCleanup?.(),
    { once: true },
  );
}

document.querySelectorAll("[data-customhouse-designer]").forEach((root) => {
  void boot(root);
});

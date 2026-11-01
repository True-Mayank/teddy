"use strict";

/* =========================================================
   LUXE NATIVE FEEL
   Makes the WebView behave like a real Android music player:
   no pinch/double-tap zoom, no text selection or browser menus,
   a back button that closes things in the right order, light
   haptic feedback, and a smooth cross-fade when the UI style changes.
   Loads last; only uses what app.js and luxe-features.js already expose.
   ========================================================= */
(function () {
  const $ = selector => document.querySelector(selector);
  const nativeBridge = () => {
    try { return (typeof isNativeAndroid === "function" && isNativeAndroid()) ? window.LuxeAndroid : null; }
    catch { return null; }
  };
  const reducedMotion = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  if (nativeBridge()) document.documentElement.classList.add("android-native");

  /* ---- no zoom, no browser menus ---- */
  ["gesturestart", "gesturechange", "gestureend"].forEach(type =>
    document.addEventListener(type, e => e.preventDefault(), { passive: false }));
  document.addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
  });
  document.addEventListener("contextmenu", e => {
    if (!(e.target.closest && e.target.closest("input, textarea"))) e.preventDefault();
  });
  document.addEventListener("dragstart", e => e.preventDefault());

  /* ---- light haptics on taps (Android only; respects the phone's touch-feedback setting) ---- */
  let lastBuzz = 0;
  function buzz(kind) {
    const n = nativeBridge();
    if (!n || typeof n.haptic !== "function") return;
    const now = Date.now();
    if (now - lastBuzz < 45) return;
    lastBuzz = now;
    try { n.haptic(kind); } catch {}
  }
  document.addEventListener("click", e => {
    const t = e.target.closest && e.target.closest("button, .library-action, .playlist-card, .collection-card, .ui-style-option, .luxe-toggle");
    if (t && !t.disabled) buzz(1);
  }, true);

  /* ---- the Android back button ---- */
  /* Returns true when LUXE used the press; false lets Android send the app to the background
     (music keeps playing, like every music player). */
  window.LuxeBack = function () {
    const viz = $("#visualizerPanel");
    if (viz && !viz.classList.contains("hidden")) {
      if (window.LuxeFeatures && window.LuxeFeatures.closeViz) window.LuxeFeatures.closeViz();
      return true;
    }
    const open = Array.from(document.querySelectorAll(".overlay:not(.hidden)"));
    if (open.length) {
      open.sort((a, b) => (parseInt(getComputedStyle(a).zIndex, 10) || 0) - (parseInt(getComputedStyle(b).zIndex, 10) || 0));
      const top = open[open.length - 1];
      if (top.id === "roulettePanel" && window.LuxeFeatures && window.LuxeFeatures.rouletteBusy && window.LuxeFeatures.rouletteBusy()) return true;
      if (typeof closeOverlay === "function") closeOverlay("#" + top.id); else top.classList.add("hidden");
      return true;
    }
    const menus = ["#sortMenu", "#playlistSortMenu"].some(id => { const m = $(id); return m && !m.classList.contains("hidden"); });
    if (menus && typeof closeAllMenus === "function") { closeAllMenus(); return true; }
    const player = $("#playerModal");
    if (player && !player.classList.contains("hidden")) {
      if (typeof closeOverlay === "function") closeOverlay("#playerModal"); else player.classList.add("hidden");
      return true;
    }
    const crumb = $("#breadcrumb");
    if (crumb && !crumb.classList.contains("hidden")) {
      const back = crumb.querySelector("[data-back-library]");
      if (back) { back.click(); return true; }
    }
    const search = $("#search");
    if (search && search.value) {
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.blur();
      return true;
    }
    return false;
  };

  /* ---- smooth cross-fade when switching UI style ---- */
  if (typeof window.applyUiStyle === "function" && document.startViewTransition) {
    const original = window.applyUiStyle;
    window.applyUiStyle = function (style, persist = true) {
      if (persist === false || reducedMotion()) return original.call(this, style, persist);
      try {
        const transition = document.startViewTransition(() => { original.call(window, style, persist); });
        // A new switch can interrupt the previous cross-fade; that is fine, just don't log it as an error.
        ["ready", "finished", "updateCallbackDone"].forEach(key => { if (transition && transition[key] && transition[key].catch) transition[key].catch(() => {}); });
      } catch { original.call(this, style, persist); }
    };
  }

  /* ---- native wording on the welcome screen ---- */
  const status = $("#folderStatus");
  if (status && nativeBridge() && /browser controls access/i.test(status.textContent)) {
    status.textContent = "Pick the folder that holds your music. Nothing leaves your phone.";
  }
})();

"use strict";

/* =========================================================
   LUXE MUSIC FEATURE PACK
   Rename Song, Delete Song, Slow Reverb (+ presets, per-song),
   Crossfade, Playback Speed, Duplicate Finder, Dynamic Album
   Artwork, Full-Screen Visualizer, Gesture Control, Music Roulette.

   This file loads after app.js and only hooks into it. On Android the
   heavy work (speed, reverb, crossfade, visualizer, file rename/delete)
   is done natively by the LuxeAndroid bridge; in a browser a simple
   fallback is used where one is possible.
   ========================================================= */
(function () {

  /* -------------------------------------------------------
     Helpers
  ------------------------------------------------------- */
  const $ = selector => document.querySelector(selector);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const round2 = value => Math.round(value * 100) / 100;
  const fmtSpeed = (value, digits = 1) => round2(value).toFixed(digits === 2 ? 2 : (Math.abs(value * 10 - Math.round(value * 10)) < 0.001 ? 1 : 2));

  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }
  };

  function nativeBridge() {
    try {
      return (typeof isNativeAndroid === "function" && isNativeAndroid()) ? window.LuxeAndroid : null;
    } catch { return null; }
  }

  function bridge(name, ...args) {
    const n = nativeBridge();
    try {
      if (n && typeof n[name] === "function") return n[name](...args);
    } catch (error) { console.warn("LUXE bridge call failed:", name, error); }
    return undefined;
  }

  let toastTimer = 0;
  function toast(message, ms = 3600) {
    const el = $("#luxeToast");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
  }

  function paintRange(el) {
    if (!el) return;
    const min = Number(el.min) || 0, max = Number(el.max) || 100, value = Number(el.value) || 0;
    el.style.setProperty("--range-progress", ((value - min) / (max - min) * 100) + "%");
  }

  function currentSong() {
    return (typeof currentQueue !== "undefined" && currentQueue[queuePosition]) ||
      (typeof songs !== "undefined" && songs[current]) || null;
  }

  function isPlayingNow() {
    if (nativeBridge()) return !!luxeNativePlaying;
    return !!(audio && !audio.paused);
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "size unknown";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function closePanel(id) {
    if (typeof closeOverlay === "function") closeOverlay(id);
    else $(id)?.classList.add("hidden");
  }
  function openPanel(id) {
    if (typeof openOverlay === "function") openOverlay(id);
    else $(id)?.classList.remove("hidden");
  }

  /* -------------------------------------------------------
     Saved settings
  ------------------------------------------------------- */
  const DEFAULT_SLOW = { on: false, rate: 0.85, reverb: 35, room: 55, presetId: "slowed-reverb" };

  const BUILTIN_PRESETS = [
    { id: "slowed",        name: "Slowed",           rate: 0.85, reverb: 0,  room: 30 },
    { id: "slowed-reverb", name: "Slowed + Reverb",  rate: 0.85, reverb: 35, room: 55 },
    { id: "deep-slow",     name: "Deep Slow",        rate: 0.75, reverb: 50, room: 75 },
    { id: "dreamy-hall",   name: "Dreamy Hall",      rate: 0.90, reverb: 60, room: 90 },
    { id: "nightcore",     name: "Nightcore",        rate: 1.20, reverb: 0,  room: 20 }
  ];

  function loadCfg() {
    const saved = LS.get("luxe_features", {}) || {};
    const cfg = {
      speed: 1,
      slow: { ...DEFAULT_SLOW },
      crossfadeOn: false,
      crossfadeSec: 4,
      gestures: true,
      dynArt: false,
      vizStyle: "bars",
      rouletteRecent: []
    };
    Object.assign(cfg, saved);
    cfg.slow = Object.assign({}, DEFAULT_SLOW, saved.slow || {});
    cfg.speed = clamp(Number(cfg.speed) || 1, 0.5, 2);
    cfg.crossfadeSec = clamp(Number(cfg.crossfadeSec) || 4, 1, 12);
    if (!Array.isArray(cfg.rouletteRecent)) cfg.rouletteRecent = [];
    return cfg;
  }

  let cfg = loadCfg();
  let songFx = LS.get("luxe_song_fx", {}) || {};          // song id -> { speed, slow }
  let customPresets = LS.get("luxe_slow_presets", []) || []; // [{ id, name, rate, reverb, room }]
  let nameOverrides = LS.get("luxe_name_overrides", {}) || {}; // song id -> { title, artist }

  const saveCfg = () => LS.set("luxe_features", cfg);
  const saveSongFx = () => LS.set("luxe_song_fx", songFx);
  const savePresets = () => LS.set("luxe_slow_presets", customPresets);
  const saveOverrides = () => LS.set("luxe_name_overrides", nameOverrides);

  const copyFx = fx => ({
    speed: fx.speed,
    slow: { on: fx.slow.on, rate: fx.slow.rate, reverb: fx.slow.reverb, room: fx.slow.room, presetId: fx.slow.presetId || null }
  });

  /* The settings that apply to the song on screen: its own saved ones, or the global ones. */
  function fxTarget() {
    const song = currentSong();
    return (song && songFx[song.id]) ? songFx[song.id] : cfg;
  }
  function persistTarget(target) {
    if (target === cfg) saveCfg(); else saveSongFx();
  }

  /* -------------------------------------------------------
     Send settings to the Android audio service / browser audio
  ------------------------------------------------------- */
  let pushTimer = 0;
  function pushConfig(immediate) {
    clearTimeout(pushTimer);
    const run = () => {
      const payload = {
        speed: cfg.speed,
        slow: { on: cfg.slow.on, rate: cfg.slow.rate, reverb: cfg.slow.reverb, room: cfg.slow.room },
        crossfadeMs: cfg.crossfadeOn ? Math.round(cfg.crossfadeSec * 1000) : 0,
        songs: {}
      };
      for (const id in songFx) {
        const f = songFx[id];
        payload.songs[id] = { speed: f.speed, slow: { on: f.slow.on, rate: f.slow.rate, reverb: f.slow.reverb, room: f.slow.room } };
      }
      bridge("nativeSetEffects", JSON.stringify(payload));
      applyBrowserFx();
    };
    if (immediate) run(); else pushTimer = setTimeout(run, 90);
  }

  /* Browser fallback (the Android app uses the native service instead) */
  let bgraph = null;
  function ensureBrowserGraph() {
    if (bgraph) return bgraph;
    if (nativeBridge() || typeof audio === "undefined" || !audio) return null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      const src = ctx.createMediaElementSource(audio);
      const dry = ctx.createGain(), wet = ctx.createGain();
      const conv = ctx.createConvolver(), analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(dry); dry.connect(ctx.destination);
      src.connect(conv); conv.connect(wet); wet.connect(ctx.destination);
      src.connect(analyser);
      bgraph = { ctx, dry, wet, conv, analyser, room: -1 };
      viz.analyser = analyser;
      viz.fftBuf = new Uint8Array(analyser.frequencyBinCount);
      return bgraph;
    } catch (error) {
      console.warn("LUXE: Web Audio is not available", error);
      return null;
    }
  }

  function makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate, length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    return buffer;
  }

  function applyBrowserFx() {
    if (nativeBridge() || typeof audio === "undefined" || !audio) return;
    const fx = fxTarget();
    const rate = fx.slow.on ? fx.slow.rate : 1;
    try {
      audio.playbackRate = clamp(fx.speed * rate, 0.25, 4);
      const keepPitch = !fx.slow.on; // Slow Reverb lowers pitch with speed, like a slowed record
      audio.preservesPitch = keepPitch;
      audio.mozPreservesPitch = keepPitch;
      audio.webkitPreservesPitch = keepPitch;
    } catch {}
    const amount = fx.slow.on ? fx.slow.reverb : 0;
    if (!bgraph && amount <= 0) return;
    const graph = ensureBrowserGraph();
    if (!graph) return;
    if (graph.room !== fx.slow.room) {
      graph.conv.buffer = makeImpulse(graph.ctx, 0.8 + fx.slow.room / 100 * 3.2, 2.6);
      graph.room = fx.slow.room;
    }
    graph.wet.gain.value = amount / 100 * 1.1;
    graph.dry.gain.value = 1 - amount / 220;
    if (graph.ctx.state === "suspended") graph.ctx.resume().catch(() => {});
  }

  /* -------------------------------------------------------
     Player tool buttons + sheets: Playback Speed and Slow Reverb
  ------------------------------------------------------- */
  function refreshChips() {
    const fx = fxTarget();
    const speedBtn = $("#speedBtn");
    if (speedBtn) {
      speedBtn.textContent = fmtSpeed(fx.speed) + "x";
      speedBtn.classList.toggle("active", Math.abs(fx.speed - 1) > 0.001);
    }
    const slowBtn = $("#slowBtn");
    if (slowBtn) slowBtn.classList.toggle("active", !!fx.slow.on);
  }

  const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function renderSpeed() {
    const fx = fxTarget();
    const song = currentSong();
    $("#speedValue").textContent = fmtSpeed(fx.speed, 2) + "x";
    const range = $("#speedRange");
    range.value = fx.speed;
    paintRange(range);
    $("#speedChips").innerHTML = SPEED_STEPS.map(v =>
      `<button type="button" class="small-btn fx-chip ${Math.abs(v - fx.speed) < 0.001 ? "active" : ""}" data-speed="${v}">${v}x</button>`
    ).join("");
    const sw = $("#speedSongSwitch");
    sw.checked = !!(song && songFx[song.id]);
    sw.disabled = !song;
  }

  function setSpeed(value) {
    const target = fxTarget();
    target.speed = round2(clamp(Number(value) || 1, 0.5, 2));
    persistTarget(target);
    refreshChips();
    renderSpeed();
    pushConfig();
  }

  function allPresets() {
    return BUILTIN_PRESETS.concat(customPresets.map(p => ({ ...p, custom: true })));
  }

  function renderSlow() {
    const fx = fxTarget();
    const song = currentSong();
    $("#slowOn").checked = !!fx.slow.on;
    $("#slowPresets").innerHTML = allPresets().map(p => {
      const active = fx.slow.presetId === p.id ? "active" : "";
      const chip = `<button type="button" class="small-btn fx-chip ${active}" data-preset="${esc(p.id)}">${esc(p.name)}</button>`;
      return p.custom
        ? `<span class="fx-chip-wrap">${chip}<button type="button" class="fx-chip-x" data-del-preset="${esc(p.id)}" aria-label="Delete preset ${esc(p.name)}">×</button></span>`
        : chip;
    }).join("");
    const set = (rangeId, valId, value, label) => {
      const r = $(rangeId); r.value = value; paintRange(r); $(valId).textContent = label;
    };
    set("#slowRate", "#slowRateVal", fx.slow.rate, fmtSpeed(fx.slow.rate, 2) + "x");
    set("#slowReverb", "#slowReverbVal", fx.slow.reverb, Math.round(fx.slow.reverb) + "%");
    set("#slowRoom", "#slowRoomVal", fx.slow.room, Math.round(fx.slow.room) + "%");
    const sw = $("#slowSongSwitch");
    sw.checked = !!(song && songFx[song.id]);
    sw.disabled = !song;
    $("#slowNote").textContent = (song && songFx[song.id])
      ? "These settings are saved for this song only."
      : "These settings apply to every song. Reverb needs a phone that supports audio effects; speed and pitch always work.";
  }

  function changeSlow(patch, keepPreset) {
    const target = fxTarget();
    Object.assign(target.slow, patch);
    if (!keepPreset) target.slow.presetId = null;
    persistTarget(target);
    refreshChips();
    renderSlow();
    pushConfig();
  }

  function applyPreset(id) {
    const preset = allPresets().find(p => p.id === id);
    if (!preset) return;
    changeSlow({ on: true, rate: preset.rate, reverb: preset.reverb, room: preset.room, presetId: preset.id }, true);
  }

  function setSongScope(songOnly) {
    const song = currentSong();
    if (!song) return;
    if (songOnly) {
      if (!songFx[song.id]) songFx[song.id] = copyFx(cfg);
      toast("Settings will be remembered for this song.");
    } else {
      delete songFx[song.id];
      toast("This song now uses your global settings.");
    }
    saveSongFx();
    refreshChips();
    renderSpeed();
    renderSlow();
    pushConfig(true);
  }

  /* -------------------------------------------------------
     Dynamic Album Artwork
  ------------------------------------------------------- */
  const colorCache = new Map();

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function paletteFromHue(hue) {
    return { a: hslToRgb(hue, 0.62, 0.55), b: hslToRgb(hue + 28, 0.7, 0.72) };
  }

  function hashHue(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function extractPalette(url) {
    if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const size = 28, canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          const buckets = new Map();
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 200) continue;
            const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
            if (l < 0.12 || l > 0.92) continue;
            const key = Math.round(h / 20) % 18;
            const weight = 0.15 + s * s * 2 + (1 - Math.abs(l - 0.5)) * 0.4;
            const entry = buckets.get(key) || { w: 0, h: 0, s: 0, l: 0 };
            entry.w += weight; entry.h += h * weight; entry.s += s * weight; entry.l += l * weight;
            buckets.set(key, entry);
          }
          let best = null;
          buckets.forEach(entry => { if (!best || entry.w > best.w) best = entry; });
          if (!best) throw new Error("no usable colour");
          const hue = best.h / best.w, sat = clamp(best.s / best.w, 0.35, 0.85);
          const palette = { a: hslToRgb(hue, sat, 0.55), b: hslToRgb(hue + 24, clamp(sat + 0.05, 0.4, 0.9), 0.72) };
          colorCache.set(url, palette);
          resolve(palette);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  let dynToken = 0;
  async function updateDynamicArt() {
    const root = document.documentElement;
    if (!cfg.dynArt) {
      root.classList.remove("dyn-art-on");
      return;
    }
    const song = currentSong();
    if (!song) { root.classList.remove("dyn-art-on"); return; }
    const token = ++dynToken;
    const url = getArtworkUrl(song);
    let palette = url ? await extractPalette(url) : null;
    if (token !== dynToken) return;
    if (!palette) palette = paletteFromHue(hashHue(String(song.title || song.id) + String(song.artist || "")));
    root.style.setProperty("--dyn-a", `rgb(${palette.a.join(",")})`);
    root.style.setProperty("--dyn-b", `rgb(${palette.b.join(",")})`);
    root.style.setProperty("--dyn-a-rgb", palette.a.join(","));
    root.style.setProperty("--dyn-b-rgb", palette.b.join(","));
    root.classList.add("dyn-art-on");
  }

  /* -------------------------------------------------------
     Rename Song
  ------------------------------------------------------- */
  let menuSongId = null;
  let renameSongId = null;

  function openSongMenu(id) {
    const song = getSongById(id);
    if (!song) return;
    menuSongId = song.id;
    $("#songMenuTitle").textContent = song.title || "Song";
    $("#songMenuArtist").textContent = song.artist || "";
    openPanel("#songMenuPanel");
  }

  function openRename(id) {
    const song = getSongById(id);
    if (!song) return;
    renameSongId = song.id;
    $("#renameTitle").value = song.title || "";
    $("#renameArtist").value = (song.artist && song.artist !== "Unknown Artist") ? song.artist : "";
    $("#renameNote").textContent = nativeBridge()
      ? "The name changes in LUXE and on the audio file in your music folder."
      : "Browsers cannot rename files on your device, so the name changes inside LUXE only.";
    openPanel("#renamePanel");
    setTimeout(() => $("#renameTitle")?.focus(), 60);
  }

  function applyOverrideToSong(song) {
    const o = song && nameOverrides[song.id];
    if (!o) return;
    if (o.title) song.title = o.title;
    if (o.artist) song.artist = o.artist;
  }

  function applyOverridesToSongs() {
    if (typeof songs === "undefined") return;
    songs.forEach(applyOverrideToSong);
  }

  function refreshAfterSongsChanged() {
    try { if (typeof updateStats === "function") updateStats(); } catch {}
    try { if (typeof renderHome === "function") renderHome(); } catch {}
    try { if (typeof render === "function") render(); } catch {}
    try { if (typeof renderPlaylistSongs === "function") renderPlaylistSongs(); } catch {}
    try { if (typeof updatePlayer === "function") updatePlayer(); } catch {}
    refreshChips();
  }

  function saveRename() {
    const song = getSongById(renameSongId);
    if (!song) { closePanel("#renamePanel"); return; }
    const title = $("#renameTitle").value.trim();
    let artist = $("#renameArtist").value.trim();
    if (!title) { $("#renameTitle").focus(); return; }
    if (!artist) artist = "Unknown Artist";

    nameOverrides[song.id] = { title, artist };
    saveOverrides();
    song.title = title;
    song.artist = artist;
    closePanel("#renamePanel");
    refreshAfterSongsChanged();

    if (nativeBridge()) {
      const base = artist !== "Unknown Artist" ? `${artist} - ${title}` : title;
      toast("Renaming…", 6000);
      bridge("renameSong", String(song.id), base);
    } else {
      toast("Renamed inside LUXE (a browser cannot rename the file itself).");
    }
  }

  /* Move everything LUXE remembers about a song to its new id after the file is renamed. */
  function remapSongId(oldId, newId, patch) {
    const swapKey = (obj, saver) => {
      if (obj && Object.prototype.hasOwnProperty.call(obj, oldId)) {
        obj[newId] = obj[oldId];
        delete obj[oldId];
        if (saver) saver();
      }
    };
    const swapList = (list) => list.map(id => id === oldId ? newId : id);

    const song = songs.find(s => s.id === oldId);
    if (song) {
      song.id = newId;
      if (patch.url) song.nativeUrl = patch.url;
      if (patch.name) song.name = patch.name;
      if (patch.artwork) { song.artwork = patch.artwork; song.artworkUrl = patch.artwork; }
    }
    favorites = swapList(favorites); saveJSON("luxe_favorites", favorites);
    recent = swapList(recent); saveJSON("luxe_recent", recent);
    playlists.forEach(p => { if (Array.isArray(p.songs)) p.songs = swapList(p.songs); });
    saveJSON("luxe_playlists", playlists);
    swapKey(luxePlayCounts, () => saveJSON("luxe_play_counts", luxePlayCounts));
    swapKey(luxeAddedAt, () => saveJSON("luxe_added_at", luxeAddedAt));
    swapKey(nameOverrides, saveOverrides);
    swapKey(songFx, saveSongFx);
    if (luxeNativeCurrentId === oldId) luxeNativeCurrentId = newId;
    if (lastSongId === oldId) lastSongId = newId;
  }

  function syncNativeQueue() {
    if (!nativeBridge() || !currentQueue.length) return;
    const nq = currentQueue.filter(s => s.nativeUrl).map(s => ({ id: s.id, title: s.title, artist: s.artist, url: s.nativeUrl }));
    const playing = currentSong();
    const index = nq.findIndex(s => playing && s.id === playing.id);
    if (nq.length && index >= 0) bridge("nativeUpdateQueue", JSON.stringify(nq), index);
  }

  function onSongRenamed(payload) {
    let r = payload;
    try { if (typeof r === "string") r = JSON.parse(r); } catch { return; }
    if (!r) return;
    if (r.ok) {
      remapSongId(r.oldId, r.newId, { url: r.url, name: r.name, artwork: r.artwork });
      syncNativeQueue();
      pushConfig(true);
      refreshAfterSongsChanged();
      toast("Renamed. The file on your phone was renamed too.");
    } else if (r.error === "permission") {
      toast("Name changed inside LUXE only. Folder access was not granted, so the file was not renamed.", 5200);
    } else {
      toast("Name changed inside LUXE. The file could not be renamed: " + (r.error || "unknown error"), 5200);
    }
  }

  /* -------------------------------------------------------
     Delete Song from Folder (and shared delete for duplicates)
  ------------------------------------------------------- */
  let pendingDeleteIds = [];

  function confirmDelete(ids, extraWarning) {
    ids = ids.map(String);
    if (!ids.length) return;
    pendingDeleteIds = ids;
    const first = getSongById(ids[0]);
    $("#deleteTitle").textContent = ids.length === 1 ? "Delete this song?" : `Delete ${ids.length} songs?`;
    $("#deleteText").textContent = (ids.length === 1
      ? `"${first?.title || "This song"}" will be permanently deleted from your phone's storage. This cannot be undone.`
      : `${ids.length} audio files will be permanently deleted from your phone's storage. This cannot be undone.`) +
      (extraWarning ? " " + extraWarning : "");
    openPanel("#deletePanel");
  }

  function doDelete(ids) {
    if (!nativeBridge()) {
      toast("Deleting files from storage works in the Android app. A browser cannot delete files on your device.", 5200);
      return;
    }
    toast("Deleting…", 8000);
    bridge("deleteSongs", JSON.stringify(ids));
  }

  function removeSongsFromState(ids) {
    const gone = new Set(ids.map(String));
    const playing = currentSong();
    const playingGone = !!(playing && gone.has(String(playing.id)));
    const oldQueue = currentQueue.slice();
    const oldPos = queuePosition;
    const keep = s => !gone.has(String(s.id));
    const keepId = id => !gone.has(String(id));

    songs = songs.filter(keep);
    favorites = favorites.filter(keepId); saveJSON("luxe_favorites", favorites);
    recent = recent.filter(keepId); saveJSON("luxe_recent", recent);
    playlists.forEach(p => { if (Array.isArray(p.songs)) p.songs = p.songs.filter(keepId); });
    saveJSON("luxe_playlists", playlists);
    gone.forEach(id => { delete luxePlayCounts[id]; delete luxeAddedAt[id]; delete nameOverrides[id]; delete songFx[id]; });
    saveJSON("luxe_play_counts", luxePlayCounts);
    saveJSON("luxe_added_at", luxeAddedAt);
    saveOverrides(); saveSongFx();

    const newQueue = oldQueue.filter(keep);
    currentQueueBase = currentQueueBase.filter(keep);

    if (playingGone) {
      const before = oldQueue.slice(0, Math.max(0, oldPos)).filter(keep).length;
      if (newQueue.length) {
        startQueue(newQueue, Math.min(before, newQueue.length - 1));
      } else {
        currentQueue = []; queuePosition = -1; current = -1;
        bridge("nativeStop");
        if (audio) { try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {} }
        $("#miniPlayer")?.classList.add("hidden");
        closePanel("#playerModal");
      }
    } else {
      currentQueue = newQueue;
      queuePosition = playing ? newQueue.findIndex(s => s.id === playing.id) : -1;
      current = playing ? songs.findIndex(s => s.id === playing.id) : -1;
      syncNativeQueue();
    }
    pushConfig(true);
    refreshAfterSongsChanged();
  }

  function onSongsDeleted(payload) {
    let r = payload;
    try { if (typeof r === "string") r = JSON.parse(r); } catch { return; }
    if (!r) return;
    const deleted = Array.isArray(r.deleted) ? r.deleted : [];
    const failed = Array.isArray(r.failed) ? r.failed : [];
    if (deleted.length) removeSongsFromState(deleted);
    if (deleted.length && !failed.length) {
      toast(deleted.length === 1 ? "Song deleted from your phone." : `${deleted.length} songs deleted from your phone.`);
    } else if (failed.length) {
      const denied = failed.some(f => f.error === "permission");
      toast(denied
        ? "LUXE needs permission to change files in your music folder, so nothing was deleted."
        : `${failed.length} file${failed.length === 1 ? "" : "s"} could not be deleted${deleted.length ? ` (${deleted.length} deleted)` : ""}.`, 5200);
    }
    if (!$("#duplicatesPanel")?.classList.contains("hidden")) renderDuplicates();
  }

  /* -------------------------------------------------------
     Duplicate Song Finder
  ------------------------------------------------------- */
  function normKey(text) {
    let t = String(text || "").toLowerCase();
    t = t.replace(/\.(mp3|m4a|flac|wav|aac|ogg|opus|webm|oga)$/i, "");
    t = t.replace(/[\s_-]*[\(\[]\s*(\d{1,2}|copy(\s*\d+)?)\s*[\)\]]\s*$/i, "");
    t = t.replace(/[\s_-]+copy(\s*\d+)?\s*$/i, "");
    t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return t;
  }

  function findDuplicateGroups() {
    const map = new Map();
    songs.forEach(song => {
      const titleKey = normKey(song.title);
      if (!titleKey) return;
      const key = titleKey + "|" + normKey(song.artist);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(song);
    });
    const groups = [];
    map.forEach(members => {
      if (members.length < 2) return;
      members.sort((a, b) =>
        (b.size || 0) - (a.size || 0) ||
        String(a.name || "").length - String(b.name || "").length ||
        (a.lastModified || 0) - (b.lastModified || 0));
      const sizes = new Set(members.map(m => m.size || 0));
      groups.push({ members, exact: sizes.size === 1 && (members[0].size || 0) > 0 });
    });
    groups.sort((a, b) => String(a.members[0].title).localeCompare(String(b.members[0].title)));
    return groups;
  }

  let dupSelection = new Set();

  function renderDuplicates() {
    const groups = findDuplicateGroups();
    // Pre-select every copy except the suggested one (largest file) in each group.
    dupSelection = new Set();
    groups.forEach(g => g.members.slice(1).forEach(m => dupSelection.add(String(m.id))));
    const list = $("#dupList");
    if (!groups.length) {
      $("#dupSummary").textContent = "No duplicate songs found. Nice and tidy.";
      list.innerHTML = "";
      updateDupFooter();
      return;
    }
    const extra = groups.reduce((n, g) => n + g.members.length - 1, 0);
    $("#dupSummary").textContent = `${groups.length} song${groups.length === 1 ? "" : "s"} appear more than once (${extra} extra file${extra === 1 ? "" : "s"}). The largest file in each group is kept by default. Review before deleting.`;
    list.innerHTML = groups.map(g => `
      <div class="dup-group">
        <div class="dup-group-head">${g.exact ? "Exact copies" : "Same title and artist"} · ${g.members.length} files</div>
        ${g.members.map((m, i) => `
          <label class="dup-row">
            <input type="checkbox" data-dup="${esc(m.id)}" ${i === 0 ? "" : "checked"}>
            <span class="dup-info">
              <strong>${esc(m.title)}</strong>
              <small>${esc(m.artist)} · ${esc(fmtSize(m.size))} · ${esc(m.name || "")}</small>
            </span>
            ${i === 0 ? '<em class="dup-keep">Suggested keep</em>' : ""}
          </label>`).join("")}
      </div>`).join("");
    list._groups = groups;
    updateDupFooter();
  }

  function updateDupFooter() {
    const btn = $("#dupDelete");
    const n = dupSelection.size;
    btn.disabled = n === 0;
    btn.textContent = n ? `Delete ${n} selected file${n === 1 ? "" : "s"}` : "Delete selected";
  }

  function deleteSelectedDuplicates() {
    const groups = $("#dupList")._groups || [];
    const emptied = groups.filter(g => g.members.every(m => dupSelection.has(String(m.id)))).length;
    confirmDelete([...dupSelection], emptied ? `${emptied} group${emptied === 1 ? "" : "s"} would have no copy left.` : "");
  }

  /* -------------------------------------------------------
     Music Roulette
  ------------------------------------------------------- */
  let rouletteBusy = false;

  function pickRouletteSong() {
    const n = songs.length;
    if (!n) return null;
    const keep = Math.min(15, Math.floor(n / 2));
    const recentIds = (cfg.rouletteRecent || []).slice(0, keep);
    const pool = songs.filter(s => !recentIds.includes(s.id));
    const list = pool.length ? pool : songs;
    return list[Math.floor(Math.random() * list.length)];
  }

  function showRouletteSong(song, spinning) {
    setArt($("#rouletteArt"), getArtworkUrl(song), "🎲");
    $("#rouletteTitle").textContent = song.title || "—";
    $("#rouletteArtist").textContent = song.artist || "";
    $("#rouletteWheel").classList.toggle("spinning", !!spinning);
  }

  function spinRoulette() {
    if (!songs.length) { toast("Choose your music folder first."); return; }
    openPanel("#roulettePanel");
    if (rouletteBusy) return;
    rouletteBusy = true;
    $("#rouletteHeading").textContent = "Spinning…";
    $("#rouletteAgain").disabled = true;
    $("#rouletteDone").disabled = true;
    const target = pickRouletteSong();
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const steps = reduce || songs.length < 2 ? 1 : 18;
    let i = 0;
    const tick = () => {
      const last = i >= steps;
      const shown = last ? target : songs[Math.floor(Math.random() * songs.length)];
      showRouletteSong(shown, !last);
      if (!last) { i++; setTimeout(tick, 45 + 1.1 * i * i); return; }
      cfg.rouletteRecent = [target.id, ...(cfg.rouletteRecent || []).filter(id => id !== target.id)].slice(0, 30);
      saveCfg();
      $("#rouletteHeading").textContent = "Now playing!";
      playSong(songs.indexOf(target), [...songs]);
      $("#rouletteAgain").disabled = false;
      $("#rouletteDone").disabled = false;
      rouletteBusy = false;
    };
    tick();
  }

  /* -------------------------------------------------------
     Full-Screen Visualizer
  ------------------------------------------------------- */
  const viz = {
    open: false, raf: 0, style: cfg.vizStyle || "bars",
    bars: new Float32Array(32), target: new Float32Array(32),
    lastNative: 0, analyser: null, fftBuf: null, uiTimer: 0, frame: 0, colors: null, colorsAt: 0
  };
  const VIZ_STYLES = ["bars", "wave", "circle"];
  const VIZ_LABELS = { bars: "Bars", wave: "Wave", circle: "Circle" };

  /* Called by the Android service about 20 times a second with 32 levels (0-100). */
  window.LuxeVisualizerFrame = function (levels) {
    if (!Array.isArray(levels)) return;
    for (let i = 0; i < 32; i++) viz.target[i] = clamp((levels[i] || 0) / 100, 0, 1);
    viz.lastNative = performance.now();
  };

  function vizColors() {
    const now = performance.now();
    if (viz.colors && now - viz.colorsAt < 800) return viz.colors;
    const cs = getComputedStyle(document.documentElement);
    const dyn = document.documentElement.classList.contains("dyn-art-on");
    viz.colors = {
      a: (dyn ? cs.getPropertyValue("--dyn-a") : cs.getPropertyValue("--accent")).trim() || "#d7b56d",
      b: (dyn ? cs.getPropertyValue("--dyn-b") : cs.getPropertyValue("--accent2")).trim() || "#f2d79c"
    };
    viz.colorsAt = now;
    return viz.colors;
  }

  function browserBars() {
    if (!viz.analyser || !viz.fftBuf) return null;
    viz.analyser.getByteFrequencyData(viz.fftBuf);
    const n = viz.fftBuf.length, out = new Float32Array(32);
    for (let b = 0; b < 32; b++) {
      const from = Math.floor(Math.pow(n - 1, b / 32)), to = Math.max(from + 1, Math.floor(Math.pow(n - 1, (b + 1) / 32)));
      let peak = 0;
      for (let k = from; k < to && k < n; k++) peak = Math.max(peak, viz.fftBuf[k]);
      out[b] = Math.sqrt(peak / 255);
    }
    return out;
  }

  function simulatedBars(t) {
    const out = new Float32Array(32);
    const playing = isPlayingNow();
    for (let i = 0; i < 32; i++) {
      if (!playing) { out[i] = 0.04; continue; }
      const base = (1 - i / 44) * 0.62 + 0.1;
      out[i] = base * (0.5 + 0.5 * Math.abs(Math.sin(t / 260 + i * 0.7) * Math.cos(t / 410 + i * 0.31)));
    }
    return out;
  }

  function resizeViz() {
    const canvas = $("#vizCanvas");
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function drawViz(ctx, w, h) {
    const { a, b } = vizColors();
    const bars = viz.bars;
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, h * 0.2, 0, h * 0.8);
    grad.addColorStop(0, b); grad.addColorStop(1, a);
    ctx.fillStyle = grad; ctx.strokeStyle = grad;
    const cy = h * 0.46;

    if (viz.style === "bars") {
      const n = 32, slot = w / n, bw = slot * 0.62;
      for (let i = 0; i < n; i++) {
        const v = bars[i], bh = Math.max(bw * 0.5, v * h * 0.34);
        const x = i * slot + (slot - bw) / 2, r = bw / 2;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, cy - bh, bw, bh * 2, r) : ctx.rect(x, cy - bh, bw, bh * 2);
        ctx.fill();
      }
    } else if (viz.style === "wave") {
      ctx.lineWidth = Math.max(3, w * 0.006);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.shadowColor = a; ctx.shadowBlur = 24;
      for (const dir of [1, -1]) {
        ctx.beginPath();
        for (let i = 0; i < 32; i++) {
          const x = (i / 31) * w, y = cy - dir * bars[i] * h * 0.3;
          if (i === 0) ctx.moveTo(x, y);
          else { const px = ((i - 1) / 31) * w, py = cy - dir * bars[i - 1] * h * 0.3; ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2); }
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    } else {
      const cx = w / 2, cyy = h * 0.44, base = Math.min(w, h) * 0.17;
      const bass = (bars[0] + bars[1] + bars[2] + bars[3]) / 4;
      const radius = base * (1 + bass * 0.18);
      ctx.lineCap = "round"; ctx.lineWidth = Math.max(3, base * 0.06);
      const count = 64;
      for (let i = 0; i < count; i++) {
        const idx = i < 32 ? i : 63 - i, angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        const len = base * 0.12 + bars[idx] * base * 1.1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * radius, cyy + Math.sin(angle) * radius);
        ctx.lineTo(cx + Math.cos(angle) * (radius + len), cyy + Math.sin(angle) * (radius + len));
        ctx.stroke();
      }
      ctx.lineWidth = 2; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.arc(cx, cyy, radius * 0.92, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function vizLoop(t) {
    if (!viz.open) return;
    resizeViz();
    const canvas = $("#vizCanvas"), ctx = canvas.getContext("2d");
    let source;
    if (performance.now() - viz.lastNative < 700) source = viz.target;
    else source = browserBars() || simulatedBars(t);
    for (let i = 0; i < 32; i++) {
      const diff = source[i] - viz.bars[i];
      viz.bars[i] += diff * (diff > 0 ? 0.55 : 0.16);
    }
    drawViz(ctx, canvas.width, canvas.height);
    if ((viz.frame++ % 20) === 0) {
      const play = $("#vizPlay");
      if (play) play.textContent = isPlayingNow() ? "Ⅱ" : "▶";
    }
    viz.raf = requestAnimationFrame(vizLoop);
  }

  function refreshVizText() {
    const song = currentSong();
    if ($("#vizTitle")) $("#vizTitle").textContent = song ? (song.title || "Unknown Title") : "Nothing playing";
    if ($("#vizArtist")) $("#vizArtist").textContent = song ? (song.artist || "") : "";
  }

  function showVizUi() {
    const panel = $("#visualizerPanel");
    panel.classList.remove("viz-ui-hidden");
    clearTimeout(viz.uiTimer);
    viz.uiTimer = setTimeout(() => panel.classList.add("viz-ui-hidden"), 3600);
  }

  function openViz() {
    if (!currentSong()) { toast("Play a song first, then open the visualizer."); return; }
    viz.open = true;
    $("#visualizerPanel").classList.remove("hidden");
    $("#vizStyle").textContent = VIZ_LABELS[viz.style] || "Bars";
    refreshVizText();
    if (nativeBridge()) {
      const hasPermission = bridge("hasAudioPermission");
      bridge("keepScreenOn", true);
      bridge("setVisualizer", true);
      if (hasPermission === false) bridge("requestAudioPermission");
    } else {
      ensureBrowserGraph();
      if (bgraph && bgraph.ctx.state === "suspended") bgraph.ctx.resume().catch(() => {});
    }
    showVizUi();
    cancelAnimationFrame(viz.raf);
    viz.raf = requestAnimationFrame(vizLoop);
  }

  function closeViz() {
    viz.open = false;
    cancelAnimationFrame(viz.raf);
    clearTimeout(viz.uiTimer);
    $("#visualizerPanel").classList.add("hidden");
    bridge("setVisualizer", false);
    bridge("keepScreenOn", false);
  }

  /* -------------------------------------------------------
     Gesture Control
  ------------------------------------------------------- */
  let hudTimer = 0;
  function hud(icon, text, fraction) {
    const box = $("#gestureHud");
    if (!box) return;
    $("#gestureHudIcon").textContent = icon;
    $("#gestureHudText").textContent = text;
    const bar = $("#gestureHudBar");
    bar.style.display = fraction == null ? "none" : "";
    if (fraction != null) bar.firstElementChild.style.width = Math.round(clamp(fraction, 0, 1) * 100) + "%";
    box.classList.remove("hidden");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => box.classList.add("hidden"), 900);
  }

  function getVolume() {
    const v = bridge("getSystemVolume");
    if (typeof v === "number") return v;
    return typeof audio !== "undefined" && audio ? audio.volume : 1;
  }
  function setVolume(v) {
    v = clamp(v, 0, 1);
    if (nativeBridge()) bridge("setSystemVolume", v);
    else if (audio) audio.volume = v;
    const slider = $("#volume");
    if (slider) { slider.value = v; paintRange(slider); }
    hud(v <= 0.01 ? "🔇" : "🔊", "Volume " + Math.round(v * 100) + "%", v);
  }
  function getBrightness() {
    const v = bridge("getScreenBrightness");
    return typeof v === "number" ? v : 0.5;
  }
  function setBrightness(v) {
    if (!nativeBridge()) { hud("☀", "Brightness is set by your phone in the browser"); return; }
    v = clamp(v, 0.02, 1);
    bridge("setScreenBrightness", v);
    hud("☀", "Brightness " + Math.round(v * 100) + "%", v);
  }

  let lastSwipeAt = 0;

  function bindGestures(el, full) {
    if (!el) return;
    let s = null, lastTap = 0;

    el.addEventListener("pointerdown", e => {
      if (!cfg.gestures || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (!full && e.target.closest("button, #miniSeekRing")) return;
      const r = el.getBoundingClientRect();
      s = { x: e.clientX, y: e.clientY, t: Date.now(), mode: null, left: (e.clientX - r.left) < r.width / 2, h: r.height, start: 0 };
    });

    el.addEventListener("pointermove", e => {
      if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.mode) {
        if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          s.mode = "h";
        } else if (full && Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx) * 1.2) {
          s.mode = s.left ? "bright" : "vol";
          s.start = s.left ? getBrightness() : getVolume();
        } else return;
        try { el.setPointerCapture(e.pointerId); } catch {}
      }
      if (s.mode === "bright") setBrightness(s.start - dy / (s.h * 0.8));
      else if (s.mode === "vol") setVolume(s.start - dy / (s.h * 0.8));
    });

    const finish = e => {
      if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y, dt = Date.now() - s.t, mode = s.mode;
      s = null;
      if (mode === "h") {
        lastSwipeAt = Date.now();
        if (Math.abs(dx) > 56) {
          if (dx < 0) { hud("⏭", "Next song"); playNext(); }
          else { hud("⏮", "Previous song"); playPrevious(); }
        }
        return;
      }
      if (mode) return;
      if (full && dt < 300 && Math.hypot(dx, dy) < 10) {
        const now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          const wasPlaying = isPlayingNow();
          togglePlayback();
          hud(wasPlaying ? "⏸" : "▶", wasPlaying ? "Paused" : "Playing");
        } else lastTap = now;
      }
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", () => { s = null; });
  }

  /* A swipe on the mini player must not also open the full player. */
  function guardMiniClick() {
    const mini = $("#miniPlayer");
    if (!mini) return;
    mini.addEventListener("click", e => {
      if (Date.now() - lastSwipeAt < 450) { e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
  }

  /* -------------------------------------------------------
     Song change detection
  ------------------------------------------------------- */
  let lastSongId = null;

  /* Re-trigger a CSS animation class on an element. */
  function bump(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    clearTimeout(el._bumpTimer);
    el._bumpTimer = setTimeout(() => el.classList.remove(cls), ms || 700);
  }
  const reducedMotion = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  function motionOnSongChange() {
    if (reducedMotion()) return;
    bump($("#bigArt"), "art-swap", 700);
    bump($("#miniArt"), "art-swap", 700);
    ["#bigTitle", "#bigArtist", "#miniTitle", "#miniArtist"].forEach(id => bump($(id), "text-swap", 600));
  }

  /* Rows cascade in when the list itself changes (search, sort, tab), not on every re-render. */
  function watchListEntrance(selector) {
    const list = $(selector);
    if (!list || typeof MutationObserver === "undefined") return;
    let signature = "";
    new MutationObserver(() => {
      const n = list.children.length;
      const first = n ? (list.children[0].dataset.songId || list.children[0].dataset.playlistSong || list.children[0].textContent.slice(0, 24)) : "";
      const last = n ? (list.children[n - 1].dataset.songId || list.children[n - 1].dataset.playlistSong || list.children[n - 1].textContent.slice(0, 24)) : "";
      const mid = n > 2 ? (list.children[n >> 1].dataset.songId || list.children[n >> 1].dataset.playlistSong || "") : "";
      const next = n + "|" + first + "|" + mid + "|" + last;
      if (next === signature) return;
      signature = next;
      if (n > 0 && !reducedMotion()) bump(list, "luxe-stagger", 1000);
    }).observe(list, { childList: true });
  }

  function onSongChanged() {
    const song = currentSong();
    lastSongId = song ? song.id : null;
    motionOnSongChange();
    refreshChips();
    if (!$("#speedPanel").classList.contains("hidden")) renderSpeed();
    if (!$("#slowPanel").classList.contains("hidden")) renderSlow();
    refreshVizText();
    applyBrowserFx();
    updateDynamicArt();
  }
  function checkSongChanged() {
    const song = currentSong();
    const id = song ? song.id : null;
    if (id !== lastSongId) onSongChanged();
  }

  /* -------------------------------------------------------
     Hook into app.js
  ------------------------------------------------------- */
  function installHooks() {
    // Songs started from anywhere in the app.
    if (typeof startQueue === "function") {
      const original = startQueue;
      window.startQueue = function () {
        const result = original.apply(this, arguments);
        setTimeout(checkSongChanged, 0);
        return result;
      };
    }

    // Browser mode: apply saved names after the library is built.
    if (typeof buildLibrary === "function") {
      const original = buildLibrary;
      window.buildLibrary = async function () {
        const result = await original.apply(this, arguments);
        applyOverridesToSongs();
        refreshAfterSongsChanged();
        return result;
      };
    }

    // Native song changes (next song, crossfade, notification buttons).
    if (typeof window.LuxeAndroidNativeState === "function") {
      const original = window.LuxeAndroidNativeState;
      window.LuxeAndroidNativeState = function () {
        const result = original.apply(this, arguments);
        checkSongChanged();
        return result;
      };
    }

    const bridgeObj = window.LUXEAndroid;
    if (bridgeObj) {
      // Re-apply saved names to the library Android sends, and tell the service our settings.
      const originalFolder = bridgeObj.onFolderSelected;
      bridgeObj.onFolderSelected = function (payload) {
        try {
          const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
          if (parsed && Array.isArray(parsed.songs)) {
            parsed.songs.forEach(item => {
              const o = nameOverrides[item.id];
              if (o) { if (o.title) item.title = o.title; if (o.artist) item.artist = o.artist; }
            });
            if (parsed.songs.length) {
              const valid = new Set(parsed.songs.map(item => item.id));
              let changed = false;
              for (const id in nameOverrides) if (!valid.has(id)) { delete nameOverrides[id]; changed = true; }
              for (const id in songFx) if (!valid.has(id)) { delete songFx[id]; changed = true; }
              if (changed) { saveOverrides(); saveSongFx(); }
            }
            payload = JSON.stringify(parsed);
          }
        } catch {}
        const result = originalFolder.call(this, payload);
        pushConfig(true);
        return result;
      };

      const originalMeta = bridgeObj.onNativeSongMetadataUpdated;
      bridgeObj.onNativeSongMetadataUpdated = function (data) {
        try {
          const parsed = typeof data === "string" ? JSON.parse(data) : data;
          const o = parsed && nameOverrides[parsed.id];
          if (o) { if (o.title) parsed.title = o.title; if (o.artist) parsed.artist = o.artist; data = JSON.stringify(parsed); }
        } catch {}
        return originalMeta.call(this, data);
      };

      const originalArt = bridgeObj.onNativeArtworkUpdated;
      bridgeObj.onNativeArtworkUpdated = function (id) {
        const result = originalArt.apply(this, arguments);
        const song = currentSong();
        if (song && String(song.id) === String(id)) updateDynamicArt();
        return result;
      };

      bridgeObj.onSongRenamed = onSongRenamed;
      bridgeObj.onSongsDeleted = onSongsDeleted;
      bridgeObj.onAudioPermission = function (granted) {
        if (!granted && viz.open) {
          toast("Audio permission was not granted, so the visualizer uses a simple animation. Allow it in Android settings for the real thing.", 6000);
        }
      };
    }
  }

  /* -------------------------------------------------------
     Wire up the page
  ------------------------------------------------------- */
  function bindPanelDismiss(id, canClose) {
    const panel = $(id);
    if (!panel) return;
    panel.addEventListener("click", e => {
      if (e.target === panel && (!canClose || canClose())) closePanel(id);
    });
  }

  function wire() {
    // Song menu / rename / delete
    $("#closeSongMenu")?.addEventListener("click", () => closePanel("#songMenuPanel"));
    $("#menuRename")?.addEventListener("click", () => { const id = menuSongId; closePanel("#songMenuPanel"); openRename(id); });
    $("#menuDelete")?.addEventListener("click", () => { const id = menuSongId; closePanel("#songMenuPanel"); confirmDelete([id]); });
    $("#closeRename")?.addEventListener("click", () => closePanel("#renamePanel"));
    $("#renameSave")?.addEventListener("click", saveRename);
    ["#renameTitle", "#renameArtist"].forEach(id => $(id)?.addEventListener("keydown", e => { if (e.key === "Enter") saveRename(); }));
    $("#closeDelete")?.addEventListener("click", () => closePanel("#deletePanel"));
    $("#deleteCancel")?.addEventListener("click", () => closePanel("#deletePanel"));
    $("#deleteConfirm")?.addEventListener("click", () => { const ids = pendingDeleteIds; pendingDeleteIds = []; closePanel("#deletePanel"); doDelete(ids); });
    $("#playerMoreBtn")?.addEventListener("click", () => { const song = currentSong(); if (song) openSongMenu(song.id); });

    // The ⋮ button on song rows (library and playlists). Runs before the list's own tap-to-play handler.
    document.addEventListener("click", e => {
      const more = e.target.closest && e.target.closest("[data-song-menu]");
      if (!more) return;
      e.stopPropagation();
      e.preventDefault();
      openSongMenu(more.dataset.songMenu);
    }, true);

    // Speed
    $("#speedBtn")?.addEventListener("click", () => { renderSpeed(); openPanel("#speedPanel"); });
    $("#closeSpeed")?.addEventListener("click", () => closePanel("#speedPanel"));
    $("#speedRange")?.addEventListener("input", e => { paintRange(e.target); setSpeed(e.target.value); });
    $("#speedChips")?.addEventListener("click", e => { const b = e.target.closest("[data-speed]"); if (b) setSpeed(b.dataset.speed); });
    $("#speedReset")?.addEventListener("click", () => setSpeed(1));
    $("#speedSongSwitch")?.addEventListener("change", e => setSongScope(e.target.checked));

    // Slow reverb
    $("#slowBtn")?.addEventListener("click", () => { renderSlow(); openPanel("#slowPanel"); });
    $("#closeSlow")?.addEventListener("click", () => closePanel("#slowPanel"));
    $("#slowOn")?.addEventListener("change", e => changeSlow({ on: e.target.checked }, true));
    $("#slowRate")?.addEventListener("input", e => changeSlow({ rate: round2(Number(e.target.value)), on: true }));
    $("#slowReverb")?.addEventListener("input", e => changeSlow({ reverb: Math.round(Number(e.target.value)), on: true }));
    $("#slowRoom")?.addEventListener("input", e => changeSlow({ room: Math.round(Number(e.target.value)), on: true }));
    $("#slowSongSwitch")?.addEventListener("change", e => setSongScope(e.target.checked));
    $("#slowReset")?.addEventListener("click", () => changeSlow({ ...DEFAULT_SLOW, on: false }, true));
    $("#slowPresets")?.addEventListener("click", e => {
      const del = e.target.closest("[data-del-preset]");
      if (del) {
        customPresets = customPresets.filter(p => p.id !== del.dataset.delPreset);
        savePresets();
        const t = fxTarget();
        if (t.slow.presetId === del.dataset.delPreset) { t.slow.presetId = null; persistTarget(t); }
        renderSlow();
        return;
      }
      const chip = e.target.closest("[data-preset]");
      if (chip) applyPreset(chip.dataset.preset);
    });
    $("#slowSavePreset")?.addEventListener("click", () => {
      $("#slowSaveRow").classList.toggle("hidden");
      if (!$("#slowSaveRow").classList.contains("hidden")) $("#slowPresetName").focus();
    });
    const savePreset = () => {
      const name = $("#slowPresetName").value.trim();
      if (!name) { $("#slowPresetName").focus(); return; }
      const fx = fxTarget();
      const preset = { id: "u" + Date.now().toString(36), name, rate: fx.slow.rate, reverb: fx.slow.reverb, room: fx.slow.room };
      customPresets.push(preset);
      savePresets();
      $("#slowPresetName").value = "";
      $("#slowSaveRow").classList.add("hidden");
      changeSlow({ presetId: preset.id }, true);
      toast(`Preset "${name}" saved.`);
    };
    $("#slowPresetSave")?.addEventListener("click", savePreset);
    $("#slowPresetName")?.addEventListener("keydown", e => { if (e.key === "Enter") savePreset(); });

    // Duplicates
    $("#dupFinderBtn")?.addEventListener("click", () => { closePanel("#themePanel"); renderDuplicates(); openPanel("#duplicatesPanel"); });
    $("#closeDuplicates")?.addEventListener("click", () => closePanel("#duplicatesPanel"));
    $("#dupList")?.addEventListener("change", e => {
      const box = e.target.closest("[data-dup]");
      if (!box) return;
      if (box.checked) dupSelection.add(box.dataset.dup); else dupSelection.delete(box.dataset.dup);
      updateDupFooter();
    });
    $("#dupDelete")?.addEventListener("click", deleteSelectedDuplicates);

    // Roulette
    $("#rouletteBtn")?.addEventListener("click", spinRoulette);
    $("#rouletteAgain")?.addEventListener("click", spinRoulette);
    $("#rouletteDone")?.addEventListener("click", () => closePanel("#roulettePanel"));
    $("#closeRoulette")?.addEventListener("click", () => { if (!rouletteBusy) closePanel("#roulettePanel"); });

    // Visualizer
    $("#vizBtn")?.addEventListener("click", openViz);
    $("#vizClose")?.addEventListener("click", e => { e.stopPropagation(); closeViz(); });
    $("#vizStyle")?.addEventListener("click", e => {
      e.stopPropagation();
      viz.style = VIZ_STYLES[(VIZ_STYLES.indexOf(viz.style) + 1) % VIZ_STYLES.length];
      cfg.vizStyle = viz.style; saveCfg();
      $("#vizStyle").textContent = VIZ_LABELS[viz.style];
      showVizUi();
    });
    $("#vizPrev")?.addEventListener("click", e => { e.stopPropagation(); playPrevious(); showVizUi(); });
    $("#vizNext")?.addEventListener("click", e => { e.stopPropagation(); playNext(); showVizUi(); });
    $("#vizPlay")?.addEventListener("click", e => { e.stopPropagation(); togglePlayback(); showVizUi(); });
    $("#vizCanvas")?.addEventListener("click", () => {
      const panel = $("#visualizerPanel");
      if (panel.classList.contains("viz-ui-hidden")) showVizUi(); else { panel.classList.add("viz-ui-hidden"); clearTimeout(viz.uiTimer); }
    });
    window.addEventListener("resize", () => { if (viz.open) resizeViz(); });

    // Settings panel
    const dyn = $("#dynArtSwitch");
    if (dyn) { dyn.checked = cfg.dynArt; dyn.addEventListener("change", () => { cfg.dynArt = dyn.checked; saveCfg(); updateDynamicArt(); }); }

    const cfSwitch = $("#cfSwitch"), cfRange = $("#cfSeconds"), cfLabel = $("#cfLabel");
    const syncCrossfadeUi = () => {
      cfSwitch.checked = cfg.crossfadeOn;
      cfRange.value = cfg.crossfadeSec; paintRange(cfRange);
      cfRange.disabled = !cfg.crossfadeOn;
      cfLabel.textContent = cfg.crossfadeSec + " s";
      const note = $("#cfNote");
      if (note) note.textContent = nativeBridge()
        ? "The end of one song fades out while the next fades in."
        : "Crossfade plays in the Android app. A browser plays songs one after another.";
    };
    if (cfSwitch && cfRange) {
      syncCrossfadeUi();
      cfSwitch.addEventListener("change", () => { cfg.crossfadeOn = cfSwitch.checked; saveCfg(); syncCrossfadeUi(); pushConfig(true); });
      cfRange.addEventListener("input", () => { cfg.crossfadeSec = Number(cfRange.value); saveCfg(); syncCrossfadeUi(); pushConfig(); });
    }

    const gesture = $("#gestureSwitch");
    const applyGestureClass = () => document.documentElement.classList.toggle("gestures-on", !!cfg.gestures);
    if (gesture) { gesture.checked = cfg.gestures; gesture.addEventListener("change", () => { cfg.gestures = gesture.checked; saveCfg(); applyGestureClass(); }); }
    applyGestureClass();

    bindGestures($("#bigArt"), true);
    bindGestures($("#miniPlayer"), false);
    guardMiniClick();

    // Closing a panel by tapping the dark area around it
    ["#songMenuPanel", "#renamePanel", "#deletePanel", "#speedPanel", "#slowPanel", "#duplicatesPanel"].forEach(id => bindPanelDismiss(id));
    bindPanelDismiss("#roulettePanel", () => !rouletteBusy);

    // The volume slider also controls the phone's music volume in the Android app.
    $("#volume")?.addEventListener("input", e => { if (nativeBridge()) bridge("setSystemVolume", Number(e.target.value)); });
    if (nativeBridge()) { const v = bridge("getSystemVolume"); if (typeof v === "number" && $("#volume")) $("#volume").value = v; }
  }

  installHooks();
  wire();
  watchListEntrance("#songList");
  watchListEntrance("#playlistSongs");
  applyOverridesToSongs();
  refreshChips();
  pushConfig(true);

  window.LuxeFeatures = { openSongMenu, spinRoulette, openViz, closeViz, rouletteBusy: () => rouletteBusy, findDuplicateGroups, _state: () => ({ cfg, songFx, customPresets, nameOverrides }) };
})();

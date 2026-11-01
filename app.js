"use strict";

/* =========================================================
   LUXE MUSIC V4
   Native Android Folder Picker + Browser Fallback
   ========================================================= */


/* =========================================================
   SHORTCUTS
   ========================================================= */

const $ = selector => document.querySelector(selector);

const audio = $("#audio");

const DB_NAME = "luxe_music_database";
const DB_VERSION = 1;
const FILE_STORE = "files";
const SETTINGS_STORE = "settings";

const AUDIO_EXTENSIONS =
  /\.(mp3|m4a|flac|wav|aac|ogg|opus|webm|oga)$/i;


/* =========================================================
   STATE
   ========================================================= */

let songs = [];
let current = -1;

let currentQueue = [];
// Keeps the unshuffled order so Random/Consecutive can switch immediately.
let currentQueueBase = [];
let queuePosition = -1;

let repeat = false;

let viewMode =
  localStorage.getItem("luxe_view_mode") || "list";

let libraryView = "songs";
let collectionType = null;
let collectionValue = null;

let folderFiles = [];

let currentPlaylistId = null;

let selectedPlaylistSongs = new Set();

let favorites = [];
let recent = [];
let playlists = [];
let playlistPreferences = {};
try { playlistPreferences = JSON.parse(localStorage.getItem("luxe_playlist_preferences") || "{}"); } catch { playlistPreferences = {}; }
function getPlaylistPreferences(id = currentPlaylistId) {
  if (!id) return { view: viewMode, sort: luxeSortMode, playing: "consecutive" };
  if (!playlistPreferences[id]) playlistPreferences[id] = { view: "list", sort: "title-az", playing: "consecutive" };
  return playlistPreferences[id];
}
function savePlaylistPreferences() { saveJSON("luxe_playlist_preferences", playlistPreferences); }


let creatingPlaylist = false;
let addSongsBusy = false;
let folderPickerBusy = false;

let nativeLibraryLoaded = false;
let nativeFolderMode = false;

/* =========================================================
   ARTWORK + SORT STATE
   ========================================================= */
let luxeSortMode = localStorage.getItem("luxe_sort_mode") || "title-az";
let luxePlayCounts = {};
let luxeAddedAt = {};

try {
  luxePlayCounts = JSON.parse(localStorage.getItem("luxe_play_counts") || "{}");
} catch { luxePlayCounts = {}; }
try {
  luxeAddedAt = JSON.parse(localStorage.getItem("luxe_added_at") || "{}");
} catch { luxeAddedAt = {}; }

function getArtworkUrl(song) {
  if (!song) return "";
  return song.artworkUrl || song.artwork || "";
}

function setArt(element, artwork, fallback = "♪") {
  if (!element) return;
  const url = typeof artwork === "string" ? artwork : "";
  if (url) {
    element.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
    element.classList.add("has-artwork");
  } else {
    element.textContent = fallback || "♪";
    element.classList.remove("has-artwork");
  }
}

function rememberSongMetadata(song) {
  if (!song || !song.id) return;
  if (!luxeAddedAt[song.id]) {
    luxeAddedAt[song.id] = Date.now();
    saveJSON("luxe_added_at", luxeAddedAt);
  }
  if (luxePlayCounts[song.id] == null) {
    luxePlayCounts[song.id] = 0;
  }
}

function sortSongs(list) {
  const result = [...list];
  const alpha = (a,b) => String(a || "").localeCompare(String(b || ""), undefined, {sensitivity:"base", numeric:true});
  switch (luxeSortMode) {
    case "title-za": return result.sort((a,b) => alpha(b.title,a.title));
    case "added-new": return result.sort((a,b) => (luxeAddedAt[b.id]||b.lastModified||0) - (luxeAddedAt[a.id]||a.lastModified||0));
    case "added-old": return result.sort((a,b) => (luxeAddedAt[a.id]||a.lastModified||0) - (luxeAddedAt[b.id]||b.lastModified||0));
    case "recent": {
      const rank = new Map(recent.map((id,i)=>[id,i]));
      return result.sort((a,b) => (rank.get(a.id) ?? 999999) - (rank.get(b.id) ?? 999999));
    }
    case "most-played": return result.sort((a,b) => (luxePlayCounts[b.id]||0) - (luxePlayCounts[a.id]||0) || alpha(a.title,b.title));
    default: return result.sort((a,b) => alpha(a.title,b.title));
  }
}

function artworkDataUri(bytes, mime = "image/jpeg") {
  if (!bytes || !bytes.length) return "";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 32768, bytes.length)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function extractArtwork(file) {
  if (!file) return "";
  try {
    const b = new Uint8Array(await file.arrayBuffer());
    const name = String(file.name || "").toLowerCase();
    const u32 = (o) => o + 4 <= b.length ? (((b[o] * 0x1000000) + (b[o+1] << 16) + (b[o+2] << 8) + b[o+3]) >>> 0) : 0;
    const latin = (a, z) => new TextDecoder("latin1").decode(b.slice(a, z));

    // MP3: ID3 APIC embedded cover art.
    if (name.endsWith(".mp3") && b.length > 10 && latin(0, 3) === "ID3") {
      const version = b[3];
      const tagSize = version >= 4 ? ((b[6]&127)<<21)|((b[7]&127)<<14)|((b[8]&127)<<7)|(b[9]&127) : (b[6]<<21)|(b[7]<<14)|(b[8]<<7)|b[9];
      let o = 10, limit = Math.min(b.length, 10 + tagSize);
      while (o + 10 <= limit) {
        const id = latin(o, o + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const n = version >= 4 ? ((b[o+4]&127)<<21)|((b[o+5]&127)<<14)|((b[o+6]&127)<<7)|(b[o+7]&127) : u32(o+4);
        if (!n || o + 10 + n > limit) break;
        if (id === "APIC") {
          let i = o + 10; const encoding = b[i++]; const mimeStart = i;
          while (i < o + 10 + n && b[i] !== 0) i++;
          const mime = latin(mimeStart, i) || "image/jpeg"; i++; i++;
          if (encoding === 1 || encoding === 2) { while (i + 1 < o + 10 + n && !(b[i] === 0 && b[i+1] === 0)) i += 2; i += 2; }
          else { while (i < o + 10 + n && b[i] !== 0) i++; i++; }
          const imageBytes = b.slice(i, o + 10 + n);
          if (imageBytes.length) return artworkDataUri(imageBytes, mime);
        }
        o += 10 + n;
      }
    }

    // FLAC: PICTURE metadata block.
    if (name.endsWith(".flac") && latin(0, 4) === "fLaC") {
      let o = 4;
      while (o + 4 <= b.length) {
        const header = b[o], type = header & 0x7f, size = (b[o+1] << 16) | (b[o+2] << 8) | b[o+3];
        const a = o + 4, z = a + size;
        if (z > b.length || size <= 0) break;
        if (type === 6 && size > 32) {
          let q = a + 4;
          const mimeLen = u32(q); q += 4;
          const mime = latin(q, q + mimeLen) || "image/jpeg"; q += mimeLen;
          const descLen = u32(q); q += 4 + descLen;
          q += 16; // width, height, color depth, indexed colors
          const imageLen = u32(q); q += 4;
          if (imageLen > 0 && q + imageLen <= z) return artworkDataUri(b.slice(q, q + imageLen), mime);
        }
        o = z;
        if (header & 0x80) break;
      }
    }

    // M4A/MP4: Apple covr/data atom containing JPEG or PNG cover art.
    if (/\.(m4a|mp4|aac)$/.test(name)) {
      const covr = latin(0, b.length).indexOf("covr");
      if (covr >= 0) {
        const dataAt = latin(covr + 4, Math.min(b.length, covr + 80)).indexOf("data");
        if (dataAt >= 0) {
          const payload = covr + 4 + dataAt + 12;
          if (payload < b.length) {
            let mime = "image/jpeg", begin = payload;
            if (b[begin] === 0x89 && latin(begin + 1, begin + 4) === "PNG") mime = "image/png";
            else if (latin(begin, begin + 3) === "GIF") mime = "image/gif";
            // Some atoms include an extra 8-byte atom header before the image.
            if (!(b[begin] === 0xff && b[begin+1] === 0xd8) && !(b[begin] === 0x89 && latin(begin+1, begin+4) === "PNG")) {
              const jpeg = b.indexOf(0xff, begin);
              if (jpeg >= 0 && b[jpeg+1] === 0xd8) begin = jpeg;
            }
            const imageBytes = b.slice(begin);
            if (imageBytes.length > 100) return artworkDataUri(imageBytes, mime);
          }
        }
      }
    }
  } catch (error) {
    console.debug("LUXE: no readable embedded artwork", file?.name, error);
  }
  return "";
}

/* =========================================================
   RESTORE LOCAL DATA
   ========================================================= */

try {
  favorites = JSON.parse(
    localStorage.getItem("luxe_favorites") || "[]"
  );
} catch {
  favorites = [];
}

try {
  recent = JSON.parse(
    localStorage.getItem("luxe_recent") || "[]"
  );
} catch {
  recent = [];
}

try {
  playlists = JSON.parse(
    localStorage.getItem("luxe_playlists") || "[]"
  );
} catch {
  playlists = [];
}


/* =========================================================
   HELPERS
   ========================================================= */

function esc(value) {
  return String(value ?? "")
    .replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
}


function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  return (
    Math.floor(seconds / 60) +
    ":" +
    String(Math.floor(seconds % 60)).padStart(2, "0")
  );
}


function hourGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) {
    return "Good morning";
  }

  if (hour < 18) {
    return "Good afternoon";
  }

  return "Good evening";
}


function isFav(song) {
  return !!song && favorites.includes(song.id);
}


function makeId(file) {
  return [
    file.name,
    file.size,
    file.lastModified
  ].join("|");
}


function isAudioFile(file) {
  if (!file) {
    return false;
  }

  return (
    (file.type || "")
      .toLowerCase()
      .startsWith("audio/") ||
    AUDIO_EXTENSIONS.test(file.name || "")
  );
}


function parseName(file) {
  const name = file.name
    .replace(/\.[^/.]+$/, "")
    .trim();

  let artist = "Unknown Artist";
  let title = name;
  let album = "Local Music";

  const parts = name.split(/\s[-–—]\s/);

  if (parts.length >= 2) {
    artist = parts[0].trim();

    title = parts
      .slice(1)
      .join(" - ")
      .trim();
  }

  return {
    title,
    artist,
    album
  };
}


function saveJSON(key, value) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(value)
    );
  } catch {}
}


function shuffleArray(array) {
  for (
    let i = array.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      array[i],
      array[j]
    ] = [
      array[j],
      array[i]
    ];
  }

  return array;
}


/* =========================================================
   ANDROID NATIVE DETECTION
   ========================================================= */

function isNativeAndroid() {
  return !!(
    window.LuxeAndroid &&
    typeof window.LuxeAndroid.pickMusicFolder ===
      "function"
  );
}


/* =========================================================
   INDEXED DB
   ========================================================= */

let dbPromise = null;


function openDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise(resolve => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }

    let request;

    try {
      request = indexedDB.open(
        DB_NAME,
        DB_VERSION
      );
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (
        !db.objectStoreNames.contains(
          FILE_STORE
        )
      ) {
        db.createObjectStore(
          FILE_STORE,
          {
            keyPath: "id"
          }
        );
      }

      if (
        !db.objectStoreNames.contains(
          SETTINGS_STORE
        )
      ) {
        db.createObjectStore(
          SETTINGS_STORE,
          {
            keyPath: "key"
          }
        );
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        db.close();
      };

      resolve(db);
    };

    request.onerror = () => {
      resolve(null);
    };
  });

  return dbPromise;
}


async function saveFilesToDatabase(files) {
  const db = await openDB();

  if (!db || !files.length) {
    return false;
  }

  return new Promise(resolve => {
    try {
      const transaction =
        db.transaction(
          FILE_STORE,
          "readwrite"
        );

      const store =
        transaction.objectStore(
          FILE_STORE
        );

      for (const file of files) {
        store.put({
          id: makeId(file),
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          type: file.type,
          file
        });
      }

      transaction.oncomplete =
        () => resolve(true);

      transaction.onerror =
        () => resolve(false);

      transaction.onabort =
        () => resolve(false);

    } catch {
      resolve(false);
    }
  });
}


async function loadFilesFromDatabase() {
  const db = await openDB();

  if (!db) {
    return [];
  }

  return new Promise(resolve => {
    try {
      const transaction =
        db.transaction(
          FILE_STORE,
          "readonly"
        );

      const store =
        transaction.objectStore(
          FILE_STORE
        );

      const request =
        store.getAll();

      request.onsuccess = () => {
        const result =
          request.result || [];

        resolve(
          result
            .map(item => item.file)
            .filter(Boolean)
        );
      };

      request.onerror =
        () => resolve([]);

    } catch {
      resolve([]);
    }
  });
}


async function saveSetting(key, value) {
  const db = await openDB();

  if (!db) {
    return;
  }

  try {
    const transaction =
      db.transaction(
        SETTINGS_STORE,
        "readwrite"
      );

    transaction
      .objectStore(
        SETTINGS_STORE
      )
      .put({
        key,
        value
      });

  } catch {}
}


async function getSetting(key) {
  const db = await openDB();

  if (!db) {
    return null;
  }

  return new Promise(resolve => {
    try {
      const transaction =
        db.transaction(
          SETTINGS_STORE,
          "readonly"
        );

      const request =
        transaction
          .objectStore(
            SETTINGS_STORE
          )
          .get(key);

      request.onsuccess = () => {
        resolve(
          request.result
            ? request.result.value
            : null
        );
      };

      request.onerror =
        () => resolve(null);

    } catch {
      resolve(null);
    }
  });
}


/* =========================================================
   FOLDER PICKER
   ========================================================= */

const chooseFolderBtn =
  $("#chooseFolderBtn");

const folderInput =
  $("#folderInput");


function setFolderStatus(message) {
  const status =
    $("#folderStatus");

  if (status) {
    status.textContent =
      message;
  }
}


/* ---------------------------------------------------------
   OPEN MUSIC FOLDER
--------------------------------------------------------- */

function openMusicFolder() {
  if (folderPickerBusy) {
    return;
  }

  folderPickerBusy = true;

  /*
    IMPORTANT:
    Android native picker comes FIRST.
  */

  if (isNativeAndroid()) {
    nativeFolderMode = true;

    setFolderStatus(
      "Opening music folder..."
    );

    try {
      window.LuxeAndroid.pickMusicFolder();

    } catch (error) {

      console.error(
        "Native folder picker error:",
        error
      );

      setFolderStatus(
        "Unable to open the music folder picker."
      );

      folderPickerBusy = false;
    }

    return;
  }


  /*
    Browser fallback
  */

  nativeFolderMode = false;

  if (
    typeof window.showDirectoryPicker ===
    "function"
  ) {

    window.showDirectoryPicker({
      mode: "read"
    })
    .then(async directory => {

      const files = [];

      await collectDirectoryFiles(
        directory,
        files
      );

      if (files.length) {

        await loadSelectedFiles(
          files
        );

      } else {

        setFolderStatus(
          "No supported music files were found."
        );
      }

    })
    .catch(error => {

      if (
        error &&
        error.name === "AbortError"
      ) {
        return;
      }

      if (folderInput) {
        folderInput.value = "";
        folderInput.click();
      }

    })
    .finally(() => {

      setTimeout(() => {
        folderPickerBusy = false;
      }, 300);

    });

    return;
  }


  /*
    Older browser fallback
  */

  if (folderInput) {
    folderInput.value = "";
    folderInput.click();
  }

  setTimeout(() => {
    folderPickerBusy = false;
  }, 300);
}


/* ---------------------------------------------------------
   BROWSER DIRECTORY SCANNER
   --------------------------------------------------------- */

async function collectDirectoryFiles(
  directory,
  output
) {
  for await (
    const entry of directory.values()
  ) {

    /*
      LUXE scans ONLY the selected folder.
      Subfolders are intentionally ignored.
    */

    if (entry.kind !== "file") {
      continue;
    }

    try {

      const file =
        await entry.getFile();

      if (isAudioFile(file)) {
        output.push(file);
      }

    } catch {}
  }
}


/* ---------------------------------------------------------
   SELECT BUTTON
--------------------------------------------------------- */

if (chooseFolderBtn) {

  chooseFolderBtn.addEventListener(
    "click",
    event => {

      event.preventDefault();
      event.stopPropagation();

      openMusicFolder();

    }
  );
}


/* ---------------------------------------------------------
   BROWSER FILE INPUT
--------------------------------------------------------- */

if (folderInput) {

  folderInput.addEventListener(
    "change",
    async event => {

      if (folderPickerBusy) {
        return;
      }

      const files =
        [
          ...(event.target.files || [])
        ].filter(isAudioFile);

      if (!files.length) {

        setFolderStatus(
          "No supported music files were found."
        );

        return;
      }

      await loadSelectedFiles(
        files
      );

    }
  );
}


/* =========================================================
   NATIVE ANDROID CALLBACKS
   ========================================================= */

/*
  MainActivity.java calls:

  window.LUXEAndroid.onFolderSelected(payload)

  The payload contains:

  {
    folderUri: "...",
    count: 10,
    songs: [
      {
        id: "...",
        name: "...",
        mime: "...",
        size: 123,
        lastModified: 123,
        url: "https://luxe.local/audio/TOKEN",
        title: "...",
        artist: "...",
        album: "Local Music"
      }
    ]
  }
*/

window.LUXEAndroid = {

  /* -------------------------------------------------------
     NATIVE FOLDER SELECTED
  ------------------------------------------------------- */

  onFolderSelected(payload) {

    try {

      /*
        MainActivity sends a JSON string using
        JSONObject.quote(), so normally payload
        arrives here as a string.
      */

      if (
        typeof payload === "string"
      ) {
        payload =
          JSON.parse(payload);
      }


      const nativeSongs =
        Array.isArray(
          payload?.songs
        )
          ? payload.songs
          : [];


      if (!nativeSongs.length) {

        songs = [];

        nativeLibraryLoaded = true;

        setFolderStatus(
          "No supported music files were found."
        );

        $("#welcome")
          ?.classList.remove(
            "hidden"
          );

        $("#library")
          ?.classList.add(
            "hidden"
          );

        $("#nav")
          ?.classList.add(
            "hidden"
          );

        folderPickerBusy =
          false;

        return;
      }


      /*
        Native Android is now the
        source of the music library.
      */

      nativeLibraryLoaded =
        true;

      nativeFolderMode =
        true;


      songs =
        nativeSongs.map(
          (item, index) => ({

            /*
              Native content URI is used
              as the stable ID.
            */

            id:
              item.id,

            title:
              item.title ||
              item.name ||
              "Unknown",

            artist:
              item.artist ||
              "Unknown Artist",

            album:
              item.album ||
              "Local Music",

            artwork:
              item.artwork || item.artworkUrl || null,

            artworkUrl:
              item.artworkUrl || item.artwork || "",

            /*
              Native songs do not use
              browser File objects.
            */

            file:
              null,

            /*
              MainActivity creates this
              special intercepted URL.
            */

            nativeUrl:
              item.url,

            name:
              item.name,

            size:
              Number(
                item.size || 0
              ),

            lastModified:
              Number(
                item.lastModified || 0
              ),

            mime:
              item.mime ||
              "audio/*",

            index

          })
        );


      songs.forEach(rememberSongMetadata);
      saveJSON("luxe_play_counts", luxePlayCounts);
      saveJSON("luxe_added_at", luxeAddedAt);

      folderFiles = [];


      /*
        Keep favorites only for
        songs that still exist.
      */

      const validIds =
        new Set(
          songs.map(
            song =>
              song.id
          )
        );


      favorites =
        favorites.filter(
          id =>
            validIds.has(id)
        );


      recent =
        recent.filter(
          id =>
            validIds.has(id)
        );


      /*
        Clean playlist songs.
      */

      playlists =
        playlists.map(
          playlist => ({

            ...playlist,

            songs:
              Array.isArray(
                playlist.songs
              )
                ? playlist.songs.filter(
                    id =>
                      validIds.has(id)
                  )
                : []

          })
        );


      saveJSON(
        "luxe_favorites",
        favorites
      );

      saveJSON(
        "luxe_recent",
        recent
      );

      saveJSON(
        "luxe_playlists",
        playlists
      );


      /*
        Show LUXE library.
      */

      $("#welcome")
        ?.classList.add(
          "hidden"
        );

      $("#library")
        ?.classList.remove(
          "hidden"
        );

      $("#nav")
        ?.classList.remove(
          "hidden"
        );


      if ($("#hello")) $("#hello").textContent = "LUXE Music";


      setFolderStatus(
        `${songs.length} music files loaded locally.`
      );


      updateStats();

      renderHome();

      render();

      updateViewButtons();


    } catch (error) {

      console.error(
        "LUXE native folder error:",error
      );

      nativeLibraryLoaded =
        false;

      setFolderStatus(
        "Unable to load the selected music folder."
      );

    } finally {

      folderPickerBusy =
        false;

    }
  },


  onNativeArtworkUpdated(songId, artwork) {
    const song = songs.find(item => String(item.id) === String(songId));
    if (!song) return;

    song.artwork = artwork || "";
    song.artworkUrl = artwork || "";

    // Update only this song's artwork nodes. Re-rendering the complete
    // library for every cover makes large libraries feel frozen.
    document.querySelectorAll(".art[data-art-song]").forEach(element => {
      if (element.dataset.artSong !== String(songId)) return;
      if (!artwork) {
        element.classList.remove("has-artwork");
        element.classList.add("no-artwork");
        element.replaceChildren(document.createTextNode("♫"));
        return;
      }
      element.classList.remove("no-artwork");
      element.classList.add("has-artwork");
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.src = artwork;
      element.replaceChildren(image);
    });

    updatePlayerArtwork();
  },

  onNativeSongMetadataUpdated(songData) {
    let data = songData;
    try { if (typeof data === "string") data = JSON.parse(data); } catch { return; }
    const song = songs.find(item => String(item.id) === String(data?.id));
    if (!song) return;

    Object.assign(song, {
      title: data.title || song.title,
      artist: data.artist || song.artist,
      album: data.album || song.album
    });

    // Update the existing row instead of rebuilding the whole library for
    // every metadata callback from Android's background scanner.
    document.querySelectorAll(".song[data-song-id]").forEach(row => {
      if (row.dataset.songId !== String(song.id)) return;
      const title = row.querySelector(".song-info strong");
      const details = row.querySelector(".song-info span");
      if (title) title.textContent = song.title;
      if (details) details.textContent = `${song.artist} • ${song.album}`;
    });
    updatePlayer();
  },

  onNativeStatus(message) {
    setFolderStatus(String(message || ""));
  },

  /* -------------------------------------------------------
     NATIVE ERROR
  ------------------------------------------------------- */

  onError(message) {

    console.error(
      "LUXE Android:",
      message
    );

    folderPickerBusy =
      false;

    setFolderStatus(
      message ||
      "Unable to read the selected folder."
    );
  },


  /* -------------------------------------------------------
     NATIVE FOLDER CLEARED
  ------------------------------------------------------- */

  onFolderCleared() {

    nativeLibraryLoaded =
      false;

    nativeFolderMode =
      true;

    songs = [];

    current = -1;

    currentQueue = [];
    currentQueueBase = [];

    queuePosition = -1;

    folderFiles = [];

    if (audio) {

      audio.pause();

      audio.removeAttribute(
        "src"
      );

      audio.load();
    }


    $("#welcome")
      ?.classList.remove(
        "hidden"
      );

    $("#library")
      ?.classList.add(
        "hidden"
      );

    $("#nav")
      ?.classList.add(
        "hidden"
      );

    $("#miniPlayer")
      ?.classList.add(
        "hidden"
      );


    setFolderStatus(
      "Music folder cleared."
    );


    updateStats();

    renderHome();

    render();

  }

};


/* =========================================================
   BUILD LIBRARY FROM BROWSER FILES
   ========================================================= */

async function loadSelectedFiles(files) {

  const validFiles =
    [...files].filter(
      isAudioFile
    );


  if (!validFiles.length) {

    setFolderStatus(
      "No supported music files were found."
    );

    return;
  }


  nativeLibraryLoaded =
    false;

  nativeFolderMode =
    false;


  folderFiles =
    [...validFiles];


  await saveFilesToDatabase(
    folderFiles
  );


  await buildLibrary(
    folderFiles
  );
}


async function buildLibrary(files) {

  folderFiles =
    [...files].filter(
      isAudioFile
    );


  songs =
    folderFiles.map(
      (file, index) => {

        const metadata =
          parseName(file);

        return {

          ...metadata,

          file,

          index,

          id:
            makeId(file),

          artwork:
            null,

          nativeUrl:
            null
        };
      }
    );


  const validIds =
    new Set(
      songs.map(
        song =>
          song.id
      )
    );


  favorites =
    favorites.filter(
      id =>
        validIds.has(id)
    );


  recent =
    recent.filter(
      id =>
        validIds.has(id)
    );


  playlists =
    playlists.map(
      playlist => ({

        ...playlist,

        songs:
          Array.isArray(
            playlist.songs
          )
            ? playlist.songs.filter(
                id =>
                  validIds.has(id)
              )
            : []

      })
    );


  saveJSON(
    "luxe_favorites",
    favorites
  );

  saveJSON(
    "luxe_recent",
    recent
  );

  saveJSON(
    "luxe_playlists",
    playlists
  );


  $("#welcome")
    ?.classList.add(
      "hidden"
    );

  $("#library")
    ?.classList.remove(
      "hidden"
    );

  $("#nav")
    ?.classList.remove(
      "hidden"
    );


  if ($("#hello")) $("#hello").textContent = "LUXE Music";


  setFolderStatus(
    `${songs.length} music files loaded locally.`
  );


  updateStats();

  renderHome();

  render();

  setTimeout(extractBrowserArtworkForLibrary, 50);
}


async function tryRestoreLibrary() {

  /*
    Android handles its own persistent
    folder restoration through MainActivity.java.
  */

  if (isNativeAndroid()) {
    return false;
  }


  const storedFiles =
    await loadFilesFromDatabase();


  if (!storedFiles.length) {
    return false;
  }


  await buildLibrary(
    storedFiles
  );

  return true;
}


/* =========================================================
   STATISTICS
   ========================================================= */

function updateStats() {

  const artists =
    new Set(
      songs.map(
        song =>
          song.artist
      )
    );


  const albums =
    new Set(
      songs.map(
        song =>
          song.album
      )
    );


  if ($("#songCount")) {
    $("#songCount").textContent =
      songs.length;
  }


  if ($("#artistCount")) {
    $("#artistCount").textContent =
      artists.size;
  }


  if ($("#albumCount")) {
    $("#albumCount").textContent =
      albums.size;
  }


  if ($("#homeSongCount")) {
    $("#homeSongCount").textContent =
      `${songs.length} tracks`;
  }


  if ($("#homeArtistCount")) {
    $("#homeArtistCount").textContent =
      `${artists.size} artists`;
  }


  if ($("#homePlaylistCount")) {
    $("#homePlaylistCount").textContent =
      `${playlists.length} playlists`;
  }


  if ($("#homeFavoriteCount")) {
    $("#homeFavoriteCount").textContent =
      `${favorites.length} songs`;
  }
}




async function extractBrowserArtworkForLibrary() {
  if (nativeFolderMode) return;
  const targets = songs.filter(s => s.file && !getArtworkUrl(s) && /\.(mp3|m4a|mp4|aac|flac)$/i.test(s.file.name || ""));
  for (const song of targets) {
    const art = await extractArtwork(song.file);
    if (art) {
      song.artwork = art;
      song.artworkUrl = art;
      render();
      updatePlayer();
    }
  }
}

/* =========================================================
   HOME
   ========================================================= */

function renderHome() {

  const container =
    $("#recentHome");


  if (!container) {
    return;
  }


  const recentSongs =
    recent
      .map(id =>
        songs.find(
          song =>
            song.id === id
        )
      )
      .filter(Boolean)
      .slice(0, 8);


  if (!recentSongs.length) {

    container.innerHTML = `
      <div class="empty recent-empty">
        <div class="recent-empty-icon">♪</div>
        <strong>No recently played songs</strong>
        <span>Play a song and it will appear here.</span>
      </div>
    `;

    return;
  }


  container.innerHTML =
    recentSongs
      .map(song => `

        <button
          class="recent-card"
          type="button"
          data-recent-play="${esc(song.id)}"
        >

          ${artHTML(song, "small")}

          <div class="recent-card-info">

            <strong>
              ${esc(song.title)}
            </strong>

            <span>
              ${esc(song.artist)}
            </span>

          </div>

          <div class="recent-card-play">
            ▶
          </div>

        </button>

      `)
      .join("");
}


if ($("#recentHome")) {

  $("#recentHome").addEventListener(
    "click",
    event => {

      const card =
        event.target.closest(
          "[data-recent-play]"
        );


      if (!card) {
        return;
      }


      const song =
        songs.find(
          item =>
            item.id ===
            card.dataset.recentPlay
        );


      if (song) {

        playSong(
          songs.indexOf(song),
          recent
            .map(id =>
              songs.find(
                item =>
                  item.id === id
              )
            )
            .filter(Boolean)
        );
      }
    }
  );
}


/* =========================================================
   HOME ACTION BUTTONS
   ========================================================= */

document
  .querySelectorAll(
    ".library-action"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      event => {

        event.preventDefault();

        const target =
          button.dataset.library;

        collectionType = null;

        collectionValue = null;

        setLibraryView(
          target
        );

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });

      }
    );

  });


if ($("#seeRecentBtn")) {

  $("#seeRecentBtn").addEventListener(
    "click",
    () => {

      collectionType = null;

      collectionValue = null;

      setLibraryView(
        "recent"
      );

      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });

    }
  );
}


if ($("#shuffleAllBtn")) {

  $("#shuffleAllBtn").addEventListener(
    "click",
    () => {

      if (!songs.length) {
        return;
      }


      const queue =
        shuffleArray(
          [...songs]
        );


      playSong(
        songs.indexOf(
          queue[0]
        ),
        queue
      );

    }
  );
}


if ($("#playAllBtn")) {

  $("#playAllBtn").addEventListener(
    "click",
    () => {

      if (!songs.length) {
        return;
      }


      const queue = [...songs];
      if (localStorage.getItem("luxe_playing_order") === "random") shuffleArray(queue);
      playSong(songs.indexOf(queue[0]), queue);

    }
  );
}


/* =========================================================
   VIEW MANAGEMENT
   ========================================================= */

function setLibraryView(
  view,
  value = null
) {

  libraryView =
    view;

  collectionValue =
    value;


  if (!value) {
    collectionType = null;
  }


  updateTabs();

  render();
}


function updateTabs() {

  document
    .querySelectorAll(
      ".library-tab"
    )
    .forEach(button => {

      button.classList.toggle(
        "active",
        button.dataset.library ===
          libraryView
      );

    });
}


function getSearchResults() {

  const search =
    $("#search");


  if (!search) {
    return sortSongs(songs);
  }


  const query =
    search.value
      .toLowerCase()
      .trim();


  if (!query) {
    return sortSongs(songs);
  }


  return sortSongs(songs.filter(song =>

    (
      song.title +
      " " +
      song.artist +
      " " +
      song.album
    )
      .toLowerCase()
      .includes(query)

  ));
}


/* =========================================================
   MAIN RENDER
   ========================================================= */

function render() {

  if (!$("#songList")) {
    return;
  }


  const allSongs =
    getSearchResults();


  $("#quickLibrary")
    ?.classList.add(
      "hidden"
    );


  if ($("#breadcrumb")) {

    $("#breadcrumb")
      .classList.toggle(
        "hidden",
        !collectionValue
      );


    if (collectionValue) {

      $("#breadcrumb").innerHTML = `

        <button
          type="button"
          data-back-library
        >
          Library
        </button>

        <span>/</span>

        <strong>
          ${esc(collectionValue)}
        </strong>

      `;
    }
  }


  /* HOME */

  if (
    libraryView === "home" &&
    !collectionValue
  ) {
    libraryView = "songs";

    $("#homeContent")
      ?.classList.remove(
        "hidden"
      );

    $("#songList")
      ?.classList.add(
        "hidden"
      );

    $("#collectionGrid")
      ?.classList.add(
        "hidden"
      );

    $("#playlistGrid")
      ?.classList.add(
        "hidden"
      );


    if ($("#sectionHeading")) {
      $("#sectionHeading")
        .textContent =
        "Your Music";
    }


    if ($("#resultCount")) {
      $("#resultCount")
        .textContent = "";
    }


    renderHome();

    return;
  }


  /* The four category tiles remain visible on the single Library screen. */

  let list =
    [...allSongs];


  /* FAVORITES */

  if (
    libraryView === "favorites"
  ) {

    list =
      allSongs.filter(
        isFav
      );
  }


  /* RECENT */

  if (
    libraryView === "recent"
  ) {

    list =
      recent
        .map(id =>
          allSongs.find(
            song =>
              song.id === id
          )
        )
        .filter(Boolean);
  }


  /* ARTIST */

  if (
    collectionType === "artist" &&
    collectionValue
  ) {

    list =
      allSongs.filter(
        song =>
          song.artist ===
          collectionValue
      );
  }


  /* ALBUM */

  if (
    collectionType === "album" &&
    collectionValue
  ) {

    list =
      allSongs.filter(
        song =>
          song.album ===
          collectionValue
      );
  }


  /* PLAYLIST PAGE */

  if (
    libraryView === "playlists" &&
    !collectionValue
  ) {

    renderPlaylists();

    return;
  }


  /* COLLECTIONS */

  const showCollections =
    (
      libraryView === "artists" ||
      libraryView === "albums"
    ) &&
    !collectionValue;


  $("#collectionGrid")
    ?.classList.toggle(
      "hidden",
      !showCollections
    );


  $("#playlistGrid")
    ?.classList.add(
      "hidden"
    );


  $("#songList")
    ?.classList.toggle(
      "hidden",
      showCollections
    );


  if (showCollections) {

    renderCollections(
      allSongs
    );

    return;
  }


  /* NORMAL SONG LIST */

  if ($("#sectionHeading")) {

    $("#sectionHeading")
      .textContent =
      collectionValue ||
      (
        libraryView === "songs"
          ? "All Songs"
          : libraryView === "favorites"
          ? "Favorites"
          : libraryView === "recent"
          ? "Recently Played"
          : "Your Music"
      );
  }


  if ($("#resultCount")) {

    $("#resultCount")
      .textContent =
      `${list.length} tracks`;
  }


  $("#songList")
    ?.classList.remove(
      "hidden"
    );


  $("#songList")?.classList.toggle("grid-view", viewMode === "grid");
  $("#songList")?.classList.toggle("waterfall-view", viewMode === "waterfall");


  $("#empty")
    ?.classList.toggle(
      "hidden",
      list.length !== 0
    );


  $("#songList").innerHTML =
    list
      .map(
        song =>
          songHTML(song)
      )
      .join("");
}


/* =========================================================
   COLLECTIONS
   ========================================================= */

function renderCollections(
  allSongs
) {

  const key =
    libraryView === "artists"
      ? "artist"
      : "album";


  const items =
    [
      ...new Set(
        allSongs.map(
          song =>
            song[key]
        )
      )]
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.localeCompare(
            b,
            undefined,
            {
              sensitivity:
                "base"
            }
          )
      );


  if ($("#sectionHeading")) {

    $("#sectionHeading")
      .textContent =
      key === "artist"
        ? "Artists"
        : "Albums";
  }


  if ($("#resultCount")) {

    $("#resultCount")
      .textContent =
      `${items.length}`;
  }


  if ($("#collectionGrid")) {

    $("#collectionGrid").innerHTML =
      items
        .map(value => {

          const count =
            allSongs.filter(
              song =>
                song[key] ===
                value
            ).length;


          return `

            <button
              class="collection-card"
              type="button"
              data-collection="${esc(value)}"
              data-type="${key}"
            >

              <div class="collection-art">
                ${key === "artist" ? "♟" : "▣"}
              </div>

              <strong>
                ${esc(value)}
              </strong>

              <span>
                ${count} tracks
              </span>

            </button>

          `;
        })
        .join("");
  }
}


/* =========================================================
   SONG HTML
   ========================================================= */

function songHTML(song) {

  return `

    <div
      class="song"
      data-song-id="${esc(song.id)}"
      title="Tap anywhere to play"
    >

      ${artHTML(song, "small")}

      <div class="song-info">

        <strong>
          ${esc(song.title)}
        </strong>

        <span>
          ${esc(song.artist)}
          •
          ${esc(song.album)}
        </span>

      </div>

      <div class="song-actions">

        <button
          class="fav ${isFav(song) ? "" : "muted"}"
          data-fav="${esc(song.id)}"
          aria-label="Favorite"
          type="button"
        >
          ${isFav(song) ? "♥" : "♡"}
        </button>

        <button
          class="play-action"
          data-play="${esc(song.id)}"
          aria-label="Play"
          type="button"
        >
          ▶
        </button>

      </div>

    </div>

  `;
}


/* =========================================================
   ARTWORK
   ========================================================= */

function artHTML(
  song,
  size = "small"
) {

  const className =
    size === "big"
      ? "big-art"
      : "small-art";


  if (getArtworkUrl(song)) {

    return `

      <div
        class="art ${className} has-artwork"
        data-art-song="${esc(song.id)}"
      >

        <img
          src="${esc(getArtworkUrl(song))}"
          alt=""
          loading="lazy"
          decoding="async"
        >

      </div>

    `;
  }


  return `

    <div
      class="art ${className} no-artwork"
      data-art-song="${esc(song.id)}"
    >
      ♫
    </div>

  `;
}


/* =========================================================
   SONG LIST CLICK
   ========================================================= */

if ($("#songList")) {

  $("#songList").addEventListener(
    "click",
    event => {

      const fav =
        event.target.closest(
          "[data-fav]"
        );


      if (fav) {

        toggleFavorite(
          fav.dataset.fav
        );

        return;
      }


      const play =
        event.target.closest(
          "[data-play]"
        );


      if (play) {

        const song =
          songs.find(
            item =>
              item.id ===
              play.dataset.play
          );


        if (song) {

          playSong(
            songs.indexOf(song),
            getCurrentVisibleQueue()
          );
        }

        return;
      }


      const row =
        event.target.closest(
          ".song"
        );


      if (row) {

        const song =
          songs.find(
            item =>
              item.id ===
              row.dataset.songId
          );


        if (song) {

          playSong(
            songs.indexOf(song),
            getCurrentVisibleQueue()
          );
        }
      }

    }
  );
}


function getCurrentVisibleQueue() {

  let queue =
    getSearchResults();


  if (
    libraryView ===
    "favorites"
  ) {

    queue =
      queue.filter(
        isFav
      );
  }


  if (
    libraryView ===
    "recent"
  ) {

    queue =
      recent
        .map(id =>
          songs.find(
            song =>
              song.id === id
          )
        )
        .filter(Boolean);
  }


  if (
    collectionType === "artist" &&
    collectionValue
  ) {

    queue =
      queue.filter(
        song =>
          song.artist ===
          collectionValue
      );
  }


  if (
    collectionType === "album" &&
    collectionValue
  ) {

    queue =
      queue.filter(
        song =>
          song.album ===
          collectionValue
      );
  }


  return queue.length
    ? queue
    : songs;
}


/* =========================================================
   COLLECTION CLICK
   ========================================================= */

if ($("#collectionGrid")) {

  $("#collectionGrid").addEventListener(
    "click",
    event => {

      const card =
        event.target.closest(
          "[data-collection]"
        );


      if (!card) {
        return;
      }


      collectionType =
        card.dataset.type;


      collectionValue =
        card.dataset.collection;


      libraryView =
        card.dataset.type ===
        "artist"
          ? "artists"
          : "albums";


      updateTabs();

      render();

    }
  );
}


/* =========================================================
   BREADCRUMB
   ========================================================= */

if ($("#breadcrumb")) {

  $("#breadcrumb").addEventListener(
    "click",
    event => {

      if (
        event.target.closest(
          "[data-back-library]"
        )
      ) {

        collectionType = null;

        collectionValue = null;

        render();
      }

    }
  );
}


/* =========================================================
   SEARCH
   ========================================================= */

if ($("#search")) {

  $("#search").addEventListener(
    "input",
    () => {

      if (
        libraryView === "home"
      ) {

        libraryView =
          "songs";

        updateTabs();
      }

      render();

    }
  );
}


/* =========================================================
   LIBRARY TABS
   ========================================================= */

document
  .querySelectorAll(
    ".library-tab"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      () => {

        collectionType = null;

        collectionValue = null;

        setLibraryView(
          button.dataset.library
        );

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });

      }
    );

  });



;


/* =========================================================
   LUXE FIX PACK: playback, menus, playlists and appearance
   ========================================================= */
let luxeNativePlaying = false;
let luxeNativePosition = 0;
let luxeNativeDuration = 0;
let luxeNativeCurrentId = '';
let luxeObjectUrl = '';
let luxeActivePlaylistId = null;

function currentPlaylist() {
  return playlists.find(p => String(p.id) === String(currentPlaylistId || luxeActivePlaylistId));
}
function persistPlaylists() {
  saveJSON('luxe_playlists', playlists);
  updateStats();
  render();
}
function getSongById(id) { return songs.find(song => String(song.id) === String(id)); }
function playlistSongs(playlist) {
  const ids = Array.isArray(playlist?.songs) ? playlist.songs : [];
  const found = ids.map(getSongById).filter(Boolean);
  const pref = getPlaylistPreferences(playlist?.id);
  const alpha = (a,b) => String(a.title||'').localeCompare(String(b.title||''), undefined, {sensitivity:'base',numeric:true});
  switch(pref.sort) {
    case 'title-za': return found.sort((a,b)=>alpha(b,a));
    case 'added-new': return found.sort((a,b)=>(luxeAddedAt[b.id]||b.lastModified||0)-(luxeAddedAt[a.id]||a.lastModified||0));
    case 'added-old': return found.sort((a,b)=>(luxeAddedAt[a.id]||a.lastModified||0)-(luxeAddedAt[b.id]||b.lastModified||0));
    case 'recent': { const rank=new Map(recent.map((id,i)=>[id,i])); return found.sort((a,b)=>(rank.get(a.id)??999999)-(rank.get(b.id)??999999)); }
    case 'most-played': return found.sort((a,b)=>(luxePlayCounts[b.id]||0)-(luxePlayCounts[a.id]||0)||alpha(a,b));
    default: return found.sort(alpha);
  }
}
function closeAllMenus() {
  toggleMenu('sortMenu', false);
  toggleMenu('playlistSortMenu', false);
}
function openOverlay(id) {
  // Floating menus belong only to their screen and must never leak into overlays.
  closeAllMenus();
  const el=$(id); if(el) el.classList.remove('hidden');
}
function closeOverlay(id) {
  const el=$(id); if(el) el.classList.add('hidden');
  closeAllMenus();
}

/* Menus */
function menuElement(id) {
  // This helper accepts either "sortMenu" or "#sortMenu". The previous
  // version passed bare IDs to querySelector, which silently returned null.
  const selector = String(id || '').startsWith('#') ? String(id) : `#${id}`;
  return $(selector);
}
function toggleMenu(id, force) {
  const menu=menuElement(id); if(!menu) return;
  const shouldOpen = force === undefined ? menu.classList.contains('hidden') : !!force;
  menu.classList.toggle('hidden', !shouldOpen);
  menu.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
  if (!shouldOpen) {
    menu.style.position = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.top = '';
    menu.style.zIndex = '';
    menu.style.width = '';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
  }
}
function openAnchoredMenu(menuId, buttonId) {
  const menu=menuElement(menuId), button=menuElement(buttonId); if(!menu||!button) return;
  const wasHidden=menu.classList.contains('hidden');
  // Close the other menu first, then toggle this one.
  if(menuId==='sortMenu') toggleMenu('playlistSortMenu',false);
  else toggleMenu('sortMenu',false);
  if(!wasHidden) { toggleMenu(menuId,false); return; }
  toggleMenu(menuId,true);
  const rect=button.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const menuWidth = Math.min(310, viewportWidth - 24);
  const rightGap = Math.max(12, viewportWidth - rect.right);
  const availableBelow = viewportHeight - rect.bottom - 16;
  const availableAbove = rect.top - 16;
  const estimatedMenuHeight = Math.min(menu.scrollHeight || 500, viewportHeight - 24);
  const openAbove = availableBelow < Math.min(estimatedMenuHeight, 260) && availableAbove > availableBelow;
  menu.style.position='fixed';
  menu.style.zIndex='9999';
  menu.style.left='auto';
  menu.style.right=rightGap+'px';
  menu.style.width=menuWidth+'px';
  menu.style.maxHeight=Math.max(160, Math.min(viewportHeight-24, openAbove ? availableAbove : availableBelow))+'px';
  menu.style.top = openAbove
    ? Math.max(12, rect.top - Math.min(estimatedMenuHeight, availableAbove) - 8)+'px'
    : Math.min(viewportHeight - 80, rect.bottom + 8)+'px';
  menu.style.overflowY='auto';
  menu.setAttribute('aria-hidden','false');
}
function updateMenuActiveStates() {
  document.querySelectorAll('#sortMenu [data-setting]').forEach(b => {
    const key=b.dataset.setting, val=b.dataset.value;
    const active = key==='view' ? val===viewMode : key==='sort' ? val===luxeSortMode : val===(localStorage.getItem('luxe_playing_order')||'consecutive');
    b.classList.toggle('active',active);
  });
  const pref=getPlaylistPreferences();
  document.querySelectorAll('#playlistSortMenu [data-playlist-setting]').forEach(b=>{
    const key=b.dataset.playlistSetting;
    const active = b.dataset.value===pref[key];
    b.classList.toggle('active',active);
  });
}
function applyMainSetting(key,value) {
  if(key==='view') { viewMode=value; localStorage.setItem('luxe_view_mode',value); }
  if(key==='sort') { luxeSortMode=value; localStorage.setItem('luxe_sort_mode',value); }
  if(key==='playing') {
    localStorage.setItem('luxe_playing_order',value);
    // Reorder the live queue immediately, keeping the current song and its progress.
    if (currentQueue.length > 1 && queuePosition >= 0) {
      const active = currentQueue[queuePosition];
      const currentIds = new Set(currentQueue.map(song => String(song?.id)));
      let upcoming;
      if (value === 'random') {
        upcoming = currentQueue.filter(song => String(song?.id) !== String(active?.id));
        shuffleArray(upcoming);
      } else {
        const base = currentQueueBase.length ? currentQueueBase : currentQueue;
        upcoming = base.filter(song => String(song?.id) !== String(active?.id) && currentIds.has(String(song?.id)));
        // Include any queue item missing from the base snapshot without losing it.
        const included = new Set(upcoming.map(song => String(song?.id)));
        currentQueue.forEach(song => { if (String(song?.id) !== String(active?.id) && !included.has(String(song?.id))) upcoming.push(song); });
      }
      currentQueue = [active, ...upcoming];
      queuePosition = 0;
      if (isNativeAndroid() && typeof window.LuxeAndroid?.nativePlayQueue === 'function') {
        const nativeQueue = currentQueue.filter(song => song.nativeUrl).map(song => ({id:song.id,title:song.title,artist:song.artist,url:song.nativeUrl}));
        if (nativeQueue.length) {
          const keepPosition = Math.max(0, Math.round(luxeNativePosition * 1000));
          window.LuxeAndroid.nativePlayQueue(JSON.stringify(nativeQueue), 0, repeat);
          if (window.LuxeAndroid.nativeSeek) setTimeout(() => window.LuxeAndroid.nativeSeek(keepPosition), 180);
        }
      }
    }
  }
  toggleMenu('sortMenu',false); updateMenuActiveStates(); render();
}
function applyPlaylistSetting(key,value) {
  const p=currentPlaylist(); if(!p) return;
  const pref=getPlaylistPreferences(p.id); pref[key]=value; savePlaylistPreferences();
  if (key === 'playing' && currentQueue.length > 1 && queuePosition >= 0) {
    const ids = new Set((p.songs || []).map(String));
    if (ids.has(String(currentQueue[queuePosition]?.id))) {
      const active = currentQueue[queuePosition];
      let upcoming;
      if (value === 'random') {
        upcoming = currentQueue.filter(song => String(song?.id) !== String(active?.id) && ids.has(String(song?.id)));
        shuffleArray(upcoming);
      } else {
        const orderedIds = (p.songs || []).map(String);
        upcoming = orderedIds.map(id => getSongById(id)).filter(song => song && String(song.id) !== String(active?.id) && currentQueue.some(q => String(q.id) === String(song.id)));
      }
      const outside = currentQueue.filter(song => !ids.has(String(song?.id)) && song?.id !== active?.id);
      currentQueue = [active, ...upcoming, ...outside]; currentQueueBase = [active, ...upcoming, ...outside]; queuePosition = 0;
      if (isNativeAndroid() && typeof window.LuxeAndroid?.nativePlayQueue === 'function') {
        const nativeQueue = currentQueue.filter(song => song.nativeUrl).map(song => ({id:song.id,title:song.title,artist:song.artist,url:song.nativeUrl}));
        if (nativeQueue.length) {
          const keepPosition = Math.max(0, Math.round(luxeNativePosition * 1000));
          window.LuxeAndroid.nativePlayQueue(JSON.stringify(nativeQueue), 0, repeat);
          setTimeout(() => { if (keepPosition && window.LuxeAndroid?.nativeSeek) window.LuxeAndroid.nativeSeek(keepPosition); }, 250);
        }
      }
    }
  }
  toggleMenu('playlistSortMenu',false); updateMenuActiveStates(); renderPlaylistSongs();
}

/* Playlist library and detail view */
function renderPlaylists() {
  const grid=$('#playlistGrid'), list=$('#songList'), coll=$('#collectionGrid');
  if(!grid) return;
  if(list) list.classList.add('hidden'); if(coll) coll.classList.add('hidden');
  grid.classList.remove('hidden');
  if($('#sectionHeading')) $('#sectionHeading').textContent='Playlists';
  if($('#resultCount')) $('#resultCount').textContent=`${playlists.length} playlists`;
  if($('#empty')) $('#empty').classList.add('hidden');
  grid.innerHTML = `<button class="playlist-card create-playlist-card" type="button" data-create-playlist><span class="playlist-card-icon">＋</span><strong>Create playlist</strong><small>Make your own collection</small></button>` + playlists.map(p=>{
    const count=(p.songs||[]).filter(id=>songs.some(s=>s.id===id)).length;
    return `<button class="playlist-card" type="button" data-open-playlist="${esc(p.id)}"><span class="playlist-card-icon">♫</span><strong>${esc(p.name||'Untitled Playlist')}</strong><small>${count} ${count===1?'song':'songs'}</small><span class="playlist-card-more">›</span></button>`;
  }).join('');
}
function openPlaylist(id) {
  const p=playlists.find(x=>String(x.id)===String(id)); if(!p) return;
  currentPlaylistId=p.id; luxeActivePlaylistId=p.id;
  if($('#playlistPanelTitle')) $('#playlistPanelTitle').textContent=p.name||'Playlist';
  if($('#playlistSongSearch')) $('#playlistSongSearch').value='';
  renderPlaylistSongs(); updateMenuActiveStates(); openOverlay('#playlistPanel');
}
function renderPlaylistSongs() {
  const p=currentPlaylist(), host=$('#playlistSongs'); if(!host||!p) return;
  if($('#playlistPanelTitle')) $('#playlistPanelTitle').textContent=p.name||'Playlist';
  const pref=getPlaylistPreferences(p.id), q=($('#playlistSongSearch')?.value||'').trim().toLowerCase();
  let list=playlistSongs(p).filter(song=>(song.title+' '+song.artist+' '+song.album).toLowerCase().includes(q));
  host.className='playlist-songs'+(pref.view==='grid'?' view-grid':pref.view==='waterfall'?' view-waterfall':'');
  if(!list.length) { host.innerHTML=`<div class="empty playlist-empty">${q?'No songs match your search.':'This playlist is empty. Tap ADD SONGS to add music.'}</div>`; return; }
  host.innerHTML=list.map(song=>`<div class="playlist-song song ${song.id===luxeNativeCurrentId||song.id===songs[current]?.id?'playing':''}" data-playlist-song="${esc(song.id)}" role="button" tabindex="0">${artHTML(song,'small')}<div class="playlist-song-info"><strong>${esc(song.title)}</strong><span>${esc(song.artist)} • ${esc(song.album)}</span></div><button class="remove-song playlist-remove" type="button" data-remove-playlist-song="${esc(song.id)}" title="Remove from this playlist" aria-label="Remove ${esc(song.title)} from playlist">×</button></div>`).join('');
}
function createPlaylist() { openOverlay('#playlistCreatePanel'); setTimeout(()=>$('#playlistNameInput')?.focus(),50); }
function confirmCreatePlaylist() {
  const input=$('#playlistNameInput'), name=(input?.value||'').trim(); if(!name) { input?.focus(); return; }
  const p={id:'pl-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),name,songs:[],createdAt:Date.now()};
  playlists.push(p); playlistPreferences[p.id]={view:'list',sort:'title-az',playing:'consecutive'}; savePlaylistPreferences(); persistPlaylists();
  if(input) input.value=''; closeOverlay('#playlistCreatePanel'); openPlaylist(p.id);
}
function openAddSongs() {
  const p=currentPlaylist(); if(!p) return;
  selectedPlaylistSongs=new Set(p.songs||[]);
  if($('#addSongsTitle')) $('#addSongsTitle').textContent=`Add songs to ${p.name}`;
  if($('#addSongSearch')) $('#addSongSearch').value='';
  renderAddSongChoices(); openOverlay('#addSongsPanel');
}
function renderAddSongChoices() {
  const host=$('#addSongList'); if(!host) return;
  const q=($('#addSongSearch')?.value||'').trim().toLowerCase();
  const filtered=sortSongs(songs.filter(s=>(s.title+' '+s.artist+' '+s.album).toLowerCase().includes(q)));
  host.innerHTML=filtered.map(song=>{const added=selectedPlaylistSongs.has(song.id);return `<div class="add-song-item ${added?'selected':''}" data-add-choice="${esc(song.id)}" role="button" tabindex="0">${artHTML(song,'small')}<div class="add-song-info"><strong>${esc(song.title)}</strong><span>${esc(song.artist)}</span></div><button class="add-song-toggle ${added?'added':''}" data-toggle-add="${esc(song.id)}" type="button" aria-label="${added?'Remove selection':'Select song'}">${added?'✓':'＋'}</button></div>`}).join('')||'<div class="empty">No songs found in your library.</div>';
}
function toggleSongSelection(id) { if(selectedPlaylistSongs.has(id)) selectedPlaylistSongs.delete(id); else selectedPlaylistSongs.add(id); renderAddSongChoices(); }
function saveAddedSongs() {
  const p=currentPlaylist(); if(!p) return;
  p.songs=[...selectedPlaylistSongs].filter(id=>songs.some(s=>s.id===id));
  persistPlaylists(); closeOverlay('#addSongsPanel'); renderPlaylistSongs();
}
function removeSongFromPlaylist(id) {
  const p=currentPlaylist(); if(!p) return;
  p.songs=(p.songs||[]).filter(songId=>String(songId)!==String(id));
  persistPlaylists(); renderPlaylistSongs();
}
function playPlaylist() {
  const p=currentPlaylist(); if(!p) return;
  let queue=playlistSongs(p); if(!queue.length) return;
  currentQueueBase = [...queue];
  if(getPlaylistPreferences(p.id).playing==='random') shuffleArray(queue);
  startQueue(queue,0);
}
function startQueue(queue,index=0) {
  queue=(queue||[]).filter(Boolean); if(!queue.length) return;
  currentQueue=[...queue]; queuePosition=Math.max(0,Math.min(index,queue.length-1));
  current=songs.findIndex(s=>s.id===currentQueue[queuePosition].id);
  const song=currentQueue[queuePosition]; if(!song) return;
  if(isNativeAndroid() && typeof window.LuxeAndroid.nativePlayQueue==='function') {
    const nativeQueue=currentQueue.filter(s=>s.nativeUrl).map(s=>({id:s.id,title:s.title,artist:s.artist,url:s.nativeUrl}));
    const nativeIndex=Math.max(0,nativeQueue.findIndex(s=>s.id===song.id));
    if(nativeQueue.length) { window.LuxeAndroid.nativePlayQueue(JSON.stringify(nativeQueue),nativeIndex,repeat); luxeNativeCurrentId=song.id; luxeNativePlaying=true; }
    else { setFolderStatus('Could not play this track from Android storage.'); return; }
  } else {
    if(!audio) return;
    try {
      if(luxeObjectUrl) { URL.revokeObjectURL(luxeObjectUrl); luxeObjectUrl=''; }
      if(song.file) { luxeObjectUrl=URL.createObjectURL(song.file); audio.src=luxeObjectUrl; }
      else if(song.nativeUrl) audio.src=song.nativeUrl;
      else { setFolderStatus('This song file is not available. Please rescan your folder.'); return; }
      audio.load(); const promise=audio.play(); if(promise?.catch) promise.catch(err=>{console.error('LUXE playback failed:',err);setFolderStatus('Playback was blocked or this audio format could not be played. Try another track.');});
    } catch(err) { console.error(err); setFolderStatus('Unable to play this song.'); }
  }
  if(song.id) { recent=[song.id,...recent.filter(id=>id!==song.id)].slice(0,100); saveJSON('luxe_recent',recent); luxePlayCounts[song.id]=(luxePlayCounts[song.id]||0)+1; saveJSON('luxe_play_counts',luxePlayCounts); }
  updatePlayer(); updatePlayerArtwork(); render(); renderPlaylistSongs();
  $('#miniPlayer')?.classList.remove('hidden');
}
function playSong(index, queue) {
  const chosenQueue=Array.isArray(queue)&&queue.length?[...queue]:[...songs];
  currentQueueBase = [...chosenQueue];
  const target=songs[index];
  let start=target?chosenQueue.findIndex(s=>s.id===target.id):0;
  if(start<0) start=0;
  if(localStorage.getItem('luxe_playing_order')==='random' && chosenQueue.length>1) { const picked=chosenQueue[start]; shuffleArray(chosenQueue); start=chosenQueue.findIndex(s=>s.id===picked?.id); }
  startQueue(chosenQueue,start);
}
function playNext() {
  if(!currentQueue.length) return;
  // Random mode selects a random upcoming track, then keeps that randomized order as the queue.
  if(localStorage.getItem('luxe_playing_order')==='random' && currentQueue.length>1 && queuePosition>=0) {
    const upcoming=currentQueue.slice(queuePosition+1);
    if(upcoming.length) { shuffleArray(upcoming); currentQueue.splice(queuePosition+1,currentQueue.length-queuePosition-1,...upcoming); }
  }
  if(queuePosition+1<currentQueue.length) startQueue(currentQueue,queuePosition+1);
  else if(repeat) {
    if(localStorage.getItem('luxe_playing_order')==='random' && currentQueue.length>1) shuffleArray(currentQueue);
    startQueue(currentQueue,0);
  }
}
function playPrevious() { if(!currentQueue.length) return; if(!isNativeAndroid()&&audio&&audio.currentTime>3) { audio.currentTime=0; return; } startQueue(currentQueue,Math.max(0,queuePosition-1)); }
function updatePlayer() {
  const song=currentQueue[queuePosition]||songs[current]; if(!song) return;
  ['miniTitle','bigTitle'].forEach(id=>{if($('#'+id)) $('#'+id).textContent=song.title||'Unknown Title';});
  ['miniArtist','bigArtist'].forEach(id=>{if($('#'+id)) $('#'+id).textContent=song.artist||'Unknown Artist';});
  if($('#bigMeta')) $('#bigMeta').textContent=song.album||'Local Music';
  updatePlayerArtwork();
}
function updatePlayerArtwork() {
  const song=currentQueue[queuePosition]||songs[current]; if(!song) return;
  setArt($('#miniArt'),getArtworkUrl(song),'♪'); setArt($('#bigArt'),getArtworkUrl(song),'♪');
}
function updateMiniProgress(position,duration) {
  const circle=$('#miniProgressCircle'), ring=$('#miniSeekRing');
  const pct=Number(duration)>0 ? Math.max(0,Math.min(1,Number(position)/Number(duration))) : 0;
  if(circle) circle.style.strokeDashoffset=String(182.21*(1-pct));
  if(ring) ring.setAttribute('aria-valuenow',String(Math.round(pct*100)));
}
function seekMiniFromPointer(e) {
  const ring=$('#miniSeekRing'); if(!ring) return;
  const rect=ring.getBoundingClientRect(), cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
  let angle=Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI+90; if(angle<0) angle+=360;
  const pct=angle/360, duration=isNativeAndroid()?luxeNativeDuration:(audio?.duration||0);
  if(!duration) return;
  if(isNativeAndroid()&&window.LuxeAndroid?.nativeSeek) window.LuxeAndroid.nativeSeek(Math.round(pct*duration*1000));
  else if(audio) audio.currentTime=pct*duration;
  updateMiniProgress(pct*duration,duration);
}
function setPlayButtonState(playing) {
  ['miniPlay','bigPlay'].forEach(id=>{const b=$('#'+id);if(b){b.textContent=playing?'Ⅱ':'▶';b.setAttribute('aria-label',playing?'Pause':'Play');}});
}
function updateViewButtons() { updateMenuActiveStates(); }
function toggleFavorite(id) {
  if(favorites.includes(id)) favorites=favorites.filter(x=>x!==id); else favorites.push(id);
  saveJSON('luxe_favorites',favorites); updateStats(); render(); renderPlaylistSongs();
}

/* Browser audio events */
if(audio) {
  audio.addEventListener('play',()=>setPlayButtonState(true));
  audio.addEventListener('pause',()=>setPlayButtonState(false));
  audio.addEventListener('loadedmetadata',()=>{if($('#duration')) $('#duration').textContent=formatTime(audio.duration);});
  audio.addEventListener('timeupdate',()=>{if($('#currentTime')) $('#currentTime').textContent=formatTime(audio.currentTime);if($('#duration')) $('#duration').textContent=formatTime(audio.duration);if($('#progress')&&audio.duration) $('#progress').value=(audio.currentTime/audio.duration)*100;updateMiniProgress(audio.currentTime,audio.duration);});
  audio.addEventListener('ended',()=>{if(queuePosition+1<currentQueue.length) playNext();else if(repeat) startQueue(currentQueue,0);else setPlayButtonState(false);});
  audio.addEventListener('error',()=>{if(!isNativeAndroid()&&audio.src) setFolderStatus('This audio file could not be decoded by this browser. Try another supported format.');});
}
window.LuxeAndroidNativeState = function(state) {
  if(typeof state==='string') { try{state=JSON.parse(state)}catch{return;} }
  if(!state) return;
  luxeNativePlaying=!!state.playing; luxeNativePosition=Number(state.position||0)/1000; luxeNativeDuration=Number(state.duration||0)/1000; luxeNativeCurrentId=state.id||'';
  const matched=getSongById(state.id); if(matched) { current=songs.indexOf(matched); const qi=currentQueue.findIndex(s=>s.id===matched.id); if(qi>=0) queuePosition=qi; updatePlayer(); }
  setPlayButtonState(luxeNativePlaying);
  if($('#currentTime')) $('#currentTime').textContent=formatTime(luxeNativePosition);
  if($('#duration')) $('#duration').textContent=formatTime(luxeNativeDuration);
  if($('#progress')&&luxeNativeDuration) $('#progress').value=(luxeNativePosition/luxeNativeDuration)*100;
  updateMiniProgress(luxeNativePosition,luxeNativeDuration);
  if(state.title) $('#miniPlayer')?.classList.remove('hidden');
};

/* Click handlers for controls and dialogs */
$('#sortBtn')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openAnchoredMenu('sortMenu','sortBtn');updateMenuActiveStates();});
$('#sortMenu')?.addEventListener('click',e=>{e.stopPropagation();const b=e.target.closest('[data-setting]');if(b) applyMainSetting(b.dataset.setting,b.dataset.value);});
$('#playlistSortBtn')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openAnchoredMenu('playlistSortMenu','playlistSortBtn');updateMenuActiveStates();});
$('#playlistSortMenu')?.addEventListener('click',e=>{e.stopPropagation();const b=e.target.closest('[data-playlist-setting]');if(b) applyPlaylistSetting(b.dataset.playlistSetting,b.dataset.value);});
document.addEventListener('click',e=>{if(!e.target.closest('#sortMenu, #sortBtn')) toggleMenu('sortMenu',false);if(!e.target.closest('#playlistSortMenu, #playlistSortBtn')) toggleMenu('playlistSortMenu',false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){toggleMenu('sortMenu',false);toggleMenu('playlistSortMenu',false);}});
$('#themeBtn')?.addEventListener('click',()=>openOverlay('#themePanel'));
$('#closeTheme')?.addEventListener('click',()=>closeOverlay('#themePanel'));
$('#themePanel')?.addEventListener('click',e=>{if(e.target===$('#themePanel'))closeOverlay('#themePanel');});
$('#closePlaylistCreate')?.addEventListener('click',()=>closeOverlay('#playlistCreatePanel'));
$('#createPlaylistConfirm')?.addEventListener('click',confirmCreatePlaylist);
$('#playlistNameInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')confirmCreatePlaylist();});
$('#playlistGrid')?.addEventListener('click',e=>{if(e.target.closest('[data-create-playlist]')){createPlaylist();return;}const card=e.target.closest('[data-open-playlist]');if(card)openPlaylist(card.dataset.openPlaylist);});
$('#closePlaylistPanel')?.addEventListener('click',()=>closeOverlay('#playlistPanel'));
$('#playlistPanel')?.addEventListener('click',e=>{if(e.target===$('#playlistPanel'))closeOverlay('#playlistPanel');});
$('#playlistAddBtn')?.addEventListener('click',openAddSongs);
$('#playlistPlayBtn')?.addEventListener('click',playPlaylist);
$('#playlistSongSearch')?.addEventListener('input',renderPlaylistSongs);
$('#playlistSongs')?.addEventListener('click',e=>{const remove=e.target.closest('[data-remove-playlist-song]');if(remove){e.stopPropagation();removeSongFromPlaylist(remove.dataset.removePlaylistSong);return;}const row=e.target.closest('[data-playlist-song]');if(row){const p=currentPlaylist();let q=playlistSongs(p);currentQueueBase=[...q];if(getPlaylistPreferences(p?.id).playing==='random')shuffleArray(q);const song=getSongById(row.dataset.playlistSong);const i=q.findIndex(s=>s.id===song?.id);startQueue(q,Math.max(0,i));}});
$('#closeAddSongs')?.addEventListener('click',()=>closeOverlay('#addSongsPanel'));
$('#doneAddSongs')?.addEventListener('click',saveAddedSongs);
$('#addSongSearch')?.addEventListener('input',renderAddSongChoices);
$('#addSongList')?.addEventListener('click',e=>{const toggle=e.target.closest('[data-toggle-add]');const row=e.target.closest('[data-add-choice]');const id=toggle?.dataset.toggleAdd||row?.dataset.addChoice;if(id)toggleSongSelection(id);});
$('#miniPrevious')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();playPrevious();});
$('#miniNext')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();playNext();});
$('#miniSeekRing')?.addEventListener('click',e=>{e.stopPropagation();seekMiniFromPointer(e);});
$('#miniSeekRing')?.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowUp'){e.preventDefault();const d=isNativeAndroid()?luxeNativeDuration:(audio?.duration||0),p=isNativeAndroid()?luxeNativePosition:(audio?.currentTime||0);if(d){const n=Math.min(d,p+5);if(isNativeAndroid()&&window.LuxeAndroid?.nativeSeek)window.LuxeAndroid.nativeSeek(Math.round(n*1000));else if(audio)audio.currentTime=n;}}else if(e.key==='ArrowLeft'||e.key==='ArrowDown'){e.preventDefault();const d=isNativeAndroid()?luxeNativeDuration:(audio?.duration||0),p=isNativeAndroid()?luxeNativePosition:(audio?.currentTime||0);if(d){const n=Math.max(0,p-5);if(isNativeAndroid()&&window.LuxeAndroid?.nativeSeek)window.LuxeAndroid.nativeSeek(Math.round(n*1000));else if(audio)audio.currentTime=n;}}});
$('#miniPlayer')?.addEventListener('click',e=>{if(e.target.closest('#miniPlay, #miniPrevious, #miniNext, #miniSeekRing'))return;toggleMenu('sortMenu',false);toggleMenu('playlistSortMenu',false);openOverlay('#playerModal');});
$('#miniPlay')?.addEventListener('click',e=>{e.stopPropagation();togglePlayback();});
$('#closePlayer')?.addEventListener('click',()=>closeOverlay('#playerModal'));
$('#bigPlay')?.addEventListener('click',togglePlayback);
$('#nextBtn')?.addEventListener('click',playNext);
$('#prevBtn')?.addEventListener('click',playPrevious);
$('#repeatBtn')?.addEventListener('click',()=>{repeat=!repeat;$('#repeatBtn')?.classList.toggle('active',repeat);if(isNativeAndroid()&&window.LuxeAndroid.nativeSetRepeat)window.LuxeAndroid.nativeSetRepeat(repeat);});
$('#shuffleBtn')?.addEventListener('click',()=>{if(currentQueue.length>1){const currentSong=currentQueue[queuePosition];if(!currentQueueBase.length)currentQueueBase=[...currentQueue];shuffleArray(currentQueue);queuePosition=currentQueue.findIndex(s=>s.id===currentSong?.id);if(isNativeAndroid()&&window.LuxeAndroid?.nativePlayQueue){const nq=currentQueue.filter(s=>s.nativeUrl).map(s=>({id:s.id,title:s.title,artist:s.artist,url:s.nativeUrl}));window.LuxeAndroid.nativePlayQueue(JSON.stringify(nq),Math.max(0,nq.findIndex(s=>s.id===currentSong?.id)),repeat);}updatePlayer();}});
$('#progress')?.addEventListener('input',e=>{const value=Number(e.target.value)/100;if(isNativeAndroid()&&window.LuxeAndroid.nativeSeek)window.LuxeAndroid.nativeSeek(Math.round(value*luxeNativeDuration*1000));else if(audio&&audio.duration)audio.currentTime=value*audio.duration;});
$('#volume')?.addEventListener('input',e=>{if(audio)audio.volume=Number(e.target.value);});
function togglePlayback() {
  if(!currentQueue.length) { const list=getCurrentVisibleQueue(); if(list.length) startQueue(list,0); return; }
  if(isNativeAndroid()&&window.LuxeAndroid) { if(luxeNativePlaying&&window.LuxeAndroid.nativePause)window.LuxeAndroid.nativePause();else if(window.LuxeAndroid.nativePlay)window.LuxeAndroid.nativePlay(); }
  else if(audio) { if(audio.paused) audio.play().catch(err=>console.error(err));else audio.pause(); }
}

/* Appearance settings are persisted between launches */

/* =========================================================
   COMPLETE UI STYLE SYSTEM
   ========================================================= */
const LUXE_UI_STYLES = ['default', 'neumorphism', 'glassmorphism', 'liquid-glass', 'spatial'];

function applyUiStyle(style, persist = true) {
  const selected = LUXE_UI_STYLES.includes(style) ? style : 'default';
  if (selected === 'default') {
    document.documentElement.removeAttribute('data-ui-style');
  } else {
    document.documentElement.setAttribute('data-ui-style', selected);
  }
  document.querySelectorAll('[data-ui-style]').forEach(button => {
    if (button.tagName === 'BUTTON') {
      const active = button.dataset.uiStyle === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  });
  if (persist) {
    try { localStorage.setItem('luxe_ui_style', selected); } catch {}
  }
}

document.querySelectorAll('.ui-style-option[data-ui-style]').forEach(button => {
  button.addEventListener('click', () => applyUiStyle(button.dataset.uiStyle));
});

function applyThemeChoice(choice) {
  const themes={deluxe:['#d7b56d','#f2d79c'],truck:['#c98b4b','#f0c18b'],sport:['#d65c5c','#ffaaaa']};
  const pair=themes[choice]||themes.deluxe; document.documentElement.style.setProperty('--accent',pair[0]);document.documentElement.style.setProperty('--accent2',pair[1]);localStorage.setItem('luxe_theme',choice);
}
function applyWallpaper(name) {
  const backgrounds={wall1:'radial-gradient(circle at 50% 0,#29241b,#09090b)',wall2:'linear-gradient(135deg,#4a3317,#111)',wall3:'linear-gradient(135deg,#151e38,#080a12)',wall4:'linear-gradient(135deg,#143d36,#171026)'};
  document.documentElement.style.setProperty('--wallpaper',backgrounds[name]||'none');localStorage.setItem('luxe_wallpaper',name);
}
document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>applyThemeChoice(b.dataset.themeChoice)));
document.querySelectorAll('[data-wallpaper]').forEach(b=>b.addEventListener('click',()=>applyWallpaper(b.dataset.wallpaper)));
$('#fontSelect')?.addEventListener('change',e=>{document.documentElement.style.setProperty('--font',`"${e.target.value}", sans-serif`);localStorage.setItem('luxe_font',e.target.value);});
$('#wallpaperInput')?.addEventListener('change',e=>{const file=e.target.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{const url=String(reader.result||'');document.documentElement.style.setProperty('--wallpaper',`url("${url.replace(/"/g,'%22')}")`);try{localStorage.setItem('luxe_custom_wallpaper',url);localStorage.removeItem('luxe_wallpaper');}catch{setFolderStatus('Image is too large to save. Choose a smaller background image.');}};reader.readAsDataURL(file);});
$('#removeWallpaper')?.addEventListener('click',()=>{localStorage.removeItem('luxe_custom_wallpaper');applyWallpaper('wall1');});
function restoreAppearance() {
  applyUiStyle(localStorage.getItem('luxe_ui_style') || 'default', false);
  applyThemeChoice(localStorage.getItem('luxe_theme')||'deluxe');
  const font=localStorage.getItem('luxe_font');if(font){document.documentElement.style.setProperty('--font',`"${font}", sans-serif`);if($('#fontSelect'))$('#fontSelect').value=font;}
  const custom=localStorage.getItem('luxe_custom_wallpaper');if(custom)document.documentElement.style.setProperty('--wallpaper',`url("${custom.replace(/"/g,'%22')}")`);else applyWallpaper(localStorage.getItem('luxe_wallpaper')||'wall1');
}
restoreAppearance();
if($('#miniPlayer')) $('#miniPlayer').classList.add('hidden');
if($('#playerModal')) $('#playerModal').classList.add('hidden');
updateMenuActiveStates();


// Restore the browser's previously selected local music folder when available.
tryRestoreLibrary().catch(error => console.warn('LUXE library restore skipped:', error));

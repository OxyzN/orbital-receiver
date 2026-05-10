// Custom receiver logic (CAF)
// - Intercepts LOAD and ensures the live stream is played
// - Updates the on-screen status text for Nest Hub
// - Provides local Play/Stop buttons (touchscreen)
//
// TOUCH RELIABILITY — three independent layers so that if one fails the others catch it:
//
//  Approach A (index.html inline script, runs before CAF SDK):
//    Intercepts customElements.define so the platform's own <touch-controls>
//    registration is replaced with a no-op that hides itself on connection.
//
//  Approach B (MutationObserver, this file):
//    Watches the entire DOM tree and immediately removes any <touch-controls>
//    node the instant it is inserted, including after media loads.
//
//  Approach C (capture-phase interceptor, this file):
//    Registers touchstart / touchend on *document* in capture phase (fires
//    before any element, including overlays), uses document.elementsFromPoint()
//    to find our buttons underneath whatever is on top, calls
//    stopImmediatePropagation() so the overlay never sees the event, then
//    calls the action function directly.

const DEFAULT_STREAM_URL = "https://ec2.yesstreaming.net:3025/stream";
const ICECAST_STATUS_URL = "https://ec2.yesstreaming.net:3025/status-json.xsl";
const METADATA_REFRESH_MS = 15000;
let nextLocalRequestId = 1;

const castStatus     = document.getElementById("castStatus");
const castStatusText = document.getElementById("castStatusText");
const statusText     = document.getElementById("statusText");
const nowPlaying     = document.getElementById("nowPlaying");
const trackTitle     = document.getElementById("trackTitle");
const trackArtist    = document.getElementById("trackArtist");
const debugLine      = document.getElementById("debugLine");
const playBtn        = document.getElementById("playBtn");
const stopBtn        = document.getElementById("stopBtn");
const lyricsBtn      = document.getElementById("lyricsBtn");
const bodyView       = document.getElementById("bodyView");
const lyricsView     = document.getElementById("lyricsView");
const lyricsContent  = document.getElementById("lyricsContent");
const lyricsMessage  = document.getElementById("lyricsMessage");
const localAudio     = document.getElementById("radio");

// Track currently-rendered lyrics key (artist|title). When the on-air track
// changes we re-fetch; otherwise we reuse the cached fetch to avoid hammering
// LRCLIB every 15s when the song doesn't change.
let currentLyricsKey = null;
const lyricsCache    = new Map(); // key -> { message, lyrics }

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(text) {
  if (statusText) statusText.textContent = text;
}

// The cast-status pill in the top-right corner is hidden by default so the
// Nest Hub shows the clean branded UI. Call with `{ isProblem: true }` to
// surface a visible warning; any non-problem call hides the pill again so a
// resolved state doesn't leave stale warning text on screen.
function setCastStatus(text, options) {
  if (castStatusText) castStatusText.textContent = text;
  if (!castStatus) return;
  const isProblem = options?.isProblem === true;
  castStatus.hidden = !isProblem;
  castStatus.classList.toggle("status--problem", isProblem);
}

function logDebug(text) {
  if (debugLine) debugLine.textContent = text;
}

// ---------------------------------------------------------------------------
// Track metadata
// ---------------------------------------------------------------------------

function splitTrackTitle(rawTitle) {
  const title = String(rawTitle || "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const match = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (!match) return { artist: "Radio Orbital", title };
  return { artist: match[1].trim(), title: match[2].trim() };
}

function getIcecastSource(payload) {
  const source = payload?.icestats?.source;
  return Array.isArray(source) ? source[0] : source;
}

function renderTrackMetadata(metadata) {
  if (!metadata) return;
  if (trackTitle)  trackTitle.textContent  = metadata.title;
  if (trackArtist) trackArtist.textContent = metadata.artist;
  if (nowPlaying)  nowPlaying.textContent  = "Live from Lisbon";
  // Refresh lyrics whenever the on-air track changes. Cached per artist|title
  // so we don't re-hit LRCLIB while the same song plays through.
  loadLyricsForTrack(metadata.artist, metadata.title);
}

async function refreshTrackMetadata() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`${ICECAST_STATUS_URL}?_=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const source  = getIcecastSource(payload);
    renderTrackMetadata(splitTrackTitle(source?.title || source?.yp_currently_playing));
  } catch {
    if (nowPlaying) nowPlaying.textContent = "Track metadata unavailable.";
  }
}

// ---------------------------------------------------------------------------
// Lyrics (LRCLIB)
// ---------------------------------------------------------------------------
// LRCLIB is a free open lyrics API at https://lrclib.net. The `/api/get`
// endpoint takes `artist_name` + `track_name` and returns either a track
// object with `plainLyrics` / `syncedLyrics` / `instrumental`, or a 404 when
// no match exists. Live radio doesn't give us a song offset, so we render
// `plainLyrics` (or strip timestamps from `syncedLyrics` when only those
// exist).

const LRCLIB_URL = "https://lrclib.net/api/get";

function stripSyncedTimestamps(syncedLyrics) {
  // LRC format: lines like "[00:12.34] some text". Strip the leading bracket
  // groups so we can render synced lyrics as plain text when plainLyrics is
  // absent.
  return String(syncedLyrics || "")
    .split(/\r?\n/)
    .map(line => line.replace(/^(\[\d+:\d+(?:[.:]\d+)?\]\s*)+/, "").trim())
    .filter(Boolean)
    .join("\n");
}

async function fetchLyrics(artist, title) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${LRCLIB_URL}?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (response.status === 404) return { message: `No lyrics found for "${title}".`, lyrics: "" };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.instrumental) return { message: "Instrumental track.", lyrics: "" };
    const lyrics = payload?.plainLyrics || stripSyncedTimestamps(payload?.syncedLyrics);
    if (!lyrics) return { message: `No lyrics text available for "${title}".`, lyrics: "" };
    return { message: "", lyrics };
  } catch (err) {
    return { message: `Lyrics fetch failed: ${err?.message || err}.`, lyrics: "" };
  } finally {
    clearTimeout(timeout);
  }
}

function renderLyrics(entry) {
  if (!lyricsContent || !lyricsMessage) return;
  if (entry?.lyrics) {
    lyricsContent.textContent = entry.lyrics;
  } else {
    lyricsContent.innerHTML = "";
    lyricsMessage.textContent = entry?.message || "No lyrics available.";
    lyricsContent.appendChild(lyricsMessage);
  }
  lyricsContent.scrollTop = 0;
}

async function loadLyricsForTrack(artist, title) {
  if (!artist || !title) return;
  const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
  if (key === currentLyricsKey) return;
  currentLyricsKey = key;
  if (lyricsCache.has(key)) {
    renderLyrics(lyricsCache.get(key));
    return;
  }
  // Show a loading state immediately if the lyrics view is currently open.
  if (lyricsView && lyricsView.getAttribute("aria-hidden") === "false" && lyricsMessage) {
    lyricsMessage.textContent = `Looking up lyrics for "${title}"…`;
    lyricsContent.innerHTML = "";
    lyricsContent.appendChild(lyricsMessage);
  }
  const entry = await fetchLyrics(artist, title);
  // Only render if the track key is still current — another track may have
  // started while we were waiting on the network.
  if (currentLyricsKey === key) {
    lyricsCache.set(key, entry);
    renderLyrics(entry);
  }
}

// ---------------------------------------------------------------------------
// CAF setup
// ---------------------------------------------------------------------------

const hasCaf        = typeof cast !== "undefined" && cast?.framework?.CastReceiverContext;
const context       = hasCaf ? cast.framework.CastReceiverContext.getInstance() : null;
const playerManager = context ? context.getPlayerManager() : null;

// CastDebugLogger surfaces the platform's MEDIA_NETWORK / MEDIA_LOAD error codes
// to the on-screen debug line. Without this, the previous "CAF play/load failed:
// unknown" error swallowed every interesting cause (TLS renegotiation aborts,
// CSP blocks, sandbox refusals) and forced re-investigation from scratch.
const debugLogger = (typeof cast !== "undefined" && cast?.debug?.CastDebugLogger)
  ? cast.debug.CastDebugLogger.getInstance()
  : null;

if (debugLogger) {
  try {
    debugLogger.loggerLevelByEvents = {
      "cast.framework.events.category.CORE":
        cast.framework.LoggerLevel.INFO,
      "cast.framework.events.EventType.MEDIA_STATUS":
        cast.framework.LoggerLevel.DEBUG,
    };
    debugLogger.setEnabled(true);
  } catch {
    // Best-effort; logger is purely diagnostic.
  }
}

function logCafError(prefix, eventOrError) {
  const detail =
    eventOrError?.detailedErrorCode ??
    eventOrError?.error?.detailedErrorCode ??
    eventOrError?.message ??
    "unknown";
  logDebug(`${prefix}: ${detail}`);
}

function currentStreamUrl() {
  try {
    const state = playerManager?.getPlayerState?.();
    if (!state || state === cast.framework.messages.PlayerState.IDLE) return DEFAULT_STREAM_URL;
    const info = playerManager?.getMediaInformation?.();
    const url  = info?.contentUrl || info?.contentId;
    if (typeof url === "string" && url.length > 0) return url;
  } catch {}
  return DEFAULT_STREAM_URL;
}

function createStreamLoadRequest(url) {
  const media = new cast.framework.messages.MediaInformation();
  media.contentId   = url;
  media.contentUrl  = url;
  media.contentType = "audio/mpeg";
  media.streamType  = cast.framework.messages.StreamType.LIVE;
  media.metadata    = new cast.framework.messages.MusicTrackMediaMetadata();
  media.metadata.title = "Radio Orbital";

  const request = new cast.framework.messages.LoadRequestData();
  request.requestId = nextLocalRequestId++;
  request.media     = media;
  request.autoplay  = true;
  return request;
}

async function waitForCastPlaybackStart(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = playerManager?.getPlayerState?.();
    if (
      state === cast.framework.messages.PlayerState.PLAYING ||
      state === cast.framework.messages.PlayerState.BUFFERING
    ) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function loadStreamThroughCastPlayer(url) {
  if (!playerManager || !cast?.framework?.messages) return false;
  try {
    await playerManager.load(createStreamLoadRequest(url));
  } catch {
    // load() may reject if the player is in an error state;
    // let waitForCastPlaybackStart determine the final outcome.
  }
  return waitForCastPlaybackStart();
}

// ---------------------------------------------------------------------------
// APPROACH B — MutationObserver: nuke <touch-controls> the moment it appears
// ---------------------------------------------------------------------------
// The Cast platform injects <touch-controls> into document.body on smart
// displays to intercept all touch events for its own playback overlay.
// We watch the entire DOM tree and remove the node instantly.

function removeTouchControls() {
  document.querySelectorAll("touch-controls").forEach(el => {
    try { el.remove(); } catch {}
  });
}

// Start watching before context.start() so we catch the first insertion.
(function installTouchControlsObserver() {
  const obs = new MutationObserver(removeTouchControls);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  removeTouchControls(); // remove any already-present instance
})();

// ---------------------------------------------------------------------------
// Named action functions (used by both hookButton and the capture interceptor)
// ---------------------------------------------------------------------------

async function playAction() {
  logDebug("playAction fired");
  try {
    const url = currentStreamUrl();

    if (playerManager) {
      const state = playerManager.getPlayerState?.();
      const idle  = !state || state === cast.framework.messages.PlayerState.IDLE;
      try {
        if (idle) {
          setStatus("Loading…");
          const loaded = await loadStreamThroughCastPlayer(url);
          if (!loaded) throw new Error("Cast player did not start.");
          setStatus("Playing");
          setCastStatus("Playing");
          return;
        }
        playerManager.play();
        if (!(await waitForCastPlaybackStart(3000))) {
          throw new Error("Cast player did not resume.");
        }
        setStatus("Playing");
        setCastStatus("Playing");
        return;
      } catch (err) {
        setStatus("Cast play failed");
        setCastStatus("Cast play failed", { isProblem: true });
        logCafError("CAF play/load failed", err);
        return;
      }
    }

    // Fallback: local HTML audio element (laptop browser preview only).
    if (localAudio) {
      if (localAudio.src !== url) localAudio.src = url;
      await localAudio.play();
    }
    setStatus("Playing");
    setCastStatus("Local play");
  } catch {
    setStatus("Tap again");
    setCastStatus("Play failed", { isProblem: true });
    logDebug("Play failed — check hosting URL / CSP.");
  }
}

function stopAction() {
  logDebug("stopAction fired");
  try { playerManager?.pause?.(); } catch {}
  try { localAudio?.pause();       } catch {}
  setStatus("Stopped");
}

// ---------------------------------------------------------------------------
// APPROACH C — Capture-phase global touch interceptor
// ---------------------------------------------------------------------------
// Registers on *document* at the capture phase so it fires BEFORE any element
// handler — including the platform <touch-controls> overlay.
// Uses document.elementsFromPoint() to find our buttons underneath whatever
// sits on top visually. Calls stopImmediatePropagation() so the overlay never
// receives the event, then drives the action directly.

(function installCaptureTouchInterceptor() {
  let _activeBtn  = null;
  let _startTouch = null;

  function findButton(x, y) {
    try {
      const els = document.elementsFromPoint(x, y);
      for (const el of els) {
        if (el === playBtn   || (playBtn   && playBtn.contains(el)))   return playBtn;
        if (el === stopBtn   || (stopBtn   && stopBtn.contains(el)))   return stopBtn;
        if (el === lyricsBtn || (lyricsBtn && lyricsBtn.contains(el))) return lyricsBtn;
      }
    } catch {}
    return null;
  }

  document.addEventListener("touchstart", function(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    const btn = findButton(t.clientX, t.clientY);
    if (!btn) return;
    _activeBtn  = btn;
    _startTouch = { x: t.clientX, y: t.clientY };
    btn.classList.add("pressed");
    e.stopImmediatePropagation();
    e.preventDefault();
    logDebug("Capture: " + btn.id + " pressed");
  }, { capture: true, passive: false });

  document.addEventListener("touchend", function(e) {
    if (!_activeBtn) return;
    const btn = _activeBtn;
    _activeBtn  = null;
    _startTouch = null;
    btn.classList.remove("pressed");
    e.stopImmediatePropagation();
    e.preventDefault();
    logDebug("Capture: " + btn.id + " released → action");
    if (btn === playBtn) playAction();
    else if (btn === stopBtn) stopAction();
    else if (btn === lyricsBtn) showLyrics();
  }, { capture: true, passive: false });

  document.addEventListener("touchmove", function(e) {
    // If finger drifts far from start, cancel the press (treat as scroll)
    if (!_activeBtn || !_startTouch) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = t.clientX - _startTouch.x;
    const dy = t.clientY - _startTouch.y;
    if (Math.sqrt(dx * dx + dy * dy) > 12) {
      _activeBtn.classList.remove("pressed");
      _activeBtn  = null;
      _startTouch = null;
    }
  }, { capture: true, passive: true });

  document.addEventListener("touchcancel", function() {
    if (_activeBtn) {
      _activeBtn.classList.remove("pressed");
      _activeBtn = null;
    }
    _startTouch = null;
  }, { capture: true });
})();

// ---------------------------------------------------------------------------
// Mouse fallback via hookButton (laptop browser preview)
// ---------------------------------------------------------------------------
// Touch is now handled entirely by the capture interceptor above.
// hookButton is kept only for mouse events so the desktop preview works.

function hookButton(element, onPress) {
  if (!element) return;
  element.addEventListener("mousedown",  () => element.classList.add("pressed"));
  element.addEventListener("mouseup",    () => { element.classList.remove("pressed"); onPress(); });
  element.addEventListener("mouseleave", () => element.classList.remove("pressed"));
}

hookButton(playBtn, playAction);
hookButton(stopBtn, stopAction);
hookButton(lyricsBtn, showLyrics);

// ---------------------------------------------------------------------------
// Lyrics view show / hide with cross-fade
// ---------------------------------------------------------------------------
// The CSS transitions on .body and .lyrics-view do the heavy lifting — JS
// just toggles `aria-hidden`. We keep both elements in the same grid cell
// (.stage) so they cross-fade in place without a layout jump.

function showLyrics() {
  if (!bodyView || !lyricsView) return;
  // If we don't have lyrics for the current track yet, render the loading
  // message immediately so the view isn't blank on first reveal.
  if (currentLyricsKey && !lyricsCache.has(currentLyricsKey) && lyricsMessage) {
    lyricsMessage.textContent = "Looking up lyrics…";
    lyricsContent.innerHTML = "";
    lyricsContent.appendChild(lyricsMessage);
  }
  bodyView.setAttribute("aria-hidden", "true");
  lyricsView.setAttribute("aria-hidden", "false");
}

function hideLyrics() {
  if (!bodyView || !lyricsView) return;
  lyricsView.setAttribute("aria-hidden", "true");
  bodyView.setAttribute("aria-hidden", "false");
}

// Tap-to-dismiss on the lyrics view, with the same tap-vs-scroll heuristic
// used by the play/stop capture interceptor (>12px move = scroll, not tap).
// Mouse click also dismisses for laptop-browser preview.
if (lyricsView) {
  let _lyricsStartTouch = null;
  let _lyricsScrolled = false;

  lyricsView.addEventListener("touchstart", (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    _lyricsStartTouch = { x: t.clientX, y: t.clientY };
    _lyricsScrolled = false;
  }, { passive: true });

  lyricsView.addEventListener("touchmove", (e) => {
    if (!_lyricsStartTouch) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = t.clientX - _lyricsStartTouch.x;
    const dy = t.clientY - _lyricsStartTouch.y;
    if (Math.sqrt(dx * dx + dy * dy) > 12) _lyricsScrolled = true;
  }, { passive: true });

  lyricsView.addEventListener("touchend", () => {
    if (_lyricsStartTouch && !_lyricsScrolled) hideLyrics();
    _lyricsStartTouch = null;
    _lyricsScrolled = false;
  }, { passive: true });

  // Desktop preview / mouse fallback. The pressed state on .btn buttons uses
  // mousedown/up; for the lyrics view a click is enough.
  lyricsView.addEventListener("click", hideLyrics);
}

// ---------------------------------------------------------------------------
// Audio element listeners
// ---------------------------------------------------------------------------

if (localAudio) {
  localAudio.addEventListener("waiting", () => setStatus("Buffering…"));
  localAudio.addEventListener("playing", () => setStatus("Playing"));
  localAudio.addEventListener("error",   () => {
    setStatus("Error");
    setCastStatus("Local audio error", { isProblem: true });
    const code = localAudio.error?.code ?? "unknown";
    const msg  = localAudio.error?.message ?? "";
    logDebug(`Local audio error (code=${code}) ${msg}`);
  });
}

// ---------------------------------------------------------------------------
// CAF player event listeners
// ---------------------------------------------------------------------------

// Defensive listener registration. CAF SDK enum drift (e.g., v3.0.0137 silently
// removed `EventType.STOPPED`) has already aborted top-level evaluation once,
// killing context.start() before the IPC channel to the sender could open.
// Skip undefined/null event types and trap any throw from addEventListener so
// a single missing enum key cannot brick the receiver again.
function tryAddListener(target, eventType, handler) {
  if (eventType === undefined || eventType === null) {
    logDebug("Skipped listener: event type missing in SDK.");
    setCastStatus("SDK listener missing", { isProblem: true });
    return;
  }
  try {
    target.addEventListener(eventType, handler);
  } catch (err) {
    logDebug(`Listener registration failed for ${String(eventType)}: ${err?.message ?? err}`);
    setCastStatus("SDK listener error", { isProblem: true });
  }
}

// Runtime canary — surfaces the next SDK-enum regression as an on-screen line
// instead of a silent abort. Checked at top-level eval, before context.start().
if (hasCaf) {
  const events = cast?.framework?.events?.EventType ?? {};
  const sysEvents = cast?.framework?.system?.EventType ?? {};
  const missing = [];
  const playerKeys = ["PLAYER_LOAD_COMPLETE", "ERROR", "MEDIA_FINISHED", "PLAYING", "PAUSE"];
  const contextKeys = ["SENDER_CONNECTED", "SENDER_DISCONNECTED"];
  for (const k of playerKeys) if (events[k] === undefined) missing.push(`events.${k}`);
  for (const k of contextKeys) if (sysEvents[k] === undefined) missing.push(`system.${k}`);
  if (missing.length > 0) {
    logDebug(`SDK enum missing: ${missing.join(", ")}`);
    setCastStatus("SDK enum missing", { isProblem: true });
  }
}

if (playerManager) {
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    (loadRequestData) => {
      const requestedUrl = loadRequestData?.media?.contentId || DEFAULT_STREAM_URL;

      loadRequestData.media             = loadRequestData.media || {};
      loadRequestData.media.contentId   = requestedUrl;
      loadRequestData.media.contentUrl  = requestedUrl;
      loadRequestData.media.contentType =
        loadRequestData.media.contentType || "audio/mpeg";
      loadRequestData.media.streamType  = cast.framework.messages.StreamType.LIVE;
      loadRequestData.autoplay          = true;
      loadRequestData.media.metadata    =
        loadRequestData.media.metadata ||
        new cast.framework.messages.MusicTrackMediaMetadata();
      loadRequestData.media.metadata.title =
        loadRequestData.media.metadata.title || "Rádio Orbital";

      if (nowPlaying) nowPlaying.textContent = `Streaming: ${requestedUrl}`;
      setCastStatus("Connected");
      setStatus("Loading stream…");
      logDebug("LOAD intercepted: starting live stream.");
      return loadRequestData;
    }
  );

  tryAddListener(
    playerManager,
    cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    () => {
      setStatus("Live");
      // Platform may re-inject <touch-controls> after a load — nuke it again.
      removeTouchControls();
    }
  );

  tryAddListener(
    playerManager,
    cast.framework.events.EventType.ERROR,
    (event) => {
      setStatus("Error");
      setCastStatus("Playback error", { isProblem: true });
      logCafError("Playback error", event);
    }
  );

  // MEDIA_FINISHED with idleReason !== FINISHED indicates a silent failure (e.g.,
  // TLS renegotiation killed the fetch). Log the reason so we don't have to guess.
  // MEDIA_FINISHED also covers "playback ended" semantics that the now-removed
  // EventType.STOPPED listener used to handle (STOPPED was dropped in CAF v3.0.0137).
  tryAddListener(
    playerManager,
    cast.framework.events.EventType.MEDIA_FINISHED,
    (event) => {
      const reason = event?.endedReason ?? "unknown";
      logDebug(`Media finished: ${reason}`);
      // Preserve the user-visible "Stopped" footer that the deleted STOPPED
      // listener used to set. Without this, the footer would stay on "Playing"
      // after a natural end-of-stream / network drop.
      setStatus("Stopped");
    }
  );

  tryAddListener(playerManager, cast.framework.events.EventType.PLAYING, () => setStatus("Playing"));
  tryAddListener(playerManager, cast.framework.events.EventType.PAUSE,   () => setStatus("Paused"));
}

// ---------------------------------------------------------------------------
// CAF context event listeners
// ---------------------------------------------------------------------------

if (context) {
  tryAddListener(
    context,
    cast.framework.system.EventType.SENDER_CONNECTED,
    () => {
      setCastStatus("Sender connected");
      logDebug("Sender connected.");
    }
  );

  tryAddListener(
    context,
    cast.framework.system.EventType.SENDER_DISCONNECTED,
    (event) => {
      const remaining = context.getSenders()?.length ?? 0;
      if (
        remaining === 0 &&
        event?.reason === cast.framework.system.DisconnectReason.REQUESTED_BY_SENDER
      ) {
        setCastStatus("Disconnected");
        setStatus("Ready");
        logDebug("All senders disconnected.");
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Start CAF
// ---------------------------------------------------------------------------

if (context) {
  context.start({ uiConfig: { touchScreenOptimizedApp: true } });
  // Run a final removal pass after start() because the platform can insert
  // <touch-controls> asynchronously (the MutationObserver covers future insertions).
  removeTouchControls();
  setTimeout(removeTouchControls, 500);
  setCastStatus("Waiting for sender…");
  logDebug("CAF loaded: ready for sender.");
} else {
  setCastStatus("Receiver page loaded");
  logDebug(
    "CAF NOT loaded. Host this page on GitHub Pages (HTTPS) and set that URL as the Receiver URL in the Cast SDK console."
  );
}

setStatus("Ready");
refreshTrackMetadata();
setInterval(refreshTrackMetadata, METADATA_REFRESH_MS);

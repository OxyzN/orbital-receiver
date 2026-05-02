// Custom receiver logic (CAF)
// - Intercepts LOAD and ensures the live stream is played
// - Updates the on-screen status text for Nest Hub
// - Provides local Play/Stop buttons (touchscreen)

const DEFAULT_STREAM_URL = "https://ec2.yesstreaming.net:3025/stream";
const ICECAST_STATUS_URL = "https://ec2.yesstreaming.net:3025/status-json.xsl";
const METADATA_REFRESH_MS = 15000;

const castStatusText = document.getElementById("castStatusText");
const statusText = document.getElementById("statusText");
const nowPlaying = document.getElementById("nowPlaying");
const trackTitle = document.getElementById("trackTitle");
const trackArtist = document.getElementById("trackArtist");
const debugLine = document.getElementById("debugLine");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const localAudio = document.getElementById("radio");

const panel = document.querySelector("main.panel");

function fitToViewport() {
  if (!panel) return;

  panel.style.transform = "none";
  panel.style.transformOrigin = "center center";

  requestAnimationFrame(() => {
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const scale = Math.min(
      window.innerWidth / rect.width,
      window.innerHeight / rect.height,
      1
    );

    panel.style.transform = `scale(${scale})`;
  });
}

function setStatus(text) {
  if (statusText) statusText.textContent = text;
}

function setCastStatus(text) {
  if (castStatusText) castStatusText.textContent = text;
}

function logDebug(text) {
  if (debugLine) debugLine.textContent = text;
}

function splitTrackTitle(rawTitle) {
  const title = String(rawTitle || "").replace(/\s+/g, " ").trim();
  if (!title) return null;

  const match = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (!match) return { artist: "Radio Orbital", title };

  return {
    artist: match[1].trim(),
    title: match[2].trim(),
  };
}

function getIcecastSource(payload) {
  const source = payload?.icestats?.source;
  return Array.isArray(source) ? source[0] : source;
}

function renderTrackMetadata(metadata) {
  if (!metadata) return;

  if (trackTitle) trackTitle.textContent = metadata.title;
  if (trackArtist) trackArtist.textContent = metadata.artist;
  if (nowPlaying) nowPlaying.textContent = "Live from Lisbon";
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
    const source = getIcecastSource(payload);
    const metadata = splitTrackTitle(
      source?.title || source?.yp_currently_playing
    );

    renderTrackMetadata(metadata);
  } catch {
    if (nowPlaying) nowPlaying.textContent = "Track metadata unavailable.";
  }
}

const hasCaf = typeof cast !== "undefined" && cast?.framework?.CastReceiverContext;
const context = hasCaf ? cast.framework.CastReceiverContext.getInstance() : null;
const playerManager = context ? context.getPlayerManager() : null;
const mediaElement = playerManager ? playerManager.getMediaElement() : null;

function currentStreamUrl() {
  try {
    const info = playerManager?.getMediaInformation?.();
    const id = info?.contentId;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {}

  return DEFAULT_STREAM_URL;
}

async function loadStreamThroughCastPlayer(url) {
  if (!playerManager || !cast?.framework?.messages) return false;

  const media = new cast.framework.messages.MediaInformation();
  media.contentId = url;
  media.contentUrl = url;
  media.contentType = "audio/mpeg";
  media.streamType = cast.framework.messages.StreamType.LIVE;
  media.metadata = new cast.framework.messages.GenericMediaMetadata();
  media.metadata.title = "Radio Orbital";

  const request = new cast.framework.messages.LoadRequestData();
  request.media = media;
  request.autoplay = true;

  await playerManager.load(request);
  return true;
}

if (localAudio) {
  localAudio.addEventListener("waiting", () => setStatus("Buffering…"));
  localAudio.addEventListener("playing", () => setStatus("Playing"));
  localAudio.addEventListener("error", () => {
    setStatus("Error");
    logDebug("Local audio error (stream unreachable or unsupported).");
  });
}

if (playerManager) {
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    (loadRequestData) => {
      const requestedUrl = loadRequestData?.media?.contentId || DEFAULT_STREAM_URL;

      loadRequestData.media = loadRequestData.media || {};
      loadRequestData.media.contentId = requestedUrl;
      loadRequestData.media.contentUrl = requestedUrl;
      loadRequestData.media.contentType =
        loadRequestData.media.contentType || "audio/mpeg";
      loadRequestData.media.streamType = cast.framework.messages.StreamType.LIVE;
      loadRequestData.media.metadata =
        loadRequestData.media.metadata ||
        new cast.framework.messages.GenericMediaMetadata();
      loadRequestData.media.metadata.title =
        loadRequestData.media.metadata.title || "Rádio Orbital";

      if (nowPlaying) nowPlaying.textContent = `Streaming: ${requestedUrl}`;
      setCastStatus("Connected");
      setStatus("Loading stream…");
      logDebug("LOAD intercepted: starting live stream.");

      return loadRequestData;
    }
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    () => setStatus("Live")
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.ERROR,
    (event) => {
      setStatus("Error");
      logDebug(`Playback error: ${event?.detailedErrorCode ?? "unknown"}`);
    }
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYING,
    () => setStatus("Playing")
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.PAUSE,
    () => setStatus("Paused")
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.STOPPED,
    () => setStatus("Stopped")
  );
}

if (context) {
  context.addEventListener(
    cast.framework.system.EventType.SENDER_CONNECTED,
    () => {
      setCastStatus("Sender connected");
      logDebug("Sender connected.");
    }
  );

  context.addEventListener(
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

playBtn?.addEventListener("click", async () => {
  try {
    const url = currentStreamUrl();

    if (playerManager) {
      // If CAF has media loaded (paused/buffering), resume via CAF.
      // If IDLE, load the stream through CAF so the Nest Hub routes audio properly.
      const state = playerManager.getPlayerState?.();
      const idle = !state || state === cast.framework.messages.PlayerState.IDLE;
      try {
        if (idle) {
          await loadStreamThroughCastPlayer(url);
          setStatus("Playing");
          setCastStatus("Playing");
          return;
        }

        playerManager.play();
        setStatus("Playing");
        setCastStatus("Playing");
        return;
      } catch {
        logDebug("CAF play/load failed; trying local preview audio.");
      }
    }

    // Fallback: local HTML audio element.
    if (localAudio) {
      if (localAudio.src !== url) localAudio.src = url;
      await localAudio.play();
    } else if (mediaElement) {
      if (!mediaElement.src) mediaElement.src = url;
      await mediaElement.play();
    }

    setStatus("Playing");
    setCastStatus(playerManager ? "Playing" : "Local play");
  } catch {
    setStatus("Tap again");
    logDebug(
      "Play failed. If this receiver is hosted on github.com (blob URL), CAF is usually blocked by CSP. Use a real HTTPS host (GitHub Pages/Netlify) and set that as Receiver URL."
    );
  }
});

stopBtn?.addEventListener("click", () => {
  try {
    // pause() keeps media loaded so play() can resume; stop() unloads it entirely
    playerManager?.pause?.();
  } catch {}

  try {
    localAudio?.pause();
  } catch {}

  try {
    mediaElement?.pause();
  } catch {}

  setStatus("Stopped");
});

if (context) {
  context.start();
  setCastStatus("Waiting for sender…");
  logDebug("CAF loaded: ready for sender.");
} else {
  setCastStatus("Receiver page loaded");
  logDebug(
    "CAF NOT loaded. This usually means your Receiver URL is pointing at github.com (blob) or a host with a strict CSP. Host this page on GitHub Pages (HTTPS) and use that URL in the Cast Console."
  );
}
setStatus("Ready");

refreshTrackMetadata();
setInterval(refreshTrackMetadata, METADATA_REFRESH_MS);

fitToViewport();
window.addEventListener("resize", fitToViewport);

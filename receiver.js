// Custom receiver logic (CAF)
// - Intercepts LOAD and ensures the live stream is played
// - Updates the on-screen status text for Nest Hub
// - Provides local Play/Stop buttons (touchscreen)

const DEFAULT_STREAM_URL = "https://ec2.yesstreaming.net:3025/stream";

const castStatusText = document.getElementById("castStatusText");
const statusText = document.getElementById("statusText");
const nowPlaying = document.getElementById("nowPlaying");
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
      // If IDLE (no sender has loaded anything yet), fall through to local audio.
      const state = playerManager.getPlayerState?.();
      const idle = !state || state === cast.framework.messages.PlayerState.IDLE;
      if (!idle) {
        try {
          playerManager.play();
          setStatus("Playing");
          setCastStatus("Playing");
          return;
        } catch {}
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

fitToViewport();
window.addEventListener("resize", fitToViewport);

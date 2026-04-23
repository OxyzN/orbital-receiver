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

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const mediaElement = playerManager.getMediaElement();

function setStatus(text) {
  statusText.textContent = text;
}

function setCastStatus(text) {
  castStatusText.textContent = text;
}

function logDebug(text) {
  debugLine.textContent = text;
}

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  (loadRequestData) => {
    const requestedUrl = loadRequestData?.media?.contentId || DEFAULT_STREAM_URL;

    loadRequestData.media = loadRequestData.media || {};
    loadRequestData.media.contentId = requestedUrl;
    loadRequestData.media.contentType = loadRequestData.media.contentType || "audio/mpeg";
    loadRequestData.media.streamType = cast.framework.messages.StreamType.LIVE;
    loadRequestData.media.metadata = loadRequestData.media.metadata || new cast.framework.messages.MusicTrackMediaMetadata();
    loadRequestData.media.metadata.title = loadRequestData.media.metadata.title || "Rádio Orbital";

    nowPlaying.textContent = `Streaming: ${requestedUrl}`;
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
    if (remaining === 0 && event?.reason === cast.framework.system.DisconnectReason.REQUESTED_BY_SENDER) {
      setCastStatus("Disconnected");
      setStatus("Ready");
      logDebug("All senders disconnected.");
    }
  }
);

playBtn.addEventListener("click", async () => {
  try {
    if (!mediaElement.src) {
      mediaElement.src = DEFAULT_STREAM_URL;
      mediaElement.type = "audio/mpeg";
    }
    await mediaElement.play();
    setStatus("Playing");
    setCastStatus("Local play");
  } catch (e) {
    setStatus("Tap again");
    logDebug("Local play blocked or failed.");
  }
});

stopBtn.addEventListener("click", () => {
  mediaElement.pause();
  mediaElement.removeAttribute("src");
  mediaElement.load();
  setStatus("Stopped");
});

context.start();
setCastStatus("Waiting for sender…");
setStatus("Ready");


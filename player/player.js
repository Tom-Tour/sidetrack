// Page hébergée sur une vraie origine https : YouTube accepte d'y intégrer son lecteur.
// L'extension l'affiche dans une iframe et la pilote par postMessage.
let player = null;
let pending = null;
let importingPlaylist = false;

function send(msg) {
  parent.postMessage({ sidetrack: true, ...msg }, "*");
}

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { autoplay: 1, playsinline: 1 },
    events: {
      onReady: () => {
        send({ type: "ready" });
        if (pending) run(pending);
        pending = null;
      },
      onStateChange: (e) => {
        send({ type: "state", state: e.data });
        if (importingPlaylist && e.data === YT.PlayerState.CUED) sendPlaylist(0);
      },
      onError: (e) => send({ type: "error", code: e.data }),
    },
  });
};

function sendPlaylist(attempt) {
  const ids = player.getPlaylist();
  if (ids?.length) {
    importingPlaylist = false;
    send({ type: "playlist", ids });
  } else if (attempt < 20) {
    setTimeout(() => sendPlaylist(attempt + 1), 250);
  } else {
    importingPlaylist = false;
    send({ type: "error", code: "playlist-empty" });
  }
}

function run(cmd) {
  if (!player?.loadVideoById) {
    pending = cmd;
    return;
  }
  switch (cmd.action) {
    case "load":
      player.loadVideoById(cmd.id);
      break;
    case "playlist":
      importingPlaylist = true;
      player.cuePlaylist({ listType: "playlist", list: cmd.list });
      break;
    case "play":
      player.playVideo();
      break;
    case "pause":
      player.pauseVideo();
      break;
  }
}

window.addEventListener("message", (e) => {
  if (e.source !== parent || !e.data?.sidetrack) return;
  run(e.data);
});

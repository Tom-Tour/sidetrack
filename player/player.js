// Page hébergée sur une vraie origine https : YouTube accepte d'y intégrer son lecteur.
// L'extension l'affiche dans une iframe et la pilote par postMessage.
let player = null;
let pending = null;
let importingPlaylist = false;
let randomStart = null;  // { clip } : sauter à un moment aléatoire avant d'annoncer le départ
let announced = false;

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
        if (e.data === YT.PlayerState.PLAYING) onPlaying();
        if (importingPlaylist && e.data === YT.PlayerState.CUED) sendPlaylist(0);
      },
      onError: (e) => send({ type: "error", code: e.data }),
    },
  });
};

// Prévient l'extension quand la lecture démarre vraiment (après un éventuel saut).
function onPlaying() {
  if (announced) return;
  if (randomStart) {
    const duration = player.getDuration();
    const { clip } = randomStart;
    randomStart = null;
    if (duration > 0) {
      const max = Math.max(0, duration - (clip || 30) - 5);
      const min = Math.min(duration * 0.1, max);
      player.seekTo(min + Math.random() * (max - min), true);
      waitPlaying(0);
      return;
    }
  }
  announced = true;
  player.unMute();
  send({ type: "started" });
  // Diagnostic : Firefox peut bloquer le son d'un lecteur qui n'a reçu aucun clic.
  setTimeout(() => {
    send({ type: "debug", muted: player.isMuted(), state: player.getPlayerState(), volume: player.getVolume() });
  }, 1000);
}

function waitPlaying(attempt) {
  if (announced) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING && attempt > 0) onPlaying();
  else if (attempt < 40) setTimeout(() => waitPlaying(attempt + 1), 250);
}

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
      announced = false;
      randomStart = cmd.randomStart ? { clip: cmd.clip } : null;
      // Démarrage toujours en muet : c'est la seule lecture automatique que Firefox autorise
      // sans clic. Le son revient dans onPlaying, après l'éventuel saut aléatoire.
      player.mute();
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

// Page hébergée sur une vraie origine https : YouTube accepte d'y intégrer son lecteur.
// Deux usages :
// - onglet masqué ouvert par l'extension : c'est lui qui joue le son, piloté par postMessage
//   via son script de contenu (player-bridge.js) ;
// - ?mirror=1 dans une iframe de la barre latérale : copie muette qui suit l'onglet.
const mirror = new URLSearchParams(location.search).has("mirror");
const embedded = window.parent !== window;

let player = null;
let pending = null;
let importingPlaylist = false;
let randomStart = null;  // { clip } : sauter à un moment aléatoire avant d'annoncer le départ
let announced = false;
let unmutedAt = 0;       // Firefox met en pause un lecteur qui reprend le son sans clic préalable
let volume = 100;
let wantPlaying = false;
let stalled = 0;
let lastPing = 0;        // dernier signe de vie de l'extension
let orphaned = false;

const unlock = document.getElementById("unlock");

function send(msg) {
  const data = { sidetrack: true, ...msg };
  if (embedded) parent.postMessage(data, "*");
  else window.postMessage(data, location.origin);
}

function unMute() {
  player.unMute();
  player.setVolume(volume);
}

unlock.addEventListener("click", () => {
  unlock.hidden = true;
  if (player?.playVideo) {
    unMute();
    if (player.getPlayerState() === YT.PlayerState.PAUSED) player.playVideo();
  }
  send({ type: "unblocked" });
});

if (!mirror) {
  // Sans clic dans cette page, Firefox refuse le son : on propose le clic tout de suite.
  const autoplay = navigator.getAutoplayPolicy?.("mediaelement") ?? "unknown";
  if (autoplay !== "allowed") unlock.hidden = false;
  send({ type: "hello", autoplay });
}

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { autoplay: 1, playsinline: 1, mute: mirror ? 1 : 0 },
    events: {
      onReady: () => {
        if (mirror) player.mute();
        send({ type: "ready" });
        if (pending) run(pending);
        pending = null;
      },
      onStateChange: (e) => {
        if (mirror) return;
        send({ type: "state", state: e.data });
        if (e.data === YT.PlayerState.PLAYING) onPlaying();
        if (e.data === YT.PlayerState.PAUSED) {
          if (Date.now() - unmutedAt < 2000) {
            unlock.hidden = false;
            send({ type: "blocked" });
          } else {
            wantPlaying = false; // pause demandée (ou faite directement dans l'onglet)
          }
        }
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
  unmutedAt = Date.now();
  unMute();
  send({ type: "started" });
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

// Copie muette : suit la vidéo et la position de l'onglet du lecteur
function sync({ id, time, playing }) {
  if (player.getVideoData()?.video_id !== id) {
    if (playing) player.loadVideoById({ videoId: id, startSeconds: time });
    else player.cueVideoById({ videoId: id, startSeconds: time });
    return;
  }
  if (Math.abs(player.getCurrentTime() - time) > 1.5) player.seekTo(time, true);
  const state = player.getPlayerState();
  if (playing && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) player.playVideo();
  if (!playing && state === YT.PlayerState.PLAYING) player.pauseVideo();
}

function run(cmd) {
  if (!player?.loadVideoById) {
    pending = cmd;
    return;
  }
  switch (cmd.action) {
    case "load":
      announced = false;
      wantPlaying = true;
      if (cmd.volume != null) volume = cmd.volume;
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
      unmutedAt = 0;
      wantPlaying = true;
      player.playVideo();
      break;
    case "pause":
      unmutedAt = 0;
      wantPlaying = false;
      player.pauseVideo();
      break;
    case "volume":
      volume = cmd.value;
      if (!player.isMuted()) player.setVolume(volume);
      break;
    case "sync":
      if (mirror) sync(cmd);
      break;
  }
}

window.addEventListener("message", (e) => {
  // On ignore nos propres messages sortants (ils ont un "type", pas d'"action")
  if (e.source !== (embedded ? parent : window) || !e.data?.sidetrack || !e.data.action) return;
  if (e.data.action === "ping") {
    lastPing = Date.now();
    return;
  }
  run(e.data);
});

// Onglet du lecteur : position pour la copie muette, filet de sécurité, désinstallation
if (!mirror && !embedded) {
  setInterval(() => {
    if (!player?.getPlayerState || orphaned) return;
    const state = player.getPlayerState();
    send({ type: "tick", id: player.getVideoData()?.video_id, time: player.getCurrentTime(), state });

    // Une lecture demandée qui reste bloquée au départ est relancée
    if (wantPlaying && unlock.hidden && (state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.CUED)) {
      if (++stalled >= 3) {
        stalled = 0;
        send({ type: "log", text: "Relance de la lecture" });
        player.playVideo();
      }
    } else {
      stalled = 0;
    }

    // Plus de nouvelles de l'extension (désinstallée ou désactivée) : on s'arrête
    if (lastPing && Date.now() - lastPing > 4000) {
      orphaned = true;
      player.pauseVideo();
      window.close();
      document.body.textContent = "Sidetrack n'est plus actif : tu peux fermer cet onglet.";
      document.body.style.cssText = "color:#fff;display:flex;align-items:center;justify-content:center";
    }
  }, 1000);
}

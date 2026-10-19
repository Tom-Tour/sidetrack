// Page hébergée sur une vraie origine https : YouTube accepte d'y intégrer son lecteur.
// L'extension l'ouvre dans un onglet masqué et la pilote par postMessage,
// relayé par son script de contenu (player-bridge.js).

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
let lastCheck = 0;       // dernier passage du minuteur de surveillance
let orphaned = false;

let lastLoad = null;     // dernière commande « load », rejouée en cas d'échec
let retried = false;     // une seule nouvelle tentative par chargement
let stallRestarts = 0;

const unlock = document.getElementById("unlock");
const cover = document.getElementById("cover");

// Textes de la page, dans la langue du navigateur
const TEXT = navigator.language.toLowerCase().startsWith("fr")
  ? {
      title: "Sidetrack est presque prêt",
      click: "Clique sur « Lancer Sidetrack » : Firefox n'autorise le son qu'après un clic dans la page. Cet onglet se range ensuite tout seul et reste prêt jusqu'à la fermeture de Firefox.",
      autoplay: "Facultatif, pour ne plus voir cet écran : Firefox ne le propose pas de lui-même, c'est un réglage à ajouter une fois. Paramètres → Vie privée et sécurité → Permissions → Lecture automatique → Paramètres… → saisis tom-tour.github.io, choisis « Autoriser l'audio et la vidéo », puis Enregistrer.",
      hide: "Firefox peut ensuite demander une autorisation : « Une extension masque certains de vos onglets ». Clique sur « Garder les onglets masqués » : c'est ce qui permet à Sidetrack de ranger proprement cet onglet hors de la barre d'onglets (il reste accessible avec 📺 dans le panneau). Tu peux aussi le laisser visible dans les réglages de Sidetrack.",
      unlock: "🔊 Lancer Sidetrack",
      orphan: "Sidetrack n'est plus actif : tu peux fermer cet onglet.",
    }
  : {
      title: "Sidetrack is almost ready",
      click: "Click “Launch Sidetrack”: Firefox only allows sound after a click in the page. This tab then tucks itself away and stays ready until Firefox closes.",
      autoplay: "Optional, to stop seeing this screen: Firefox never offers it on its own, it's a setting to add once. Settings → Privacy & Security → Permissions → Autoplay → Settings… → type tom-tour.github.io, choose “Allow Audio and Video”, then Save Changes.",
      hide: "Firefox may then ask for permission: “An extension is hiding some of your tabs”. Click “Keep Tabs Hidden”: that lets Sidetrack tuck this tab neatly out of the tab bar (it stays reachable with 📺 in the sidebar). You can also keep it visible in Sidetrack's settings.",
      unlock: "🔊 Launch Sidetrack",
      orphan: "Sidetrack is no longer active: you can close this tab.",
    };
document.getElementById("setup-title").textContent = TEXT.title;
document.getElementById("step-click").textContent = TEXT.click;
document.getElementById("step-autoplay").textContent = TEXT.autoplay;
document.getElementById("step-hide").textContent = TEXT.hide;
unlock.querySelector("button").textContent = TEXT.unlock;

function send(msg) {
  window.postMessage({ sidetrack: true, ...msg }, location.origin);
}

// Volume 0 : on garde 1 %. Firefox ralentit un onglet masqué qui ne fait aucun bruit, la
// lecture de l'hôte saccade alors et tous les invités, recalés sur lui, saccadent avec.
const audible = (v) => Math.max(1, v);

function unMute() {
  player.unMute();
  player.setVolume(audible(volume));
}

unlock.addEventListener("click", () => {
  unlock.hidden = true;
  if (player?.playVideo) {
    unMute();
    if (player.getPlayerState() === YT.PlayerState.PAUSED) player.playVideo();
  }
  send({ type: "unblocked" });
});

// Sans clic dans cette page, Firefox refuse le son : on propose le clic tout de suite.
const autoplay = navigator.getAutoplayPolicy?.("mediaelement") ?? "unknown";
if (autoplay !== "allowed") unlock.hidden = false;
send({ type: "hello", autoplay });

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
        send({ type: "state", state: e.data, ...position() });
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
      onError: (e) => {
        // Le tout premier chargement échoue parfois sans raison : on retente une fois
        if (lastLoad && !retried) {
          retried = true;
          send({ type: "log", key: "logRetry" });
          setTimeout(() => load(lastLoad, true), 1000);
          return;
        }
        wantPlaying = false; // sinon le filet de sécurité relancerait la vidéo en erreur
        send({ type: "error", code: e.data });
      },
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
  send({ type: "started", duration: player.getDuration() });
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

// Vidéo et position actuelles (pour synchroniser les invités d'un salon)
function position() {
  return { id: player.getVideoData()?.video_id, time: player.getCurrentTime() };
}

function load(cmd, retry = false) {
  lastLoad = cmd;
  retried = retry;
  stallRestarts = 0;
  announced = false;
  wantPlaying = true;
  if (cmd.volume != null) volume = cmd.volume;
  randomStart = cmd.randomStart ? { clip: cmd.clip } : null;
  // Démarrage toujours en muet : c'est la seule lecture automatique que Firefox autorise
  // sans clic. Le son revient dans onPlaying, après l'éventuel saut aléatoire.
  player.mute();
  player.loadVideoById({ videoId: cmd.id, startSeconds: cmd.start ?? 0 });
}

function run(cmd) {
  if (!player?.loadVideoById) {
    pending = cmd;
    return;
  }
  switch (cmd.action) {
    case "load":
      load(cmd);
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
      if (!player.isMuted()) player.setVolume(audible(volume));
      break;
    case "seek":
      player.seekTo(cmd.time, true);
      break;
  }
}

window.addEventListener("message", (e) => {
  // On ignore nos propres messages sortants (ils ont un "type", pas d'"action")
  if (e.source !== window || !e.data?.sidetrack || !e.data.action) return;
  if (e.data.action === "ping") {
    lastPing = Date.now();
    return;
  }
  if (e.data.action === "orphan") return shutDown();
  // Fonctionne même avant que le lecteur YouTube soit prêt
  if (e.data.action === "cover") {
    cover.hidden = !e.data.on;
    return;
  }
  run(e.data);
});

// L'extension n'est plus là (désinstallée, désactivée ou rechargée) : on s'arrête
function shutDown() {
  if (orphaned) return;
  orphaned = true;
  player?.pauseVideo?.();
  window.close();
  document.body.textContent = TEXT.orphan;
  document.body.style.cssText = "color:#fff;display:flex;align-items:center;justify-content:center";
}

// Filet de sécurité et détection de la désinstallation
setInterval(() => {
  if (!player?.getPlayerState || orphaned) return;
  const state = player.getPlayerState();
  send({ type: "tick", state, ...position() });

  // Une lecture demandée qui reste bloquée au départ est relancée
  if (wantPlaying && unlock.hidden && (state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.CUED)) {
    if (++stalled >= 3) {
      stalled = 0;
      // Deux relances sans effet : on recharge carrément la vidéo (une fois)
      if (++stallRestarts > 2 && lastLoad && !retried) {
        send({ type: "log", key: "logReload" });
        load(lastLoad, true);
      } else {
        send({ type: "log", key: "logRetry" });
        player.playVideo();
      }
    }
  } else {
    stalled = 0;
  }

  // Secours : plus aucun signe de vie depuis une minute. Firefox ralentit les minuteurs
  // des onglets en arrière-plan : si ce minuteur-ci a lui-même pris du retard, les signes
  // de vie aussi, et on ne conclut rien.
  const now = Date.now();
  if (now - lastCheck > 5000) lastPing = Math.max(lastPing, now);
  lastCheck = now;
  if (lastPing && now - lastPing > 60000) shutDown();
}, 1000);

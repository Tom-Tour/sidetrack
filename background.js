// Moteur de Sidetrack : playlists, lecteur et blind test.
// Tourne en arrière-plan pour que la musique continue barre latérale fermée.
// La barre latérale n'est qu'une télécommande reliée par un port.
//
// Le lecteur vit dans un onglet épinglé : Firefox n'autorise le son que dans une page
// qui a reçu un clic, ce qui est impossible pour un lecteur caché en arrière-plan.

// Page du lecteur (dossier player/), hébergée sur GitHub Pages.
const PLAYER_URL = "https://tom-tour.github.io/sidetrack/player/index.html";
const EXPORT_CHUNK = 50;

// État sauvegardé dans storage.local
let state = {
  playlists: [],       // [{ id, name, items: [{ id, title }] }]
  current: null,       // id de la playlist affichée
  index: -1,           // morceau en cours dans la playlist
  shuffle: false,
  mode: "listen",      // "listen" | "blind"
  blind: { clip: 20, randomStart: true, hideVideo: true },
};

let playerState = -1;  // -1 non démarré, 0 fini, 1 lecture, 2 pause, 5 prête
let importTarget = null;
let notice = null;
let logLines = [];

// Partie de blind test en cours (non sauvegardée)
let game = { phase: "idle", order: [], pos: -1, score: 0, played: 0, remaining: 0 };
let gameTimer = null;

function log(msg) {
  logLines.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
  logLines.length = Math.min(logLines.length, 100);
  update();
}

function save() {
  browser.storage.local.set({ sidetrack: state });
}

// --- Liaison avec la barre latérale ---------------------------------------

const ports = new Set();
let updateScheduled = null;

function snapshot() {
  return { state, game, playerState, notice, log: logLines };
}

// Regroupe les mises à jour (un import de playlist en déclenche des centaines)
function update() {
  if (updateScheduled) return;
  updateScheduled = setTimeout(() => {
    updateScheduled = null;
    const snap = snapshot();
    for (const port of ports) port.postMessage(snap);
  }, 30);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "player") return connectPlayer(port);
  if (port.name !== "sidebar") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(({ cmd, args = [] }) => actions[cmd]?.(...args));
  port.postMessage(snapshot());
});

// --- Playlists -------------------------------------------------------------

function playlist(id = state.current) {
  return state.playlists.find((p) => p.id === id);
}

function items() {
  return playlist()?.items ?? [];
}

function newPlaylist(name) {
  const p = { id: crypto.randomUUID(), name, items: [] };
  state.playlists.push(p);
  return p;
}

function selectPlaylist(id) {
  if (state.current === id || !playlist(id)) return;
  state.current = id;
  state.index = -1;
  resetGame();
  send({ action: "pause" });
  update();
  save();
}

function deletePlaylist() {
  state.playlists = state.playlists.filter((p) => p.id !== state.current);
  state.current = null;
  selectPlaylist((state.playlists[0] ?? newPlaylist("Ma playlist")).id);
}

// --- Ajout de liens ----------------------------------------------------------

function parseLink(text) {
  text = text.trim();
  if (/^[\w-]{11}$/.test(text)) return { id: text, list: null };
  try {
    const u = new URL(text);
    let id = u.searchParams.get("v");
    if (u.hostname === "youtu.be") id = u.pathname.slice(1, 12);
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
    if (m) id = m[2];
    if (id && !/^[\w-]{11}$/.test(id)) id = null;
    return { id, list: u.searchParams.get("list") };
  } catch {
    return { id: null, list: null };
  }
}

async function fetchTitle(item) {
  try {
    const r = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + item.id)
    );
    item.title = r.ok ? (await r.json()).title : `(indisponible) ${item.id}`;
  } catch {
    item.title = item.id;
  }
  update();
  save();
}

function addItems(p, ids) {
  for (const id of ids) {
    const item = { id, title: id };
    p.items.push(item);
    fetchTitle(item);
  }
}

function addLink(text) {
  const p = playlist();
  const { id, list } = parseLink(text);
  if (list && !id) {
    importTarget = p.id;
    log(`Import de la playlist ${list}…`);
    send({ action: "playlist", list });
  } else if (id) {
    addItems(p, [id]);
    if (state.mode === "listen" && (state.index < 0 || playerState === 0)) play(p.items.length - 1);
  } else {
    log("✗ Lien non reconnu");
  }
  update();
  save();
}

function removeItem(i) {
  items().splice(i, 1);
  if (i < state.index) state.index--;
  else if (i === state.index) state.index = -1;
  update();
  save();
}

// --- Export vers YouTube ---------------------------------------------------
// watch_videos crée une playlist temporaire sans connexion ni clé d'API,
// que l'utilisateur enregistre ensuite dans son compte. 50 vidéos maximum par lien.

async function exportPlaylist() {
  const ids = items().map((item) => item.id);
  if (!ids.length) {
    notice = { text: "Playlist vide : rien à exporter." };
    return update();
  }
  const parts = Math.ceil(ids.length / EXPORT_CHUNK);
  for (let i = 0; i < parts; i++) {
    const chunk = ids.slice(i * EXPORT_CHUNK, (i + 1) * EXPORT_CHUNK);
    await browser.tabs.create({
      url: "https://www.youtube.com/watch_videos?video_ids=" + chunk.join(","),
      active: i === 0,
    });
  }
  notice = {
    text:
      (parts > 1 ? `Playlist ouverte sur YouTube en ${parts} parties (50 vidéos max par partie). ` : "Playlist ouverte sur YouTube. ") +
      "Pour la garder : dans le panneau de la playlist, ouvre le menu ⋮ puis « Tout ajouter à… » et choisis ou crée une playlist de ton compte.",
  };
  log(`Export : ${ids.length} vidéos, ${parts} onglet(s)`);
}

// --- Lecteur ---------------------------------------------------------------

const STATE_NAMES = { "-1": "non démarré", 0: "fini", 1: "lecture", 2: "pause", 3: "chargement", 5: "prêt" };

let playerPort = null;
let playerTabId = null;
let queued = [];
let opening = null;

function send(cmd) {
  if (playerPort) return playerPort.postMessage(cmd);
  if (cmd.action === "pause") return;
  queued.push(cmd);
  openPlayerTab();
}

let returnTabId = null;

// Ouvre l'onglet du lecteur, ou recharge celui qui existe déjà
// (après un rechargement de l'extension, son ancien pont est déconnecté).
// Il passe au premier plan : Firefox ne lance aucun média dans un onglet jamais affiché.
async function openPlayerTab() {
  if (opening) return;
  opening = setTimeout(() => (opening = null), 10000);
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  returnTabId = active?.id ?? null;
  const [tab] = await browser.tabs.query({ url: "https://tom-tour.github.io/sidetrack/player/*" });
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    browser.tabs.reload(tab.id);
  } else {
    browser.tabs.create({ url: PLAYER_URL, pinned: true, active: true });
  }
}

// Revient à l'onglet où l'on naviguait avant l'ouverture du lecteur
function backToBrowsing() {
  if (returnTabId != null) browser.tabs.update(returnTabId, { active: true }).catch(() => {});
  returnTabId = null;
}

function connectPlayer(port) {
  clearTimeout(opening);
  opening = null;
  playerPort = port;
  playerTabId = port.sender.tab.id;
  port.onMessage.addListener(onPlayerMessage);
  port.onDisconnect.addListener(() => {
    if (playerPort !== port) return;
    playerPort = null;
    playerState = -1;
    log("Onglet du lecteur fermé");
    update();
  });
  for (const cmd of queued) port.postMessage(cmd);
  queued = [];
}

function focusPlayer() {
  if (playerTabId != null) browser.tabs.update(playerTabId, { active: true });
}

function play(i, opts = {}) {
  if (i < 0 || i >= items().length) return;
  state.index = i;
  log(`Lecture : ${items()[i].title}`);
  send({ action: "load", id: items()[i].id, ...opts });
  update();
  save();
}

function onPlayerMessage(msg) {
  switch (msg.type) {
    case "ready":
      log("✓ Lecteur prêt");
      break;
    case "hello":
      log(`Lecture automatique : ${msg.autoplay}`);
      if (msg.autoplay === "allowed") {
        backToBrowsing();
      } else {
        notice = {
          text:
            "Clique sur « Activer le son » dans l'onglet Sidetrack épinglé (une fois par session). " +
            "Pour ne plus avoir à le faire : dans cet onglet, cadenas de la barre d'adresse → " +
            "Lecture automatique → Autoriser l'audio et la vidéo.",
          focus: true,
        };
        update();
      }
      break;
    case "blocked":
      log("🔇 Son bloqué par Firefox");
      notice = {
        text:
          "Firefox bloque le son tant que tu n'as pas cliqué dans l'onglet Sidetrack épinglé. " +
          "Clique sur « Activer le son » dans cet onglet. Pour ne plus jamais avoir à le faire : " +
          "dans cet onglet, cadenas de la barre d'adresse → Lecture automatique → Autoriser l'audio et la vidéo.",
        focus: true,
      };
      update();
      break;
    case "unblocked":
      notice = null;
      backToBrowsing();
      update();
      break;
    case "state":
      log(`État du lecteur : ${STATE_NAMES[msg.state] ?? msg.state}`);
      playerState = msg.state;
      if (msg.state === 0) onEnded();
      update();
      break;
    case "started":
      if (state.mode === "blind" && game.phase === "playing") startCountdown();
      break;
    case "error":
      log(`✗ Erreur YouTube ${msg.code}`);
      if (msg.code === "playlist-empty") break;
      if (state.mode === "blind") setTimeout(nextRound, 1000);
      else setTimeout(next, 1500);
      break;
    case "playlist": {
      const p = playlist(importTarget) ?? playlist();
      log(`✓ Playlist importée : ${msg.ids.length} vidéos`);
      const start = p.items.length;
      addItems(p, msg.ids);
      if (state.mode === "listen" && p.id === state.current) play(start);
      save();
      break;
    }
  }
}

function onEnded() {
  if (state.mode === "listen") next();
  else if (game.phase === "playing") timeUp();
}

// --- Mode écoute -----------------------------------------------------------

function next() {
  const n = items().length;
  if (!n) return;
  if (state.shuffle && n > 1) {
    let i;
    do i = Math.floor(Math.random() * n); while (i === state.index);
    play(i);
  } else if (state.index + 1 < n) {
    play(state.index + 1);
  }
}

function prev() {
  if (state.index > 0) play(state.index - 1);
}

function toggle() {
  if (state.index < 0 && items().length) return play(0);
  send({ action: playerState === 1 ? "pause" : "play" });
}

// --- Mode blind test -------------------------------------------------------

function shuffled(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resetGame() {
  clearInterval(gameTimer);
  game = { phase: "idle", order: [], pos: -1, score: 0, played: 0, remaining: 0 };
}

function startGame() {
  resetGame();
  game.order = shuffled(items().length);
  nextRound();
}

function nextRound() {
  clearInterval(gameTimer);
  game.pos++;
  if (game.pos >= game.order.length) {
    game.phase = "over";
    send({ action: "pause" });
    return update();
  }
  game.phase = "playing";
  game.remaining = state.blind.clip;
  play(game.order[game.pos], { randomStart: state.blind.randomStart, clip: state.blind.clip });
}

function startCountdown() {
  clearInterval(gameTimer);
  if (state.blind.clip) {
    gameTimer = setInterval(() => {
      game.remaining--;
      if (game.remaining <= 0) timeUp();
      else update();
    }, 1000);
  }
  update();
}

function timeUp() {
  clearInterval(gameTimer);
  game.remaining = 0;
  game.phase = "timeup";
  send({ action: "pause" });
  update();
}

function reveal() {
  clearInterval(gameTimer);
  game.phase = "revealed";
  send({ action: "play" });
  update();
}

function answer(found) {
  if (found) game.score++;
  game.played++;
  nextRound();
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  resetGame();
  send({ action: "pause" });
  update();
  save();
}

// --- Commandes de la barre latérale ----------------------------------------

const actions = {
  selectPlaylist,
  createPlaylist: (name) => selectPlaylist(newPlaylist(name).id),
  renamePlaylist: (name) => {
    if (playlist()) playlist().name = name;
    update();
    save();
  },
  deletePlaylist,
  addLink,
  removeItem,
  play: (i) => play(i),
  next,
  prev,
  toggle,
  toggleShuffle: () => {
    state.shuffle = !state.shuffle;
    update();
    save();
  },
  setMode,
  startGame,
  nextRound,
  reveal,
  answer,
  setBlind: (key, value) => {
    state.blind[key] = value;
    update();
    save();
  },
  exportPlaylist,
  focusPlayer,
  dismissNotice: () => {
    notice = null;
    update();
  },
};

// --- Démarrage -------------------------------------------------------------

browser.storage.local.get("sidetrack").then((s) => {
  if (s.sidetrack) {
    state = { ...state, ...s.sidetrack, blind: { ...state.blind, ...s.sidetrack.blind } };
  }
  if (!state.playlists.length) newPlaylist("Ma playlist");
  if (!playlist()) state.current = state.playlists[0].id;
  state.index = -1;
  update();
  save();
});

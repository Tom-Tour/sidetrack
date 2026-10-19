// Moteur de Sidetrack : playlists, lecteur et blind test (le salon multijoueur est dans room.js).
// Tourne en arrière-plan pour que la musique continue barre latérale fermée.
// La barre latérale n'est qu'une télécommande reliée par un port.
//
// Le lecteur vit dans un onglet masqué : Firefox n'autorise le son que dans une page
// qui a reçu un clic, ce qui est impossible pour un lecteur caché en arrière-plan.
// L'onglet s'affiche le temps de ce clic, puis disparaît de la barre d'onglets.

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
  // startMode : "start" début du morceau | "random" moment aléatoire | "chapter" chapitre aléatoire
  // clip : secondes d'extrait, 0 = morceau entier, -1 = durée du chapitre
  blind: { clip: 20, startMode: "random", hideVideo: true },
  volume: 100,
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
  return { state, game, playerState, notice, log: logLines, room: roomSnapshot() };
}

// Regroupe les mises à jour (un import de playlist en déclenche des centaines)
function update() {
  if (updateScheduled) return;
  updateScheduled = setTimeout(() => {
    updateScheduled = null;
    const snap = snapshot();
    for (const port of ports) port.postMessage(snap);
    roomUpdate();
  }, 30);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "player") return connectPlayer(port);
  if (port.name !== "sidebar") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async ({ cmd, args = [] }) => {
    // Une erreur dans une commande serait sinon invisible : on la met au journal
    try {
      await actions[cmd]?.(...args);
    } catch (e) {
      log(`✗ Erreur (${cmd}) : ${e.message}`);
      console.error(e);
    }
  });
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

// --- Chapitres --------------------------------------------------------------
// Le lecteur intégré ne donne pas les chapitres : on les lit dans la page de la vidéo
// (ytInitialData). Résultat mis en cache dans l'élément : [{ title, start }] en secondes.

function collectChapters(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectChapters(n, out);
  } else if (node && typeof node === "object") {
    const c = node.chapterRenderer;
    if (c && typeof c.timeRangeStartMillis === "number") {
      out.push({ title: c.title?.simpleText ?? "", start: Math.floor(c.timeRangeStartMillis / 1000) });
    }
    for (const key in node) collectChapters(node[key], out);
  }
}

async function fetchChapters(item) {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${item.id}`);
    const m = (await r.text()).match(/var ytInitialData = (\{.*?\});<\/script>/s);
    const found = [];
    if (m) collectChapters(JSON.parse(m[1]), found);
    const seen = new Set();
    item.chapters = found
      .filter((c) => !seen.has(c.start) && seen.add(c.start))
      .sort((a, b) => a.start - b.start);
  } catch (e) {
    log(`Chapitres illisibles pour « ${item.title} » : ${e.message}`);
    item.chapters = [];
  }
}

async function ensureChapters(list) {
  const missing = list.filter((item) => !Array.isArray(item.chapters));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(fetchChapters));
  }
  if (missing.length) save();
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

// Glisser-déposer dans la file : le morceau en cours reste le même
function moveItem(from, to) {
  const list = items();
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const current = list[state.index];
  list.splice(to, 0, list.splice(from, 1)[0]);
  state.index = current ? list.indexOf(current) : -1;
  update();
  save();
}

async function loadChapters(i) {
  const item = items()[i];
  if (!item) return;
  await ensureChapters([item]);
  update();
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
  // Sans onglet, seul un chargement justifie d'en ouvrir un
  if (cmd.action !== "load" && cmd.action !== "playlist") return;
  queued.push(cmd);
  openPlayerTab();
}

let returnTabId = null;

// Ouvre un onglet neuf pour le lecteur, en fermant un éventuel ancien onglet déconnecté.
// Il passe au premier plan : Firefox ne lance aucun média dans un onglet jamais affiché.
async function openPlayerTab() {
  if (opening) return;
  opening = setTimeout(() => (opening = null), 10000);
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  returnTabId = active?.id ?? null;
  const [tab] = await browser.tabs.query({ url: "https://tom-tour.github.io/sidetrack/player/*" });
  if (tab) await browser.tabs.remove(tab.id);
  // Paramètre anti-cache : GitHub Pages garde les fichiers jusqu'à 10 minutes
  browser.tabs.create({ url: `${PLAYER_URL}?t=${Date.now()}`, active: true });
}

// Revient à l'onglet où l'on naviguait avant l'ouverture du lecteur
// (l'onglet du lecteur se masque alors via onActivated)
async function backToBrowsing() {
  let target = returnTabId;
  returnTabId = null;
  if (target == null) {
    const tabs = await browser.tabs.query({ currentWindow: true, hidden: false });
    target = tabs.find((t) => t.id !== playerTabId)?.id;
  }
  if (target != null) browser.tabs.update(target, { active: true }).catch(() => {});
}

// L'onglet du lecteur n'est visible que tant qu'on est dessus
browser.tabs.onActivated.addListener(({ previousTabId }) => {
  if (previousTabId != null && previousTabId === playerTabId) {
    browser.tabs.hide(playerTabId).catch((e) => log(`Impossible de masquer l'onglet : ${e.message}`));
  }
});

function connectPlayer(port) {
  // Firefox réinjecte le pont dans les onglets déjà ouverts quand l'extension est rechargée :
  // un tel onglet peut n'avoir jamais été affiché ou garder une vieille version de la page.
  // On le ferme : un onglet neuf s'ouvrira au prochain morceau.
  if (!opening) {
    log("Ancien onglet du lecteur fermé");
    browser.tabs.remove(port.sender.tab.id);
    return;
  }
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

// En blind test, la vidéo ne doit pas rester sous les yeux
async function hidePlayerTab() {
  if (playerTabId == null) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === playerTabId) backToBrowsing();
}

// Affiche l'onglet du lecteur ; s'il est déjà affiché et que toggle est vrai, revient à la navigation
async function focusPlayer(toggle = false) {
  // 📺 est inactif en blind test solo ; seul le message « Activer le son » peut y emmener.
  // Dans un salon, l'hôte est l'arbitre : il garde l'accès à la vidéo.
  if (playerTabId == null || !playerPort || (toggle && state.mode === "blind" && !room)) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === playerTabId) {
    if (toggle) backToBrowsing();
    return;
  }
  returnTabId = active?.id ?? null;
  await browser.tabs.show(playerTabId);
  browser.tabs.update(playerTabId, { active: true });
}

function play(i, opts = {}) {
  if (i < 0 || i >= items().length) return;
  state.index = i;
  log(`Lecture : ${items()[i].title}`);
  send({ action: "load", id: items()[i].id, volume: state.volume, ...opts });
  update();
  save();
}

function onPlayerMessage(msg) {
  switch (msg.type) {
    case "ready":
      log("✓ Lecteur prêt");
      break;
    case "log":
      log(msg.text);
      break;
    case "hello":
      log(`Lecture automatique : ${msg.autoplay}`);
      if (msg.autoplay === "allowed") {
        backToBrowsing();
      } else {
        notice = {
          text:
            "Clique sur « Activer le son » dans l'onglet Sidetrack (une fois par session). " +
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
          "Firefox bloque le son tant que tu n'as pas cliqué dans l'onglet Sidetrack. " +
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
    case "tick":
      roomTick(msg);
      break;
    case "state":
      log(`État du lecteur : ${STATE_NAMES[msg.state] ?? msg.state}`);
      playerState = msg.state;
      roomTick(msg, true);
      if (msg.state === 0) onEnded();
      update();
      break;
    case "started":
      if (state.mode === "blind" && game.phase === "playing") {
        // Dernier chapitre en « durée du chapitre » : sa fin dépend de la durée de la vidéo
        if (game.clip == null && game.chapter) {
          game.clip = Math.max(5, Math.floor(msg.duration - game.chapter.start));
          game.remaining = game.clip;
        }
        startCountdown();
      }
      break;
    case "error":
      {
        const item = items()[state.index];
        log(`✗ Erreur YouTube ${msg.code} sur ${item ? `« ${item.title} » (${item.id})` : "aucun morceau"}`);
      }
      if (msg.code === "playlist-empty") {
        notice = {
          text:
            "Impossible de lire cette playlist. Elle est sûrement privée (ou c'est « À regarder plus tard », " +
            "« J'aime » ou un Mix) : le lecteur intégré ne voit pas ton compte YouTube. " +
            "Passe-la en « Non répertoriée » sur YouTube puis réessaie.",
        };
        update();
        break;
      }
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
  if (!items().length) return;
  // Pas encore de morceau, ou onglet du lecteur fermé : on (re)lance le morceau
  if (state.index < 0 || !playerPort) return play(Math.max(0, state.index));
  send({ action: playerState === 1 ? "pause" : "play" });
}

// --- Mode blind test -------------------------------------------------------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// game.order : manches [{ i, chapter? }] ; game.clip : durée de la manche en cours
// (0 = morceau entier, null = inconnue tant que la vidéo n'a pas démarré)
function resetGame() {
  clearInterval(gameTimer);
  game = { phase: "idle", order: [], pos: -1, score: 0, played: 0, remaining: 0, clip: 0, chapter: null };
}

async function startGame() {
  resetGame();
  let rounds = items().map((_, i) => ({ i }));
  if (state.blind.startMode === "chapter") {
    // Une manche par chapitre ; une vidéo sans chapitres reste une seule manche
    game.phase = "loading";
    update();
    const list = items();
    await ensureChapters(list);
    if (game.phase !== "loading" || list !== items()) return; // partie annulée entre-temps
    rounds = list.flatMap((item, i) =>
      item.chapters.length ? item.chapters.map((_, chapter) => ({ i, chapter })) : [{ i }]
    );
    log(`Partie par chapitres : ${rounds.length} manches`);
  }
  game.order = shuffle(rounds);
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
  const { i, chapter } = game.order[game.pos];
  const { clip, startMode } = state.blind;
  const chapters = items()[i].chapters;
  game.phase = "playing";

  if (chapter != null) {
    const start = chapters[chapter].start;
    const end = chapters[chapter + 1]?.start ?? null;
    game.chapter = { title: chapters[chapter].title, start };
    const length = end != null ? end - start : null;
    if (clip === -1) game.clip = length;
    else if (clip && length != null) game.clip = Math.min(clip, length);
    else game.clip = clip;
    play(i, { start });
  } else {
    // « Durée du chapitre » sans chapitre : extrait de 20 s
    game.chapter = null;
    game.clip = clip === -1 ? 20 : clip;
    play(i, { randomStart: startMode !== "start", clip: game.clip });
  }
  game.remaining = game.clip ?? 0;
}

function startCountdown() {
  clearInterval(gameTimer);
  if (game.clip) {
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
  unmaskGuesses();
  send({ action: "play" });
  update();
}

function answer(found) {
  if (found) game.score++;
  game.played++;
  nextRound();
}

// Changer de mode ne coupe pas la musique : seul « Démarrer la partie » lance le blind test.
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  resetGame();
  if (mode === "blind" && !room) hidePlayerTab();
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
  moveItem,
  loadChapters,
  play: (i) => play(i),
  playAt: (i, start) => play(i, { start }),
  seek: (time) => send({ action: "seek", time }),
  // Clic de l'hôte sur une vidéo, un chapitre ou un moment proposé dans le chat :
  // lance la vidéo à cet instant pour tout le salon
  playRef: (ref) => {
    const i = items().findIndex((item) => item.id === ref.id);
    if (i < 0) return log("Cette vidéo n'est plus dans la playlist");
    if (i === state.index && playerPort) send({ action: "seek", time: ref.start ?? 0 });
    else play(i, { start: ref.start ?? 0 });
  },
  // Fonctions de room.js, chargé après ce fichier : on ne les référence qu'à l'appel
  openRoom: () => openRoom(),
  closeRoom: () => closeRoom(),
  joinRoom: (code) => joinRoom(code),
  hostChat: (text) => hostChat(text),
  award: (playerId, delta) => award(playerId, delta),
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
    // « Durée du chapitre » n'a de sens qu'avec un départ par chapitre
    if (key === "startMode" && value !== "chapter" && state.blind.clip === -1) state.blind.clip = 20;
    update();
    save();
  },
  exportPlaylist,
  focusPlayer: () => focusPlayer(false),
  togglePlayerTab: () => focusPlayer(true),
  setVolume: (value) => {
    state.volume = value;
    send({ action: "volume", value });
    update();
    save();
  },
  dismissNotice: () => {
    notice = null;
    update();
  },
};

// --- Démarrage -------------------------------------------------------------

browser.storage.local.get("sidetrack").then((s) => {
  if (s.sidetrack) {
    const blind = { ...state.blind, ...s.sidetrack.blind };
    // Ancien réglage : case « départ aléatoire »
    if ("randomStart" in blind) {
      blind.startMode = blind.randomStart ? "random" : "start";
      delete blind.randomStart;
    }
    state = { ...state, ...s.sidetrack, blind };
  }
  if (!state.playlists.length) newPlaylist("Ma playlist");
  if (!playlist()) state.current = state.playlists[0].id;
  state.index = -1;
  update();
  save();
});

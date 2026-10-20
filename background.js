// Moteur de Sidetrack : playlists, lecteur et blind test (le salon multijoueur est dans room.js,
// la participation au salon de quelqu'un d'autre dans guest.js).
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
  mode: "listen",      // "listen" | "blind" | "emcee" (blind test animé par l'hôte d'un salon)
  // startMode : "start" début du morceau | "random" moment aléatoire | "chapter" chapitre aléatoire
  // clip : secondes d'extrait, 0 = morceau entier, -1 = durée du chapitre
  blind: { clip: -1, startMode: "chapter", hideVideo: true },
  blindDefaults: 2,    // version des réglages par défaut du blind test (voir le démarrage)
  volume: 100,
  lang: "auto",        // "auto" | "fr" | "en"
  showMulti: true,     // bouton 🌐 du salon (désactivable dans les réglages pour un usage solo)
  chatSound: false,    // petit son à chaque nouveau message du salon
  nickname: "",        // pseudo dans les salons des autres
  hideTab: true,       // ranger l'onglet du lecteur hors de la barre d'onglets (tabs.hide)
  banned: {},          // identité (clé publique) → dernier nom connu : refusés dans nos salons
};

let playerState = -1;  // -1 non démarré, 0 fini, 1 lecture, 2 pause, 5 prête
let loadingSince = 0;  // vidéo demandée au lecteur, pas encore démarrée (indicateur de chargement)
let playerShown = false; // onglet du lecteur affiché (bouton 📺 allumé)
let importTarget = null;
let notice = null;     // { key, args?, focus? } : traduit par la barre latérale
let logLines = [];

// Blind test, joué (« blind ») ou animé par l'hôte d'un salon (« emcee ») : même partie,
// mais l'animateur voit tout (titres, vidéo, propositions) et ne joue pas
function inGame() {
  return state.mode === "blind" || state.mode === "emcee";
}

function emcee() {
  return state.mode === "emcee" && !!room;
}

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
  const loading = !!loadingSince && Date.now() - loadingSince < LOADING_MAX;
  return {
    state, game, playerState, loading, playerShown, notice, log: logLines,
    room: roomSnapshot(), guest: guestSnapshot(), rooms: publicRoomsSnapshot(),
  };
}

// Regroupe les mises à jour (un import de playlist en déclenche des centaines)
function update() {
  if (updateScheduled) return;
  updateScheduled = setTimeout(() => {
    updateScheduled = null;
    const snap = snapshot();
    for (const port of ports) port.postMessage(snap);
    roomUpdate();
    syncCover();
  }, 30);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "player") return connectPlayer(port);
  if (port.name !== "sidebar") return;
  ports.add(port);
  // Panneau ouvert : l'onglet du lecteur doit exister. Il se prépare tout de suite (écran
  // « Lancer Sidetrack » si Firefox exige un clic), avant même la première vidéo
  warmPlayer();
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async ({ cmd, args = [] }) => {
    // Une erreur dans une commande serait sinon invisible : on la met au journal
    try {
      await actions[cmd]?.(...args);
    } catch (e) {
      log(t("logCommandError", cmd, e.message));
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
  selectPlaylist((state.playlists[0] ?? newPlaylist(t("defaultPlaylist"))).id);
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
    item.title = r.ok ? (await r.json()).title : t("unavailable", item.id);
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
    log(t("logChaptersError", item.title, e.message));
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
    log(t("logImporting", list));
    send({ action: "playlist", list });
  } else if (id) {
    addItems(p, [id]);
    if (state.mode === "listen" && (state.index < 0 || playerState === 0)) play(p.items.length - 1);
  } else {
    log(t("logBadLink"));
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
    notice = { key: "noticeExportEmpty" };
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
  notice = parts > 1 ? { key: "noticeExportedParts", args: [parts] } : { key: "noticeExported" };
  log(t("logExport", ids.length, parts));
}

// --- Lecteur ---------------------------------------------------------------

const STATE_NAMES = { "-1": "stateUnstarted", 0: "stateEnded", 1: "statePlaying", 2: "statePaused", 3: "stateBuffering", 5: "stateCued" };

let playerPort = null;
let playerTabId = null;
let queued = [];
let opening = null;

const LOADING_MAX = 30000; // au-delà, l'indicateur de chargement s'efface de lui-même

function send(cmd) {
  if (cmd.action === "load") {
    loadingSince = Date.now();
    setTimeout(update, LOADING_MAX + 100);
    syncCover(); // cache posé avant que la vidéo n'apparaisse
  }
  if (playerPort) return playerPort.postMessage(cmd);
  // Sans onglet, seul un chargement justifie d'en ouvrir un
  if (cmd.action !== "load" && cmd.action !== "playlist") return;
  queued.push(cmd);
  openPlayerTab();
}

let returnTabId = null;
let warmup = false;      // onglet ouvert d'avance, sans vidéo : on revient dès qu'il est prêt
let coverShown = null;   // dernier état du cache envoyé à la page du lecteur
let returnAfterStart = null; // retour à la navigation différé jusqu'au démarrage de la vidéo

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
browser.tabs.onActivated.addListener(({ tabId, previousTabId }) => {
  const shown = tabId === playerTabId;
  if (shown !== playerShown) {
    playerShown = shown;
    update();
  }
  if (state.hideTab && previousTabId != null && previousTabId === playerTabId) {
    browser.tabs.hide(playerTabId).catch((e) => log(t("logHideError", e.message)));
  }
});

function connectPlayer(port) {
  // Firefox réinjecte le pont dans les onglets déjà ouverts quand l'extension est rechargée :
  // un tel onglet peut n'avoir jamais été affiché ou garder une vieille version de la page.
  // On le ferme : un onglet neuf s'ouvrira au prochain morceau.
  if (!opening) {
    log(t("logStaleTab"));
    browser.tabs.remove(port.sender.tab.id);
    return;
  }
  clearTimeout(opening);
  opening = null;
  playerPort = port;
  playerTabId = port.sender.tab.id;
  playerShown = !!port.sender.tab.active;
  coverShown = null; // page neuve : on lui redit tout de suite s'il faut cacher la vidéo
  syncCover();
  port.onMessage.addListener(onPlayerMessage);
  port.onDisconnect.addListener(() => {
    if (playerPort !== port) return;
    playerPort = null;
    playerState = -1;
    loadingSince = 0;
    playerShown = false;
    log(t("logTabClosed"));
    update();
    // Invité d'un salon : l'onglet est indispensable, on le rouvre et on reprend où en est l'hôte.
    // Sinon, panneau ouvert : on le rouvre aussi, sur l'écran du début
    if (inGuestRoom()) setTimeout(guestPlayerLost, 500);
    else if (ports.size) setTimeout(warmPlayer, 500);
  });
  for (const cmd of queued) port.postMessage(cmd);
  queued = [];
}

// Réglage changé : l'onglet du lecteur réapparaît dans la barre, ou s'y range s'il n'est pas affiché
async function applyHideTab() {
  if (playerTabId == null) return;
  if (!state.hideTab) return browser.tabs.show(playerTabId).catch(() => {});
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== playerTabId) browser.tabs.hide(playerTabId).catch((e) => log(t("logHideError", e.message)));
}

// Ouvre l'onglet du lecteur d'avance, sans vidéo. Firefox ne lit les médias que dans un
// onglet passé au moins une fois au premier plan : mieux vaut le faire avant la partie
// qu'au début d'une manche. On revient à la navigation dès que le lecteur est prêt.
function warmPlayer() {
  if (playerPort || opening) return;
  warmup = true;
  openPlayerTab();
}

// Cache sur la vidéo, dans la page du lecteur : en blind test, rien n'est dévoilé même si
// l'onglet s'affiche (premier chargement, clic sur « Lancer Sidetrack », nouvel essai…)
function videoHidden() {
  if (inGuestRoom()) return guestHidesVideo();
  return state.mode === "blind" && state.blind.hideVideo && game.phase !== "revealed";
}

function syncCover() {
  if (!playerPort) return;
  const on = videoHidden();
  if (on === coverShown) return;
  coverShown = on;
  playerPort.postMessage({ action: "cover", on });
}

// En blind test, la vidéo ne doit pas rester sous les yeux
async function hidePlayerTab() {
  if (playerTabId == null) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === playerTabId) backToBrowsing();
}

// Affiche l'onglet du lecteur ; s'il est déjà affiché et que toggle est vrai, revient à la navigation
async function focusPlayer(toggle = false) {
  // 📺 est inactif en blind test solo ; seul l'écran « Lancer Sidetrack » peut y emmener.
  // Dans un salon, l'hôte est l'arbitre : il garde l'accès à la vidéo ; un invité la voit
  // quand l'hôte ne la cache pas.
  const hidden = inGuestRoom() ? guestHidesVideo() : state.mode === "blind";
  if (playerTabId == null || !playerPort || (toggle && hidden)) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === playerTabId) {
    if (toggle) backToBrowsing();
    return;
  }
  returnTabId = active?.id ?? null;
  await browser.tabs.show(playerTabId);
  browser.tabs.update(playerTabId, { active: true });
}

let lastPlay = null;      // { i, opts } : dernier morceau lancé, rejoué si YouTube échoue
let retriedVisible = false; // reprise déjà tentée onglet affiché, depuis le dernier départ réussi

function play(i, opts = {}) {
  // Invité d'un salon : c'est l'hôte qui choisit la musique
  if (inGuestRoom() || i < 0 || i >= items().length) return;
  state.index = i;
  lastPlay = { i, opts };
  log(t("logPlaying", items()[i].title));
  send({ action: "load", id: items()[i].id, volume: state.volume, ...opts });
  update();
  save();
}

function onPlayerMessage(msg) {
  switch (msg.type) {
    case "ready":
      log(t("logReady"));
      if (warmup) {
        warmup = false;
        if (returnAfterStart && !loadingSince) {
          clearTimeout(returnAfterStart);
          returnAfterStart = setTimeout(() => {
            returnAfterStart = null;
            backToBrowsing();
          }, 1000);
        }
      }
      break;
    case "log":
      log(msg.key ? t(msg.key) : String(msg.text ?? "")); // texte brut : ancienne page du lecteur en cache
      break;
    case "hello":
      log(t("logAutoplay", msg.autoplay));
      if (msg.autoplay === "allowed") {
        // On reste sur l'onglet le temps que la vidéo démarre : masquer l'onglet pendant
        // le tout premier chargement semble parfois faire échouer YouTube
        clearTimeout(returnAfterStart);
        returnAfterStart = setTimeout(() => {
          returnAfterStart = null;
          backToBrowsing();
        }, 6000);
      } else {
        notice = { key: "noticeUnlock", focus: true };
        update();
      }
      break;
    case "blocked":
      loadingSince = 0;
      // On reste sur l'onglet : c'est là qu'il faut cliquer
      clearTimeout(returnAfterStart);
      returnAfterStart = null;
      log(t("logBlocked"));
      notice = { key: "noticeBlocked", focus: true };
      update();
      break;
    case "unblocked":
      notice = null;
      backToBrowsing();
      update();
      break;
    case "tick":
      roomTick(msg);
      guestTick(msg);
      break;
    case "state":
      log(t("logState", STATE_NAMES[msg.state] ? t(STATE_NAMES[msg.state]) : msg.state));
      playerState = msg.state;
      roomTick(msg, true);
      guestTick(msg);
      if (msg.state === 0 && !inGuestRoom()) onEnded();
      update();
      break;
    case "started":
      retriedVisible = false;
      loadingSince = 0;
      update();
      // Le son revient juste au démarrage, et Firefox peut encore couper la lecture pendant
      // ~2 s : on reste sur l'onglet le temps que le départ soit acquis.
      if (returnAfterStart) {
        clearTimeout(returnAfterStart);
        returnAfterStart = setTimeout(() => {
          returnAfterStart = null;
          backToBrowsing();
        }, 2500);
      }
      if (inGame() && game.phase === "playing") {
        // Dernier chapitre en « durée du chapitre » : sa fin dépend de la durée de la vidéo
        if (game.clip == null && game.chapter) {
          game.clip = Math.max(5, Math.floor(msg.duration - game.chapter.start));
          game.remaining = game.clip;
        }
        startCountdown();
      }
      break;
    case "error":
      loadingSince = 0;
      update();
      {
        const item = items()[state.index];
        log(t("logYoutubeError", msg.code, item ? `« ${item.title} » (${item.id})` : t("logNoTrack")));
      }
      if (msg.code === "playlist-empty") {
        notice = { key: "noticePrivatePlaylist" };
        update();
        break;
      }
      // YouTube refuse parfois de démarrer dans l'onglet masqué (« Une erreur s'est produite ») :
      // on l'affiche et on relance, comme le ferait un clic sur 📺
      if (retryVisible(msg.code)) {
        if (inGuestRoom()) guestRetry();
        else if (lastPlay) play(lastPlay.i, lastPlay.opts);
        break;
      }
      if (inGuestRoom()) break; // la suite dépend de l'hôte
      if (inGame()) setTimeout(nextRound, 1000);
      else setTimeout(next, 1500);
      break;
    case "playlist": {
      const p = playlist(importTarget) ?? playlist();
      log(t("logImported", msg.ids.length));
      const start = p.items.length;
      addItems(p, msg.ids);
      if (state.mode === "listen" && p.id === state.current) play(start);
      save();
      break;
    }
  }
}

// Erreurs définitives (vidéo supprimée, privée, intégration interdite) : rien à retenter
const PERMANENT_ERRORS = [100, 101, 150, 153];

function retryVisible(code) {
  if (retriedVisible || PERMANENT_ERRORS.includes(Number(code)) || playerTabId == null) return false;
  retriedVisible = true;
  log(t("logRetryVisible"));
  showForRetry();
  return true;
}

async function showForRetry() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== playerTabId) {
    returnTabId = active?.id ?? null;
    await browser.tabs.show(playerTabId).catch(() => {});
    browser.tabs.update(playerTabId, { active: true }).catch(() => {});
  }
  // Retour à la navigation après le départ (voir « started »), ou au plus tard dans 15 s
  clearTimeout(returnAfterStart);
  returnAfterStart = setTimeout(() => {
    returnAfterStart = null;
    backToBrowsing();
  }, 15000);
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
    log(t("logChapterGame", rounds.length));
  }
  game.order = shuffle(rounds);
  nextRound();
}

// L'hôte choisit la prochaine manche (une piste, ou un chapitre) : elle part tout de suite.
// Sans partie en cours, on en commence une faite des manches choisies à la main.
async function blindPick(i, chapter = null) {
  const item = items()[i];
  if (!item || !inGame() || game.phase === "loading") return;
  if (chapter != null) {
    await ensureChapters([item]);
    if (!item.chapters?.[chapter]) return;
  }
  if (game.phase === "idle" || game.phase === "over") resetGame();
  const same = (r) => r.i === i && (r.chapter ?? null) === chapter;
  // Si cette manche était prévue plus loin, on la retire pour ne pas la rejouer
  const later = game.order.findIndex((r, k) => k > game.pos && same(r));
  if (later >= 0) game.order.splice(later, 1);
  game.order.splice(game.pos + 1, 0, chapter == null ? { i } : { i, chapter });
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
  if (state.mode === mode || (mode === "emcee" && !room)) return;
  const wasGame = inGame();
  state.mode = mode;
  // Passer du blind test joué au blind test animé garde la partie en cours
  if (!(wasGame && inGame())) resetGame();
  if (mode === "blind") hidePlayerTab(); // on joue : la vidéo ne doit pas rester sous les yeux
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
    if (i < 0) return log(t("logNotInPlaylist"));
    if (i === state.index && playerPort) send({ action: "seek", time: ref.start ?? 0 });
    else play(i, { start: ref.start ?? 0 });
  },
  // Fonctions de room.js, chargé après ce fichier : on ne les référence qu'à l'appel
  openRoom: (options) => openRoom(options),
  refreshPublicRooms: () => refreshPublicRooms(),
  closeRoom: () => closeRoom(),
  joinRoom: (code) => joinRoom(code),
  leaveRoom: () => leaveRoom(),
  guestChat: (text, secret) => guestChat(text, secret),
  guestRef: (ref) => guestRef(ref),
  shareMoment: () => shareMoment(),
  hostChat: (text, secret) => hostChat(text, null, secret),
  award: (playerId, delta) => award(playerId, delta),
  kick: (playerId) => kick(playerId, false),
  ban: (playerId) => kick(playerId, true),
  unban: (playerId) => {
    delete state.banned[playerId];
    update();
    save();
  },
  next,
  prev,
  toggle,
  // Blind test : lecture ou pause du morceau de la manche, sans toucher à la partie
  playPause: () => send({ action: playerState === 1 ? "pause" : "play" }),
  toggleShuffle: () => {
    state.shuffle = !state.shuffle;
    update();
    save();
  },
  setMode,
  startGame,
  nextRound,
  blindPick,
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
  setSetting: (key, value) => {
    if (!["lang", "showMulti", "chatSound", "nickname", "hideTab"].includes(key)) return;
    state[key] = key === "nickname" ? cleanText(value, 24) : value;
    if (key === "hideTab") applyHideTab();
    if (key === "lang") setLang(value);
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
    // Réglages par défaut du blind test passés aux chapitres (départ et durée), une fois
    if ((s.sidetrack.blindDefaults ?? 1) < 2) {
      state.blind.startMode = "chapter";
      state.blind.clip = -1;
      state.blindDefaults = 2;
    }
  }
  if (!state.banned || typeof state.banned !== "object") state.banned = {};
  if (state.mode === "emcee") state.mode = "blind"; // pas de salon au démarrage
  setLang(state.lang);
  if (!state.playlists.length) newPlaylist(t("defaultPlaylist"));
  if (!playlist()) state.current = state.playlists[0].id;
  state.index = -1;
  update();
  save();
});

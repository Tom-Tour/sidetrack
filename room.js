// Salon multijoueur : l'extension est l'hôte, les invités se connectent en pair-à-pair
// (PeerJS ; son serveur public ne sert qu'à mettre les navigateurs en relation).
// Les invités utilisent la page join/ sur GitHub Pages, sans rien installer, ou leur
// propre extension (guest.js).
//
// L'hôte choisit les vidéos et arbitre : en blind test, les propositions tapées dans le
// chat ne sont visibles que de lui pendant la manche, et c'est lui qui donne les points.
//
// Sécurité (mêmes principes que Pagemates) :
// - chaque invité a une identité (clé Nostr gardée dans son navigateur) et signe le défi
//   aléatoire envoyé par l'hôte : impossible de se faire passer pour un autre ou de rejouer
//   une connexion ; exclure ou bannir vise cette identité ;
// - dans un salon public, une identité coûte une preuve de travail (pow-worker.js, quelques
//   secondes une seule fois) : un banni ne revient pas avec des milliers de nouvelles identités ;
// - débit fixe et identique pour tous : au-delà, les messages sont ignorés, et qui insiste
//   est mis en sourdine une minute ; tout ce qui arrive des invités est nettoyé ;
// - 24 joueurs au plus.
//
// Un salon public est en plus annoncé sur des relais Nostr publics (nostr-tools), d'où
// la liste des salons disponibles. Annonces signées avec une clé jetable par salon,
// renouvelées chaque minute et expirant d'elles-mêmes.

const JOIN_URL = "https://tom-tour.github.io/sidetrack/join/";
const ROOM_PREFIX = "sidetrack-room-";
const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const CHAT_LIMIT = 200;
const TEXT_MAX = 300;
const MAX_PLAYERS = 24;
const HELLO_KIND = 27235; // éphémère : jamais publié, sert seulement à signer la poignée de main
const POW_BITS = 7;       // bits à zéro exigés dans un salon public : ~128 essais de scrypt
// Temps laissé à un invité pour se présenter (sa preuve de travail est calculée avant)
const HELLO_TIMEOUT_PUBLIC = 30 * 1000;
const HELLO_TIMEOUT_PRIVATE = 20 * 1000;

// Anti-flood : la réception tolère un peu plus que ce que la page invité envoie au plus,
// si bien qu'un invité normal n'est jamais filtré.
const HOST_SEND_PER_SECOND = 2;
const RECV_PER_SECOND = 3; // messages de chat acceptés, par joueur
const META_PER_SECOND = 4; // autres messages (ping…)
const FLOOD_DROPS = 30;    // messages ignorés en 10 s avant la sourdine
const FLOOD_MUTE = 60 * 1000;
// WebRTC ne signale pas toujours une connexion perdue (onglet fermé, extension rechargée,
// réseau coupé) : un invité qui ne donne plus signe de vie (ping toutes les 5 s) est retiré,
// sinon il resterait en fantôme et réapparaîtrait en double à son retour.
const GHOST_TIMEOUT = 30 * 1000;

// Couleurs des joueurs, lisibles sur fond clair comme sombre
const PALETTE = ["#e5484d", "#f76b15", "#d5a000", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8e4ec6", "#ab6400"];

// { code, link, status, public, peer, players: Map(pubkey → joueur), pending: Map(conn → {…}),
//   kicked: Set(pubkey), chat: [] }
let room = null;
let chatSeq = 0;
let lastPublic = "";
let lastSync = null;
const hostTimes = [];

function makeCode() {
  return Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
}

// Nom de salon = identifiant pour le rejoindre : minuscules, sans accents, espaces → tirets
function roomName(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}
const ROOM_NAME = /^[a-z0-9_-]{3,24}$/;

// Compteur glissant sur une seconde
function rateOk(times, limit, now = Date.now()) {
  while (times.length && now - times[0] >= 1000) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

function safeSend(conn, msg) {
  try {
    if (conn?.open) conn.send(msg);
  } catch {
    // connexion en train de tomber : le « close » suivra
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function openRoom({ isPublic = false, name = "" } = {}) {
  if (room || inGuestRoom()) return;
  log(
    t(
      "logRoomDiag",
      typeof Peer === "function" ? t("loaded") : t("missing"),
      typeof RTCPeerConnection === "function" ? t("available") : t("missing")
    )
  );
  const chosen = roomName(name);
  if (chosen && !ROOM_NAME.test(chosen)) {
    notice = { key: "noticeNameShort" };
    return update();
  }
  const code = chosen || makeCode();
  const peer = new Peer(ROOM_PREFIX + code);
  room = {
    code,
    link: `${JOIN_URL}#${code}`,
    status: "opening",
    public: isPublic,
    peer,
    players: new Map(),
    pending: new Map(),
    kicked: new Set(),
    chat: [],
    sweep: setInterval(sweepGhosts, 5000),
  };
  lastPublic = "";

  peer.on("open", () => {
    room.status = "open";
    log(t(room.public ? "logRoomOpenPublic" : "logRoomOpen", code));
    if (room.public) startAnnouncing();
    update();
  });
  peer.on("connection", acceptConnection);
  peer.on("disconnected", () => {
    if (room?.peer === peer) peer.reconnect();
  });
  peer.on("error", (e) => {
    if (room?.peer !== peer) return;
    if (e.type === "unavailable-id") {
      // Nom déjà pris : ce salon existe, on le rejoint (même champ pour créer ou rejoindre)
      peer.destroy();
      clearInterval(room.sweep);
      room = null;
      log(t("logJoinExisting", code));
      update();
      return joinRoom(code);
    }
    log(t("logRoomError", e.type));
    if (["network", "server-error", "socket-error", "browser-incompatible"].includes(e.type)) {
      room.status = "error";
      update();
    }
  });
  update();
}

function closeRoom() {
  if (!room) return;
  if (room.public) stopAnnouncing();
  broadcast({ t: "closed" });
  clearInterval(room.sweep);
  if (state.mode === "emcee") state.mode = "blind"; // l'animation n'existe que dans un salon
  const { peer } = room;
  room = null;
  setTimeout(() => peer.destroy(), 300); // laisse partir le message de fermeture
  log(t("logRoomClosed"));
  update();
}

function broadcast(msg, except = null) {
  if (!room) return;
  for (const p of room.players.values()) {
    if (p.id !== except) safeSend(p.conn, msg);
  }
}

// --- Preuve de travail ---------------------------------------------------------

let powVerifier = null;
let powSeq = 0;
const powWaiting = new Map();
const powOk = new Map(); // pubkey → nonce déjà vérifié

// Nombre de bits à zéro de la preuve d'une identité (calcul dans un worker)
function powBits(pubkey, nonce) {
  if (powOk.get(pubkey) === nonce) return Promise.resolve(POW_BITS);
  if (!powVerifier) {
    powVerifier = new Worker("pow-worker.js");
    powVerifier.onmessage = ({ data }) => {
      powWaiting.get(data.req)?.(data.bits);
      powWaiting.delete(data.req);
    };
  }
  const req = ++powSeq;
  powVerifier.postMessage({ t: "verify", req, pubkey, nonce });
  return new Promise((resolve) => powWaiting.set(req, resolve));
}

// --- Arrivée d'un invité : défi signé, puis admission ----------------------------

function acceptConnection(conn) {
  if (!room) return;
  if (room.players.size + room.pending.size >= MAX_PLAYERS) {
    conn.on("open", () => {
      safeSend(conn, { t: "full" });
      setTimeout(() => conn.close(), 300);
    });
    return;
  }
  const entry = {
    challenge: hex(crypto.getRandomValues(new Uint8Array(16))),
    checking: false,
    timer: setTimeout(() => conn.close(), room.public ? HELLO_TIMEOUT_PUBLIC : HELLO_TIMEOUT_PRIVATE),
  };
  room.pending.set(conn, entry);
  conn.on("open", () => {
    safeSend(conn, { t: "challenge", c: entry.challenge, room: room?.code, pow: room?.public ? POW_BITS : 0 });
  });
  conn.on("data", (msg) => onConnData(conn, msg));
  conn.on("close", () => dropConn(conn));
  conn.on("error", () => dropConn(conn));
}

// Poignée de main valide : signée par l'identité, pour ce salon et ce défi, récente
function verifyHello(entry, msg) {
  const ev = msg?.ev;
  if (!ev || typeof ev !== "object" || ev.kind !== HELLO_KIND || !/^[0-9a-f]{64}$/.test(ev.pubkey ?? "")) return null;
  try {
    if (!NostrTools.verifyEvent(ev)) return null;
  } catch {
    return null; // événement mal formé
  }
  const tag = (k) => (Array.isArray(ev.tags) ? ev.tags.find((x) => Array.isArray(x) && x[0] === k)?.[1] : undefined);
  if (tag("room") !== room.code || tag("challenge") !== entry.challenge) return null;
  if (Math.abs(nowSeconds() - ev.created_at) > 600) return null;
  return { id: ev.pubkey, nonce: Number(tag("pow")) };
}

function onConnData(conn, msg) {
  if (!room || !msg || typeof msg !== "object") return;
  const entry = room.pending.get(conn);
  if (entry) {
    if (msg.t !== "hello" || entry.checking) return;
    const hello = verifyHello(entry, msg);
    if (!hello) return conn.close();
    if (state.banned[hello.id] || room.kicked.has(hello.id)) {
      safeSend(conn, { t: state.banned[hello.id] ? "banned" : "kicked" });
      return setTimeout(() => conn.close(), 300);
    }
    if (!room.public) return admit(conn, entry, hello.id, msg.name);
    if (!Number.isSafeInteger(hello.nonce) || hello.nonce < 0) return conn.close();
    entry.checking = true;
    powBits(hello.id, hello.nonce).then((bits) => {
      if (bits < POW_BITS) return conn.close();
      powOk.set(hello.id, hello.nonce);
      if (room?.pending.get(conn) === entry && conn.open) admit(conn, entry, hello.id, msg.name);
    });
    return;
  }
  const player = [...room.players.values()].find((p) => p.conn === conn);
  if (!player) return;
  player.lastSeen = Date.now();
  onPlayerData(player, msg);
}

function sweepGhosts() {
  if (!room) return;
  const now = Date.now();
  for (const p of room.players.values()) {
    if (now - p.lastSeen < GHOST_TIMEOUT) continue;
    room.players.delete(p.id);
    p.removed = true;
    try {
      p.conn.close();
    } catch {}
    systemMessage("chatLeft", p.name);
  }
}

// Texte venu d'un invité : sans caractères de contrôle, espaces resserrés, longueur bornée
function cleanText(text, max) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Noms uniques dans le salon (et jamais celui de l'hôte) : « Alex », « Alex 2 »…
function uniqueName(name, id) {
  const taken = new Set(["hôte", "host", ...[...room.players.values()].filter((p) => p.id !== id).map((p) => p.name.toLowerCase())]);
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}

// Couleur stable pour une identité
function colorFor(id) {
  return PALETTE[parseInt(id.slice(0, 8), 16) % PALETTE.length];
}

function admit(conn, entry, id, rawName) {
  clearTimeout(entry.timer);
  room.pending.delete(conn);
  // Même identité déjà là (reconnexion, autre onglet) : la nouvelle connexion remplace l'ancienne
  const old = room.players.get(id);
  if (old) {
    old.replaced = true;
    old.conn.close();
  }
  const player = {
    id,
    conn,
    name: uniqueName(cleanText(rawName, 24) || t("defaultGuest"), id),
    color: colorFor(id),
    score: old?.score ?? 0,
    chatTimes: [],
    metaTimes: [],
    lastSeen: Date.now(),
    drops: [],
    mutedUntil: 0,
  };
  room.players.set(id, player);
  safeSend(conn, { t: "welcome", code: room.code, you: id, name: player.name, chat: room.chat.map(publicChat) });
  safeSend(conn, publicState());
  if (lastSync) safeSend(conn, lastSync);
  if (!old) systemMessage("chatJoined", player.name);
  else update();
}

function dropConn(conn) {
  if (!room) return;
  const entry = room.pending.get(conn);
  if (entry) {
    clearTimeout(entry.timer);
    room.pending.delete(conn);
  }
  for (const p of room.players.values()) {
    if (p.conn !== conn) continue;
    room.players.delete(p.id);
    if (!p.replaced && !p.removed) systemMessage("chatLeft", p.name);
    update();
  }
}

function onPlayerData(p, msg) {
  const now = Date.now();
  if (p.mutedUntil > now) return;
  const chatty = msg.t === "chat";
  if (!rateOk(chatty ? p.chatTimes : p.metaTimes, chatty ? RECV_PER_SECOND : META_PER_SECOND, now)) return flooded(p, now);

  switch (msg.t) {
    case "chat":
      addChat({ from: p.id, name: p.name, color: p.color, text: cleanText(msg.text, TEXT_MAX), ref: cleanRef(msg.ref), secret: msg.secret !== false });
      break;
    case "claim":
      claim(p.id, msg.found === true);
      break;
    case "ping":
      safeSend(p.conn, { t: "pong", at: Number(msg.at) || 0 });
      break;
    case "bye":
      p.conn.close();
      break;
  }
}

function flooded(p, now) {
  p.drops.push(now);
  while (p.drops.length && now - p.drops[0] > 10000) p.drops.shift();
  if (p.drops.length < FLOOD_DROPS) return;
  p.drops = [];
  p.mutedUntil = now + FLOOD_MUTE;
  safeSend(p.conn, { t: "muted", ms: FLOOD_MUTE });
  systemMessage("chatFlood", p.name);
}

// Exclure : jusqu'à la fermeture du salon. Bannir : pour de bon (liste dans les réglages).
function kick(id, permanent = false) {
  const p = room?.players.get(id);
  if (!p) return;
  room.kicked.add(id);
  if (permanent) {
    state.banned[id] = p.name;
    save();
  }
  p.removed = true;
  safeSend(p.conn, { t: permanent ? "banned" : "kicked" });
  setTimeout(() => p.conn.close(), 300);
  systemMessage(permanent ? "chatBanned" : "chatKicked", p.name);
}

// Référence envoyée par un invité : une vidéo de la playlist, un chapitre ou un moment
function cleanRef(ref) {
  if (!ref || typeof ref !== "object" || typeof ref.id !== "string" || !/^[\w-]{11}$/.test(ref.id)) return null;
  const start = Number(ref.start);
  return {
    id: ref.id,
    start: Number.isFinite(start) && start >= 0 && start < 360000 ? Math.floor(start) : 0,
    label: cleanText(ref.label, 120),
  };
}

// --- Aide à l'arbitrage ---------------------------------------------------------
// Une proposition qui ressemble au titre du morceau (ou du chapitre) est marquée
// « probable » chez l'hôte. Il reste seul juge : c'est lui qui donne les points.

const NOISE = /\b(official|officiel(le)?|video|clip|lyrics?|paroles|audio|hd|4k|mv|music|musique|full|version|remaster(ed)?|feat|ft|prod)\b/g;

function simplify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// Les morceaux d'un titre : « Chainsaw Man — Kick Back » → « chainsaw man », « kick back »…
function answerParts(...titles) {
  const parts = new Set();
  for (const title of titles) {
    if (!title) continue;
    parts.add(simplify(title));
    // Séparateurs : « - », « — », « | », « · », « / », « : » (même collé au mot d'avant), guillemets
    for (const piece of String(title).split(/\s[-–—]\s|\s*[|·/:]\s+|["“”«»]/)) {
      const s = simplify(piece);
      if (s.length >= 2) parts.add(s);
    }
  }
  parts.delete("");
  return [...parts];
}

function looksRight(guess, parts) {
  const g = simplify(guess);
  if (g.length < 3) return false;
  const gWords = new Set(g.split(" ").filter((w) => w.length >= 2));
  return parts.some((part) => {
    if (similarity(g, part) >= 0.8) return true;
    if (g.length >= 4 && part.includes(g) && g.length >= part.length * 0.5) return true;
    // La plupart des mots d'un morceau du titre sont dans la proposition
    const words = part.split(" ").filter((w) => w.length >= 2);
    const found = words.filter((w) => gWords.has(w) || [...gWords].some((x) => x.length >= 4 && similarity(x, w) >= 0.8));
    return words.length > 0 && found.length >= Math.max(1, Math.ceil(words.length * 0.6));
  });
}

// Points d'une proposition, de 0 à 10. 10 si elle est reconnue comme juste (mêmes règles que
// « probable »), sinon des points partiels dès 4 lettres consécutives en commun avec un morceau
// du titre (« never gonna » → 5 sur « Never Gonna Give You Up »), ou des mots du titre retrouvés.
const GUESSES_PER_ROUND = 3; // seules les 3 premières réponses comptent : pas de pêche au hasard

function commonRun(a, b) {
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) best = Math.max(best, (cur[j] = prev[j - 1] + 1));
    }
    prev = cur;
  }
  return best;
}

function guessPoints(guess, parts) {
  if (looksRight(guess, parts)) return 10;
  const g = simplify(guess);
  const letters = g.replace(/ /g, "");
  if (letters.length < 4) return 0;
  const gWords = new Set(g.split(" ").filter((w) => w.length >= 3));
  let best = 0;
  for (const part of parts) {
    const target = part.replace(/ /g, "");
    const run = commonRun(letters, target);
    let pts = run >= 4 ? Math.round((9 * run) / target.length) : 0;
    const words = part.split(" ").filter((w) => w.length >= 3);
    const found = words.filter((w) => gWords.has(w)).length;
    if (found) pts = Math.max(pts, Math.round((9 * found) / words.length));
    if (run >= 4 || found) best = Math.max(best, Math.min(9, Math.max(1, pts)));
  }
  return best;
}

// Morceaux de la réponse de la manche en cours (titre du chapitre, ou de la vidéo)
function roundParts() {
  const item = items()[state.index];
  return item ? answerParts(game.chapter?.title, game.chapter ? null : item.title) : null;
}

// Blind test solo, points à l'écrit : la meilleure de nos réponses de la manche
function soloPoints() {
  const parts = roundParts();
  if (!parts) return 0;
  return Math.max(0, ...game.guesses.slice(0, GUESSES_PER_ROUND).map((g) => guessPoints(g, parts)));
}

function guessHint(text) {
  if (!inGame() || !["playing", "timeup", "revealed"].includes(game.phase) || !text) return false;
  const item = items()[state.index];
  if (!item) return false;
  return looksRight(text, answerParts(game.chapter?.title, game.chapter ? null : item.title));
}

// --- Chat ------------------------------------------------------------------

// Pendant une manche de blind test, les propositions restent cachées jusqu'à la révélation :
// à tous sauf l'animateur, ou à tout le monde si l'hôte joue lui aussi. Chacun peut choisir
// d'écrire en clair (secret: false) pour discuter.
function guessing() {
  return inGame() && (game.phase === "playing" || game.phase === "timeup");
}

function addChat({ secret = true, ...entry }) {
  if (!entry.text && !entry.ref && !entry.system) return;
  const fromGuest = !entry.system && entry.from !== "host";
  const player = fromGuest || (entry.from === "host" && state.mode === "blind"); // l'hôte joue
  const msg = {
    ...entry,
    id: ++chatSeq,
    at: Date.now(),
    private: player && secret && guessing(),
    // Réponse cachée de cette manche (points à l'écrit) ; un message en clair n'est que du chat
    round: player && secret && guessing() ? game.pos : null,
    hint: fromGuest && guessHint(entry.text), // jamais envoyé aux invités
  };
  room.chat.push(msg);
  if (room.chat.length > CHAT_LIMIT) room.chat.shift();
  broadcast({ t: "chat", msg: publicChat(msg) });
  update();
}

// Ce que voient les invités : jamais l'indice d'arbitrage, et rien d'une proposition masquée
function publicChat(msg) {
  const { id, at, from, name, color, system, key, args, ref } = msg;
  if (msg.private) return { id, at, from, name, color, masked: true };
  return { id, at, from, name, color, system, key, args, text: msg.text, ref };
}

// Message système : envoyé comme clé de traduction, chacun le lit dans sa langue
function systemMessage(key, ...args) {
  if (room) addChat({ system: true, key, args });
}

// Le nom « Hôte » est traduit à l'affichage (from === "host")
function hostChat(text, ref = null, secret = true) {
  if (!room || !rateOk(hostTimes, HOST_SEND_PER_SECOND)) return;
  addChat({ from: "host", name: "", text: cleanText(text, TEXT_MAX), ref, secret: secret !== false });
}

// À la révélation, les propositions de la manche deviennent visibles de tous
function unmaskGuesses() {
  if (!room) return;
  for (const msg of room.chat) {
    if (!msg.private) continue;
    msg.private = false;
    broadcast({ t: "chatUpdate", msg: publicChat(msg) });
  }
}

function award(playerId, delta = 1) {
  if (!room) return;
  // L'hôte qui joue (onglet Blind test) a aussi un score
  if (playerId === "host") {
    room.hostScore = (room.hostScore ?? 0) + delta;
    return systemMessage(delta > 0 ? "chatPointPlus" : "chatPointMinus", delta, t("host"), room.hostScore);
  }
  const p = room.players.get(playerId);
  if (!p) return;
  p.score += delta;
  systemMessage(delta > 0 ? "chatPointPlus" : "chatPointMinus", delta, p.name, p.score);
}

function resetScores() {
  if (!room) return;
  room.hostScore = 0;
  for (const p of room.players.values()) p.score = 0;
  update();
}

// À la révélation : un point pour chaque joueur dont une proposition de la manche est assez
// proche du titre (ou du chapitre), selon les mêmes règles que l'indice « probable ».
// L'animateur peut préférer donner les points lui-même (réglage « Points »).
function autoScore() {
  if (!room) return;
  // Animateur qui donne les points lui-même, ou joueurs qui se jugent eux-mêmes
  if (state.mode === "emcee" ? state.blind.scoring === "manual" : state.blind.judge === "self") return;
  const parts = roundParts();
  if (!parts) return;
  const tries = new Map();
  const best = new Map();
  for (const msg of room.chat) {
    if (msg.round !== game.pos || !msg.text) continue;
    if (state.mode === "emcee" && msg.from === "host") continue; // l'animateur ne joue pas
    const n = (tries.get(msg.from) ?? 0) + 1;
    tries.set(msg.from, n);
    if (n <= GUESSES_PER_ROUND) best.set(msg.from, Math.max(best.get(msg.from) ?? 0, guessPoints(msg.text, parts)));
  }
  const scored = [...best].filter(([, pts]) => pts > 0).sort((a, b) => b[1] - a[1]);
  if (!scored.length) return systemMessage("chatNobody");
  for (const [id, pts] of scored) award(id, pts);
}

// Chacun se juge : après la révélation, chaque joueur dit s'il a trouvé (une fois par manche)
function claim(id, found) {
  if (!room || state.mode !== "blind" || state.blind.judge !== "self" || game.phase !== "revealed") return;
  if (room.claims?.round !== game.pos) room.claims = { round: game.pos, ids: new Set() };
  if (room.claims.ids.has(id)) return;
  room.claims.ids.add(id);
  if (found) award(id, 1);
  else update();
}

// --- État partagé avec les invités -------------------------------------------

function currentAnswer() {
  const item = items()[state.index];
  if (!item) return null;
  return game.chapter?.title ? `${game.chapter.title} · ${item.title}` : item.title;
}

function playerList() {
  return [...room.players.values()].map(({ id, name, color, score }) => ({ id, name, color, score }));
}

function publicState() {
  const listen = !inGame();
  const item = items()[state.index];
  return {
    t: "state",
    mode: state.mode,
    players: playerList(),
    // En blind test, les invités ne voient ni la playlist ni le titre avant la révélation
    playlist: listen ? items().map(({ id, title, chapters }) => ({ id, title, chapters: chapters ?? null })) : null,
    index: listen ? state.index : null,
    title: listen ? item?.title ?? null : null,
    blind: listen
      ? null
      : {
          phase: game.phase,
          round: game.pos + 1,
          total: game.order.length,
          remaining: game.remaining,
          clip: game.clip,
          hideVideo: state.blind.hideVideo,
          answer: game.phase === "revealed" ? currentAnswer() : null,
          nextIn: game.phase === "revealed" ? game.nextIn : 0,
          claim: state.mode === "blind" && state.blind.judge === "self", // chacun se juge
        },
    // L'hôte joue lui aussi : son score s'affiche avec ceux des invités
    hostScore: state.mode === "blind" ? room.hostScore ?? 0 : null,
  };
}

// Appelé à chaque mise à jour du moteur : n'envoie que si l'état visible a changé
function roomUpdate() {
  if (room?.public && room.status === "open") announceIfChanged();
  if (!room || !room.players.size) return;
  const pub = publicState();
  const json = JSON.stringify(pub);
  if (json === lastPublic) return;
  lastPublic = json;
  broadcast(pub);
}

// Position de lecture de l'hôte, relayée aux invités (à chaque changement, sinon toutes les 2 s)
let lastSyncSent = 0;
function roomTick(tick, force = false) {
  if (!tick?.id) return;
  const playing = tick.state === 1 || (tick.state === 3 && lastSync?.playing);
  const changed = !lastSync || lastSync.id !== tick.id || lastSync.playing !== playing;
  lastSync = { t: "sync", id: tick.id, time: tick.time, playing };
  if (!room || !room.players.size) return;
  if (force || changed || Date.now() - lastSyncSent > 2000) {
    lastSyncSent = Date.now();
    broadcast(lastSync);
  }
}

function roomSnapshot() {
  if (!room) return null;
  return {
    code: room.code,
    link: room.link,
    status: room.status,
    public: room.public,
    players: playerList(),
    hostScore: room.hostScore ?? 0,
    hostClaimed: room.claims?.round === game.pos && room.claims.ids.has("host"),
    chat: room.chat,
  };
}

// --- Salons publics (Nostr) ----------------------------------------------------

const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"];
const ANNOUNCE_TAG = "sidetrack-room";
const ANNOUNCE_EVERY = 60 * 1000;
const ANNOUNCE_TTL = 180; // secondes : un salon qui ne s'annonce plus disparaît de la liste

let nostrPool = null;
let announceKey = null;
let announceTimer = null;
let lastAnnounced = "";
let publicRooms = { list: [], loading: false, at: 0 };


function pool() {
  return (nostrPool ??= new NostrTools.SimplePool());
}

function publishAnnouncement(content, ttl) {
  const created = nowSeconds();
  const event = NostrTools.finalizeEvent(
    {
      kind: 30078, // données d'application, remplaçables (une annonce par clé)
      created_at: created,
      tags: [["d", ANNOUNCE_TAG], ["t", ANNOUNCE_TAG], ["expiration", String(created + ttl)]],
      content: JSON.stringify({ v: 1, ...content }),
    },
    announceKey
  );
  Promise.allSettled(pool().publish(NOSTR_RELAYS, event)).then((results) => {
    if (!results.some((r) => r.status === "fulfilled")) log(t("logAnnounceFailed"));
  });
}

function announcement() {
  const playing = inGame() && !["idle", "over"].includes(game.phase);
  return { code: room.code, players: room.players.size, mode: inGame() ? "blind" : "listen", game: playing };
}

function announce() {
  if (!room?.public) return;
  const content = announcement();
  lastAnnounced = JSON.stringify(content);
  publishAnnouncement(content, ANNOUNCE_TTL);
}

// Nombre de joueurs ou mode changé : on met l'annonce à jour sans attendre la minute
function announceIfChanged() {
  if (JSON.stringify(announcement()) !== lastAnnounced) announce();
}

function startAnnouncing() {
  announceKey = NostrTools.generateSecretKey(); // clé jetable : rien ne relie deux salons
  announce();
  announceTimer = setInterval(announce, ANNOUNCE_EVERY);
}

function stopAnnouncing() {
  clearInterval(announceTimer);
  announceTimer = null;
  lastAnnounced = "";
  publishAnnouncement({ closed: true }, 30); // remplace l'annonce : le salon sort de la liste
}

async function refreshPublicRooms() {
  if (publicRooms.loading) return;
  publicRooms.loading = true;
  update();
  try {
    const now = nowSeconds();
    const events = await pool().querySync(
      NOSTR_RELAYS,
      { kinds: [30078], "#t": [ANNOUNCE_TAG], since: now - ANNOUNCE_TTL },
      { maxWait: 4000 }
    );
    // Dernière annonce de chaque salon (une clé par salon)
    const latest = new Map();
    for (const e of events) {
      if (!latest.has(e.pubkey) || e.created_at > latest.get(e.pubkey).created_at) latest.set(e.pubkey, e);
    }
    const list = [];
    for (const e of latest.values()) {
      const expiration = Number(e.tags.find((t) => t[0] === "expiration")?.[1] ?? 0);
      if (expiration && expiration < now) continue;
      let c;
      try {
        c = JSON.parse(e.content);
      } catch {
        continue;
      }
      if (c.closed || typeof c.code !== "string" || !ROOM_NAME.test(c.code)) continue;
      if (c.code === room?.code) continue; // notre propre salon
      list.push({
        code: c.code,
        players: Math.max(0, Number(c.players) || 0),
        mode: c.mode === "blind" ? "blind" : "listen",
        game: c.game === true,
        at: e.created_at,
      });
    }
    publicRooms.list = list.sort((a, b) => b.at - a.at);
    publicRooms.at = Date.now();
  } catch (e) {
    log(t("logRoomsError", e.message));
  }
  publicRooms.loading = false;
  update();
}

function publicRoomsSnapshot() {
  return publicRooms;
}

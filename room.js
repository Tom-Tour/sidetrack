// Salon multijoueur : l'extension est l'hôte, les invités se connectent en pair-à-pair
// (PeerJS ; son serveur public ne sert qu'à mettre les navigateurs en relation).
// Les invités utilisent la page join/ sur GitHub Pages, sans rien installer, ou leur
// propre extension (guest.js).
//
// L'hôte choisit les vidéos. En blind test, les propositions tapées dans le chat restent
// cachées jusqu'à la révélation ; les points se comptent à l'écrit, ou chacun se juge, ou
// l'animateur les donne.
//
// Sécurité : les méthodes communes du kit (common/net.js, common/pow.js), identiques dans
// toutes les extensions :
// - chaque invité a une identité (clé Nostr gardée dans son navigateur) et signe le défi
//   aléatoire envoyé par l'hôte (signHello / verifyHello) : impossible de se faire passer pour
//   un autre ou de rejouer une connexion ; exclure ou bannir vise cette identité ;
// - chaque identité apporte sa preuve de travail, qui donne son code de 4 caractères affiché à
//   côté du nom : un banni ne revient pas avec des milliers de nouvelles identités ;
// - limites fixes (LIMITS) : au-delà, les messages sont ignorés, et qui insiste est mis en
//   sourdine une minute ; tout ce qui arrive des invités est nettoyé ;
// - battement de cœur (HEARTBEAT) : une connexion muette depuis 30 s est fermée ;
// - bloquer : un invité qui bloque quelqu'un nous envoie son identité, et l'hôte ne relaie
//   plus rien entre eux (messages, pastilles), dans les deux sens. Une personne que l'hôte a
//   bloquée dans le salon d'un autre n'entre pas dans les siens.
//
// Un salon public est en plus annoncé sur des relais Nostr publics (nostr-tools), d'où
// la liste des salons disponibles. Annonces signées avec une clé jetable par salon,
// renouvelées chaque minute et expirant d'elles-mêmes.

const JOIN_URL = "https://tom-tour.github.io/sidetrack/join/";
const ROOM_PREFIX = "sidetrack-room-";
const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const CHAT_LIMIT = 200;
// Temps laissé à un invité pour se présenter (sa preuve de travail est calculée avant)
const HELLO_TIMEOUT = 30 * 1000;

// { code, link, status, public, peer, players: Map(pubkey → joueur), pending: Map(conn → {…}),
//   kicked: Set(pubkey), chat: [], beat }
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
    update();
    return "noticeNameShort";
  }
  const code = chosen || makeCode();
  const peer = new Peer(ROOM_PREFIX + code);
  room = {
    code,
    link: `${JOIN_URL}#${code}`,
    status: "opening",
    public: isPublic === true,
    peer,
    players: new Map(),
    pending: new Map(),
    kicked: new Set(),
    chat: [],
    beat: setInterval(heartbeat, HEARTBEAT.EVERY),
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
      clearInterval(room.beat);
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
  clearInterval(room.beat);
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

// Deux invités dont l'un a bloqué l'autre : rien ne passe entre eux
function apart(a, b) {
  return !!(room?.players.get(a)?.blocks.has(b) || room?.players.get(b)?.blocks.has(a));
}

// Message d'un invité : à tous, sauf à ceux qui l'ont bloqué ou qu'il a bloqués
function broadcastFrom(from, msg) {
  if (!room) return;
  for (const p of room.players.values()) {
    if (!apart(from, p.id)) safeSend(p.conn, msg);
  }
}

// État du salon vu par un invité : sans les pastilles des personnes bloquées
function stateFor(p, pub) {
  const players = pub.players.filter((x) => !apart(p.id, x.id));
  return players.length === pub.players.length ? pub : { ...pub, players };
}

// Battement de cœur : un ping à chacun, et qui ne donne plus signe de vie depuis SILENCE est
// retiré (sinon il resterait en fantôme et reviendrait en double)
function heartbeat() {
  if (!room) return;
  const now = Date.now();
  for (const p of room.players.values()) {
    if (now - p.lastSeen < HEARTBEAT.SILENCE) {
      safeSend(p.conn, { t: "ping" });
      continue;
    }
    room.players.delete(p.id);
    p.removed = true;
    try {
      p.conn.close();
    } catch {}
    systemMessage("sysLeft", p.name);
  }
}

// --- Arrivée d'un invité : défi signé, preuve de travail, puis admission ------------

function acceptConnection(conn) {
  if (!room) return;
  if (room.players.size + room.pending.size >= LIMITS.MAX_PEERS) {
    conn.on("open", () => {
      safeSend(conn, { t: "full" });
      setTimeout(() => conn.close(), 300);
    });
    return;
  }
  const entry = {
    challenge: hex(crypto.getRandomValues(new Uint8Array(16))),
    checking: false,
    timer: setTimeout(() => conn.close(), HELLO_TIMEOUT),
  };
  room.pending.set(conn, entry);
  conn.on("open", () => {
    // La preuve est demandée dans tous les salons : c'est d'elle que vient le code affiché
    safeSend(conn, { t: "challenge", c: entry.challenge, room: room?.code, pow: POW.BITS });
  });
  conn.on("data", (msg) => onConnData(conn, msg));
  conn.on("close", () => dropConn(conn));
  conn.on("error", () => dropConn(conn));
}

function onConnData(conn, msg) {
  if (!room || !msg || typeof msg !== "object") return;
  const entry = room.pending.get(conn);
  if (entry) {
    if (msg.t !== "hello" || entry.checking) return;
    // Poignée de main valide : signée par l'identité, pour ce salon et ce défi, récente
    const id = verifyHello(msg.ev, { room: room.code, challenge: entry.challenge });
    if (!id) return conn.close();
    // Une personne bloquée n'entre pas non plus : pour elle, c'est comme un bannissement
    if (settings.banned[id] || settings.blocked[id] || room.kicked.has(id)) {
      safeSend(conn, { t: settings.banned[id] || settings.blocked[id] ? "banned" : "kicked" });
      return setTimeout(() => conn.close(), 300);
    }
    const nonce = Number(msg.ev.tags.find((x) => x[0] === "pow")?.[1]);
    if (!Number.isSafeInteger(nonce) || nonce < 0) return conn.close();
    entry.checking = true;
    // Défi de l'invité : l'hôte le signera à son tour dans « welcome » (l'invité vérifie qui l'accueille)
    entry.guestChallenge = typeof msg.gc === "string" && /^[0-9a-f]{32}$/.test(msg.gc) ? msg.gc : null;
    pow.check(id, nonce).then(({ bits, code }) => {
      if (bits < POW.BITS) return conn.close();
      if (room?.pending.get(conn) === entry && conn.open) admit(conn, entry, id, code, msg.name);
    });
    return;
  }
  const player = [...room.players.values()].find((p) => p.conn === conn);
  if (!player) return;
  player.lastSeen = Date.now(); // toute donnée reçue compte comme signe de vie
  onPlayerData(player, msg);
}

// Les noms ne sont pas forcés uniques (c'est le code qui distingue deux « Tom »). Seul le
// nom de l'hôte est réservé : propre à Sidetrack, où l'hôte apparaît sous le nom « Hôte »
// dans le chat et pourrait sinon être imité par un invité.
function guestName(raw) {
  const name = cleanName(raw, t("defaultName"));
  const reserved = new Set(["hôte", "host", t("host").toLowerCase()]);
  return reserved.has(name.toLowerCase()) ? t("defaultName") : name;
}

function admit(conn, entry, id, code, rawName) {
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
    code,
    conn,
    name: guestName(rawName),
    color: colorFor(id),
    score: old?.score ?? 0,
    blocks: old?.blocks ?? new Set(), // identités que cet invité a bloquées
    chatTimes: [],
    metaTimes: [],
    lastSeen: Date.now(),
    drops: [],
    mutedUntil: 0,
  };
  room.players.set(id, player);
  const chat = room.chat.filter((m) => !apart(id, m.from)).map(publicChat);
  // Preuve de l'hôte : notre identité signe le défi de l'invité, pour ce salon, avec notre preuve de travail
  const hostEv = entry.guestChallenge
    ? signHello(identity.secret, [["room", room.code], ["challenge", entry.guestChallenge], ["role", "host"], ["pow", String(identity.pow)]])
    : undefined;
  safeSend(conn, { t: "welcome", code: room.code, you: id, myCode: code, name: player.name, hostId: identity.pubkey, hostEv, chat });
  safeSend(conn, stateFor(player, publicState()));
  if (lastSync) safeSend(conn, lastSync);
  if (!old) systemMessage("sysJoined", player.name);
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
    if (!p.replaced && !p.removed) systemMessage("sysLeft", p.name);
    update();
  }
}

function onPlayerData(p, msg) {
  const now = Date.now();
  if (p.mutedUntil > now) return;
  const chatty = msg.t === "chat";
  if (!rateOk(chatty ? p.chatTimes : p.metaTimes, chatty ? LIMITS.RECV_PER_SECOND : LIMITS.META_PER_SECOND, now)) {
    if (floodCheck(p.drops, now)) {
      p.mutedUntil = now + LIMITS.FLOOD_MUTE;
      safeSend(p.conn, { t: "muted", ms: LIMITS.FLOOD_MUTE });
      systemMessage("sysFlood", p.name);
    }
    return;
  }

  switch (msg.t) {
    case "chat":
      addChat({
        from: p.id,
        code: p.code,
        name: p.name,
        color: p.color,
        text: cleanText(msg.text),
        ref: cleanRef(msg.ref),
        secret: msg.secret !== false,
      });
      break;
    case "claim":
      claim(p.id, msg.found === true);
      break;
    case "block":
    case "unblock":
      setBlock(p, msg.t === "block", msg.id);
      break;
    case "ping":
      safeSend(p.conn, { t: "pong", at: Number(msg.at) || 0 });
      break;
    case "bye":
      p.conn.close();
      break;
  }
}

// Exclure : jusqu'à la fermeture du salon. Bannir : pour de bon (liste dans les réglages,
// au format « Nom · CODE »). Les messages d'un banni disparaissent du chat.
function kick(id, permanent = false) {
  const p = room?.players.get(id);
  if (!p) return;
  room.kicked.add(id);
  if (permanent) {
    settings.banned[id] = `${p.name} · ${p.code}`;
    save();
    room.chat = room.chat.filter((m) => m.from !== id);
    broadcast({ t: "chatRemove", from: id });
  }
  p.removed = true;
  safeSend(p.conn, { t: permanent ? "banned" : "kicked" });
  setTimeout(() => p.conn.close(), 300);
  systemMessage(permanent ? "sysBanned" : "sysKicked", p.name);
}

// Un invité bloque (ou débloque) quelqu'un du salon. Il n'envoie que les identités présentes,
// au fur et à mesure : l'hôte ne connaît pas sa liste entière.
function setBlock(p, on, id) {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || id === p.id) return;
  if (on) {
    if (p.blocks.size >= 100) return;
    p.blocks.add(id);
    // Les messages déjà affichés disparaissent, des deux côtés
    safeSend(p.conn, { t: "chatRemove", from: id });
    const other = room.players.get(id);
    if (other) safeSend(other.conn, { t: "chatRemove", from: p.id });
  } else {
    p.blocks.delete(id);
  }
  lastPublic = ""; // les pastilles changent pour eux deux
  update();
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
// Seule la meilleure réponse de chaque joueur compte, et chaque indice dévoilé baisse le maximum
// possible au moment où l'on répond (voir hints dans background.js).

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

// Points d'une réponse donnée alors que le maximum était `max` (indices déjà dévoilés)
function cappedPoints(text, max, parts) {
  return Math.round((guessPoints(text, parts) * (max ?? 10)) / 10);
}

// Blind test solo, points à l'écrit : la meilleure de nos réponses de la manche
function soloPoints() {
  const parts = roundParts();
  if (!parts) return 0;
  return Math.max(0, ...game.guesses.map((g) => cappedPoints(g.text, g.max, parts)));
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
    max: player && secret && guessing() ? maxPoints() : null, // plafond selon les indices déjà dévoilés
    hint: fromGuest && guessHint(entry.text), // jamais envoyé aux invités
  };
  room.chat.push(msg);
  if (room.chat.length > CHAT_LIMIT) room.chat.shift();
  broadcastFrom(msg.from, { t: "chat", msg: publicChat(msg) });
  if (fromGuest) noteMessage();
  update();
}

// Ce que voient les invités : jamais l'indice d'arbitrage, et rien d'une proposition masquée
function publicChat(msg) {
  const { id, at, from, code, name, color, system, key, args, ref } = msg;
  if (msg.private) return { id, at, from, code, name, color, masked: true };
  return { id, at, from, code, name, color, system, key, args, text: msg.text, ref };
}

// Message système : envoyé comme clé de traduction, chacun le lit dans sa langue
function systemMessage(key, ...args) {
  if (room) addChat({ system: true, key, args });
}

// Le nom « Hôte » est traduit à l'affichage (from === "host")
function hostChat(text, ref = null, secret = true) {
  if (!room || !rateOk(hostTimes, LIMITS.SEND_PER_SECOND)) return "errTooFast";
  addChat({ from: "host", code: identity.code, name: "", text: cleanText(text), ref, secret: secret !== false });
}

// À la révélation, les propositions de la manche deviennent visibles de tous
function unmaskGuesses() {
  if (!room) return;
  for (const msg of room.chat) {
    if (!msg.private) continue;
    msg.private = false;
    broadcastFrom(msg.from, { t: "chatUpdate", msg: publicChat(msg) });
  }
}

function award(playerId, delta = 1) {
  if (!room) return;
  // L'hôte qui joue (onglet Blind test) a aussi un score
  if (playerId === "host") {
    room.hostScore = (room.hostScore ?? 0) + delta;
    return systemMessage(delta > 0 ? "sysPointPlus" : "sysPointMinus", delta, t("host"), room.hostScore);
  }
  const p = room.players.get(playerId);
  if (!p) return;
  p.score += delta;
  systemMessage(delta > 0 ? "sysPointPlus" : "sysPointMinus", delta, p.name, p.score);
}

function resetScores() {
  if (!room) return;
  room.hostScore = 0;
  for (const p of room.players.values()) p.score = 0;
  update();
}

// À la révélation : des points pour chaque joueur dont une proposition de la manche est assez
// proche du titre (ou du chapitre). L'animateur peut préférer donner les points lui-même
// (réglage « Points »), et les joueurs peuvent se juger eux-mêmes.
function autoScore() {
  if (!room) return;
  // Animateur qui donne les points lui-même, ou joueurs qui se jugent eux-mêmes
  if (state.mode === "emcee" ? settings.blind.scoring === "manual" : settings.blind.judge === "self") return;
  const parts = roundParts();
  if (!parts) return;
  // La meilleure réponse de chaque joueur, chacune plafonnée selon les indices du moment
  const best = new Map();
  for (const msg of room.chat) {
    if (msg.round !== game.pos || !msg.text) continue;
    if (state.mode === "emcee" && msg.from === "host") continue; // l'animateur ne joue pas
    best.set(msg.from, Math.max(best.get(msg.from) ?? 0, cappedPoints(msg.text, msg.max, parts)));
  }
  const scored = [...best].filter(([, pts]) => pts > 0).sort((a, b) => b[1] - a[1]);
  if (!scored.length) return systemMessage("sysNobody");
  for (const [id, pts] of scored) award(id, pts);
}

// Chacun se juge : après la révélation, chaque joueur dit s'il a trouvé (une fois par manche)
function claim(id, found) {
  if (!room || state.mode !== "blind" || settings.blind.judge !== "self" || game.phase !== "revealed") return;
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
  return [...room.players.values()].map(({ id, code, name, color, score }) => ({ id, code, name, color, score }));
}

function publicState() {
  const listen = !inGame();
  const item = items()[state.index];
  return {
    t: "state",
    mode: state.mode,
    players: playerList(),
    hostCode: identity.code,
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
          hideVideo: settings.blind.hideVideo,
          answer: game.phase === "revealed" ? currentAnswer() : null,
          nextIn: game.phase === "revealed" ? game.nextIn : 0,
          claim: state.mode === "blind" && settings.blind.judge === "self", // chacun se juge
          hint: ["playing", "timeup"].includes(game.phase) ? hintMask() : null,
          maxPts: maxPoints(),
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
  for (const p of room.players.values()) safeSend(p.conn, stateFor(p, pub));
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

const ANNOUNCE_TAG = "sidetrack-room";
const ANNOUNCE_EVERY = 60 * 1000;
const ANNOUNCE_TTL = 150; // secondes (GUIDE.md) : un salon qui ne s'annonce plus disparaît de la liste

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
      kind: PRESENCE_KIND, // données d'application, remplaçables (une annonce par clé)
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
      { kinds: [PRESENCE_KIND], "#t": [ANNOUNCE_TAG], since: now - ANNOUNCE_TTL },
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
        players: Math.max(0, Math.min(LIMITS.MAX_PEERS, Number(c.players) || 0)),
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

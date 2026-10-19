// Salon multijoueur : l'extension est l'hôte, les invités se connectent en pair-à-pair
// (PeerJS ; son serveur public ne sert qu'à mettre les navigateurs en relation).
// Les invités utilisent la page join/ sur GitHub Pages, sans rien installer.
//
// L'hôte choisit les vidéos et arbitre : en blind test, les propositions tapées dans le
// chat ne sont visibles que de lui pendant la manche, et c'est lui qui donne les points.
//
// Un salon public est en plus annoncé sur des relais Nostr publics (nostr-tools), d'où
// la liste des salons disponibles. Annonces signées avec une clé jetable par salon,
// renouvelées chaque minute et expirant d'elles-mêmes.

const JOIN_URL = "https://tom-tour.github.io/sidetrack/join/";
const ROOM_PREFIX = "sidetrack-room-";
const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const CHAT_LIMIT = 200;

// { code, link, status, public, peer, players: Map(peerId → { id, name, score, conn }), chat: [] }
let room = null;
let chatSeq = 0;
let lastPublic = "";
let lastSync = null;

function makeCode() {
  return Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
}

// Nom de salon = identifiant pour le rejoindre : minuscules, sans accents, espaces → tirets
function roomName(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}
const ROOM_NAME = /^[a-z0-9_-]{3,24}$/;

function openRoom({ isPublic = false, name = "" } = {}) {
  if (room) return;
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
    chat: [],
  };
  lastPublic = "";

  peer.on("open", () => {
    room.status = "open";
    log(t(room.public ? "logRoomOpenPublic" : "logRoomOpen", code));
    if (room.public) startAnnouncing();
    update();
  });
  peer.on("connection", acceptPlayer);
  peer.on("disconnected", () => {
    if (room?.peer === peer) peer.reconnect();
  });
  peer.on("error", (e) => {
    if (room?.peer !== peer) return;
    if (e.type === "unavailable-id") {
      // Nom déjà pris : ce salon existe, on le rejoint (même champ pour créer ou rejoindre)
      peer.destroy();
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

// Rejoindre le salon de quelqu'un : la page invité s'ouvre dans un onglet visible
// (il faut voir la vidéo et cliquer dans la page pour avoir le son)
function joinRoom(code) {
  code = roomName(code);
  if (!ROOM_NAME.test(code)) return log(t("logBadCode"));
  send({ action: "pause" }); // notre propre musique laisse la place au salon
  browser.tabs.create({ url: `${JOIN_URL}#${code}` });
}

function closeRoom() {
  if (!room) return;
  if (room.public) stopAnnouncing();
  broadcast({ t: "closed" });
  const { peer } = room;
  room = null;
  setTimeout(() => peer.destroy(), 300); // laisse partir le message de fermeture
  log(t("logRoomClosed"));
  update();
}

function broadcast(msg, except = null) {
  if (!room) return;
  for (const p of room.players.values()) {
    if (p.id !== except && p.conn.open) p.conn.send(msg);
  }
}

// --- Invités ---------------------------------------------------------------

function acceptPlayer(conn) {
  conn.on("data", (msg) => onPlayerData(conn, msg));
  conn.on("close", () => {
    const p = room?.players.get(conn.peer);
    if (!p) return;
    room.players.delete(conn.peer);
    systemMessage("chatLeft", p.name);
  });
}

function onPlayerData(conn, msg) {
  if (!room || !msg || typeof msg !== "object") return;
  const player = room.players.get(conn.peer);

  if (msg.t === "hello" && !player) {
    const name = String(msg.name ?? "").trim().slice(0, 24) || t("defaultGuest");
    room.players.set(conn.peer, { id: conn.peer, name, score: 0, conn });
    conn.send({ t: "welcome", code: room.code, chat: room.chat.map(publicChat) });
    conn.send(publicState());
    if (lastSync) conn.send(lastSync);
    systemMessage("chatJoined", name);
    return;
  }
  if (!player) return;

  switch (msg.t) {
    case "chat":
      addChat({ from: player.id, name: player.name, text: String(msg.text ?? "").slice(0, 300), ref: cleanRef(msg.ref) });
      break;
    case "ping":
      conn.send({ t: "pong", at: msg.at });
      break;
  }
}

// Référence envoyée par un invité : une vidéo de la playlist, un chapitre ou un moment
function cleanRef(ref) {
  if (!ref || typeof ref !== "object" || !/^[\w-]{11}$/.test(ref.id)) return null;
  const start = Number(ref.start);
  return {
    id: ref.id,
    start: Number.isFinite(start) && start >= 0 ? Math.floor(start) : 0,
    label: String(ref.label ?? "").slice(0, 120),
  };
}

// --- Chat ------------------------------------------------------------------

// Pendant une manche de blind test, les propositions restent privées (visibles de l'hôte)
function guessing() {
  return state.mode === "blind" && (game.phase === "playing" || game.phase === "timeup");
}

function addChat(entry) {
  if (!entry.text && !entry.ref && !entry.system) return;
  const msg = { id: ++chatSeq, at: Date.now(), private: !entry.system && entry.from !== "host" && guessing(), ...entry };
  room.chat.push(msg);
  if (room.chat.length > CHAT_LIMIT) room.chat.shift();
  broadcast({ t: "chat", msg: publicChat(msg) });
  update();
}

function publicChat(msg) {
  const { id, at, from, name, system, key, args, ref } = msg;
  if (msg.private) return { id, at, from, name, masked: true };
  return { id, at, from, name, system, key, args, text: msg.text, ref };
}

// Message système : envoyé comme clé de traduction, chacun le lit dans sa langue
function systemMessage(key, ...args) {
  if (room) addChat({ system: true, key, args });
}

// Le nom « Hôte » est traduit à l'affichage (from === "host")
function hostChat(text, ref = null) {
  if (room) addChat({ from: "host", name: "", text: String(text).slice(0, 300), ref });
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
  const p = room?.players.get(playerId);
  if (!p) return;
  p.score += delta;
  systemMessage(delta > 0 ? "chatPointPlus" : "chatPointMinus", delta, p.name, p.score);
}

// --- État partagé avec les invités -------------------------------------------

function currentAnswer() {
  const item = items()[state.index];
  if (!item) return null;
  return game.chapter?.title ? `${game.chapter.title} · ${item.title}` : item.title;
}

function publicState() {
  const listen = state.mode === "listen";
  const item = items()[state.index];
  return {
    t: "state",
    mode: state.mode,
    players: [...room.players.values()].map(({ id, name, score }) => ({ id, name, score })),
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
        },
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
    players: [...room.players.values()].map(({ id, name, score }) => ({ id, name, score })),
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

const nowSeconds = () => Math.floor(Date.now() / 1000);

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
  return { code: room.code, players: room.players.size, mode: state.mode };
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

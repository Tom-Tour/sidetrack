// Salon multijoueur : l'extension est l'hôte, les invités se connectent en pair-à-pair
// (PeerJS ; son serveur public ne sert qu'à mettre les navigateurs en relation).
// Les invités utilisent la page join/ sur GitHub Pages, sans rien installer.
//
// L'hôte choisit les vidéos et arbitre : en blind test, les propositions tapées dans le
// chat ne sont visibles que de lui pendant la manche, et c'est lui qui donne les points.

const JOIN_URL = "https://tom-tour.github.io/sidetrack/join/";
const ROOM_PREFIX = "sidetrack-room-";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CHAT_LIMIT = 200;

// { code, link, status, peer, players: Map(peerId → { id, name, score, conn }), chat: [] }
let room = null;
let chatSeq = 0;
let lastPublic = "";
let lastSync = null;

function makeCode() {
  return Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
}

function openRoom() {
  if (room) return;
  log(
    `Création du salon : PeerJS ${typeof Peer === "function" ? "chargé" : "ABSENT"}, ` +
      `WebRTC ${typeof RTCPeerConnection === "function" ? "disponible" : "ABSENT"}`
  );
  const code = makeCode();
  const peer = new Peer(ROOM_PREFIX + code);
  room = { code, link: `${JOIN_URL}#${code}`, status: "opening", peer, players: new Map(), chat: [] };
  lastPublic = "";

  peer.on("open", () => {
    room.status = "open";
    log(`Salon ${code} ouvert`);
    update();
  });
  peer.on("connection", acceptPlayer);
  peer.on("disconnected", () => {
    if (room?.peer === peer) peer.reconnect();
  });
  peer.on("error", (e) => {
    if (room?.peer !== peer) return;
    if (e.type === "unavailable-id") {
      // Code déjà pris : on en tire un autre
      peer.destroy();
      room = null;
      return openRoom();
    }
    log(`Salon : erreur ${e.type}`);
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
  code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 5) return log("✗ Code de salon invalide (5 caractères)");
  send({ action: "pause" }); // notre propre musique laisse la place au salon
  browser.tabs.create({ url: `${JOIN_URL}#${code}` });
}

function closeRoom() {
  if (!room) return;
  broadcast({ t: "closed" });
  const { peer } = room;
  room = null;
  setTimeout(() => peer.destroy(), 300); // laisse partir le message de fermeture
  log("Salon fermé");
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
    systemMessage(`${p.name} est parti`);
  });
}

function onPlayerData(conn, msg) {
  if (!room || !msg || typeof msg !== "object") return;
  const player = room.players.get(conn.peer);

  if (msg.t === "hello" && !player) {
    const name = String(msg.name ?? "").trim().slice(0, 24) || "Invité";
    room.players.set(conn.peer, { id: conn.peer, name, score: 0, conn });
    conn.send({ t: "welcome", code: room.code, chat: room.chat.map(publicChat) });
    conn.send(publicState());
    if (lastSync) conn.send(lastSync);
    systemMessage(`${name} a rejoint le salon`);
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
  const { id, at, from, name, system, ref } = msg;
  if (msg.private) return { id, at, from, name, masked: true };
  return { id, at, from, name, system, text: msg.text, ref };
}

function systemMessage(text) {
  if (room) addChat({ system: true, text });
}

function hostChat(text, ref = null) {
  if (room) addChat({ from: "host", name: "Hôte", text: String(text).slice(0, 300), ref });
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
  systemMessage(delta > 0 ? `+${delta} point pour ${p.name} (${p.score})` : `${delta} point pour ${p.name} (${p.score})`);
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
    players: [...room.players.values()].map(({ id, name, score }) => ({ id, name, score })),
    chat: room.chat,
  };
}

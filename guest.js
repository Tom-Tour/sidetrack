// Rejoindre le salon de quelqu'un depuis l'extension : même protocole que la page join/,
// mais le chat et l'état du salon s'affichent dans la barre latérale, et la vidéo de
// l'hôte passe par notre propre lecteur (l'onglet masqué), recalé sur sa position.
//
// L'identité (clé et preuve de travail) est celle de l'extension (background.js).
//
// Bloquer (GUIDE.md) : les personnes bloquées disparaissent de notre chat et de nos pastilles,
// et on dit à l'hôte de ne plus rien relayer entre elles et nous. On ne lui envoie que celles
// qui sont dans son salon, quand elles y sont : il ne connaît pas notre liste entière. Bloquer
// l'hôte fait quitter le salon, et ses salons nous sont fermés.

// { code, status: "connecting" | "proof" | "joined" | "ended", endKey, endArgs, peer, conn,
//   me, players, chat, host (dernier état envoyé par l'hôte), sync, latency, heard… }
let guest = null;
let playerTick = null; // dernière position annoncée par notre lecteur
let joinSeq = 0;       // seule la dernière demande pour rejoindre compte (double clic…)

function inGuestRoom() {
  return !!guest;
}

// --- Connexion ---------------------------------------------------------------

async function joinRoom(code) {
  code = roomName(code);
  if (!ROOM_NAME.test(code)) return log(t("logBadCode"));
  if (room) return; // on héberge déjà un salon
  // Déjà dans ce salon (ou en train d'y entrer) : surtout pas une seconde connexion
  if (guest && guest.code === code && guest.status !== "ended") return;
  leaveRoom(); // annule aussi une demande précédente encore en cours
  const seq = ++joinSeq;
  await ready;
  if (seq !== joinSeq || room) return;
  // Notre propre musique et notre partie laissent la place au salon
  resetGame();
  send({ action: "pause" });
  guest = {
    code,
    status: "connecting",
    endKey: null,
    endArgs: [],
    peer: null,
    conn: null,
    me: null,
    players: [],
    chat: [],
    secrets: [], // mes propositions masquées, pour les afficher chez moi
    host: null,
    hostId: "",
    blockSent: new Set(), // identités bloquées déjà signalées à l'hôte
    sync: null,
    latency: 0,
    sendTimes: [],
    loading: null,
    beat: null,
    heard: 0,
  };
  connectGuest(guest);
  warmPlayer();
  update();
}

function connectGuest(g) {
  g.peer?.destroy();
  const peer = new Peer();
  g.peer = peer;
  peer.on("open", () => {
    if (guest !== g) return;
    const conn = peer.connect(ROOM_PREFIX + g.code, { reliable: true, serialization: "json" });
    g.conn = conn;
    // L'hôte commence par un défi : on y répond, puis viennent les messages du salon
    conn.on("data", (msg) => {
      if (guest !== g || g.conn !== conn) return;
      if (msg?.t === "challenge") answerChallenge(g, msg);
      else onHostData(g, msg);
    });
    conn.on("close", () => {
      if (guest === g && g.conn === conn && g.status !== "ended" && g.status !== "proof") endGuest(g, "errDisconnected");
    });
  });
  peer.on("error", (e) => {
    if (guest !== g || g.peer !== peer || g.status === "ended") return;
    endGuest(g, e.type === "peer-unavailable" ? "errNotFound" : "errCantConnect", e.type);
  });
}

// Réponse au défi : signée par notre identité, pour ce salon et ce défi précis
async function answerChallenge(g, msg) {
  if (identity.pow == null) {
    // Preuve pas encore prête : on ne fait pas attendre l'hôte, on revient quand elle l'est
    g.status = "proof";
    g.conn = null;
    g.peer.destroy();
    update();
    await whenIdentity();
    if (guest !== g) return;
    g.status = "connecting";
    update();
    return connectGuest(g);
  }
  const tags = [["room", String(msg.room)], ["challenge", String(msg.c)], ["pow", String(identity.pow)]];
  safeSend(g.conn, { t: "hello", name: settings.nickname || t("defaultName"), ev: signHello(identity.secret, tags) });
}

// Fin de notre présence (salon fermé, exclusion, connexion perdue) : le panneau garde la raison
function endGuest(g, key, ...args) {
  g.status = "ended";
  g.endKey = key;
  g.endArgs = args;
  clearInterval(g.beat);
  const { peer } = g;
  setTimeout(() => peer?.destroy(), 300);
  send({ action: "pause" });
  update();
}

function leaveRoom() {
  joinSeq++;
  const g = guest;
  if (!g) return;
  guest = null;
  safeSend(g.conn, { t: "bye" });
  clearInterval(g.beat);
  setTimeout(() => g.peer?.destroy(), 300);
  send({ action: "pause" });
  update();
}

// --- Messages de l'hôte ------------------------------------------------------

// Ce que l'hôte nous dit des autres est revérifié ici aussi (formes, longueurs, couleurs)
function cleanPlayer(p) {
  return {
    id: typeof p?.id === "string" ? p.id.slice(0, 64) : "",
    code: cleanText(p?.code, 4),
    name: cleanName(p?.name),
    color: cleanColor(p?.color),
    score: Number.isFinite(p?.score) ? p.score : 0,
  };
}

function cleanGuestChat(m) {
  if (!m || typeof m !== "object") return null;
  return {
    ...m,
    name: cleanName(m.name, ""),
    code: cleanText(m.code, 4),
    color: m.color ? cleanColor(m.color) : undefined,
    text: m.text == null ? undefined : cleanText(m.text),
  };
}

function onHostData(g, msg) {
  if (!msg || typeof msg !== "object") return;
  g.heard = Date.now(); // toute donnée reçue compte comme signe de vie
  switch (msg.t) {
    case "welcome":
      g.hostId = typeof msg.hostId === "string" && /^[0-9a-f]{64}$/.test(msg.hostId) ? msg.hostId : "";
      if (settings.blocked[g.hostId]) {
        safeSend(g.conn, { t: "bye" });
        return endGuest(g, "errHostBlocked");
      }
      g.status = "joined";
      g.me = msg.you;
      g.chat = (Array.isArray(msg.chat) ? msg.chat : []).map(cleanGuestChat).filter(Boolean);
      log(t("logJoined", g.code));
      clearInterval(g.beat);
      // Battement de cœur : un ping toutes les 5 s ; plus rien de l'hôte depuis 30 s, il est perdu
      g.beat = setInterval(() => {
        if (Date.now() - g.heard > HEARTBEAT.SILENCE) return endGuest(g, "errDisconnected");
        safeSend(g.conn, { t: "ping", at: performance.now() });
      }, HEARTBEAT.EVERY);
      safeSend(g.conn, { t: "ping", at: performance.now() });
      break;
    case "state":
      g.host = msg;
      g.players = (Array.isArray(msg.players) ? msg.players : []).map(cleanPlayer);
      reportBlocks(g);
      break;
    case "chat": {
      const m = cleanGuestChat(msg.msg);
      if (!m) return;
      if (m.masked && m.from === g.me) m.mine = g.secrets.shift();
      g.chat.push(m);
      if (g.chat.length > 300) g.chat.shift();
      if (!m.system && m.from !== g.me) noteMessage();
      break;
    }
    case "chatUpdate": {
      const m = cleanGuestChat(msg.msg);
      const i = m ? g.chat.findIndex((x) => x.id === m.id) : -1;
      if (i >= 0) g.chat[i] = m;
      break;
    }
    // Un joueur banni : ses messages disparaissent
    case "chatRemove":
      g.chat = g.chat.filter((m) => m.from !== msg.from);
      break;
    case "sync":
      g.sync = { ...msg, at: Date.now() };
      followHost(g);
      break;
    case "pong":
      g.latency = (performance.now() - msg.at) / 2000;
      return;
    case "ping":
      return;
    // Fin du salon, refus ou sanction de l'hôte
    case "closed":
    case "full":
    case "kicked":
    case "banned":
      return endGuest(g, `err${msg.t[0].toUpperCase()}${msg.t.slice(1)}`);
    case "muted":
      notice = { key: "noticeMuted" };
      break;
    default:
      return;
  }
  update();
}

// --- Bloquer -------------------------------------------------------------------

// Les personnes bloquées présentes dans le salon, pas encore signalées à l'hôte
function reportBlocks(g) {
  for (const p of g.players) {
    if (!settings.blocked[p.id] || g.blockSent.has(p.id)) continue;
    g.blockSent.add(p.id);
    safeSend(g.conn, { t: "block", id: p.id });
  }
}

// Depuis la fiche d'une personne du salon (ou de l'hôte, « host »)
function guestBlock(id) {
  const g = guest;
  if (g?.status !== "joined") return;
  if (id === "host") {
    if (!g.hostId) return;
    settings.blocked[g.hostId] = `${t("host")} · ${cleanText(g.host?.hostCode, 4)}`;
    save();
    safeSend(g.conn, { t: "bye" });
    return endGuest(g, "errHostBlocked");
  }
  const p = g.players.find((x) => x.id === id);
  if (!p || id === g.me) return;
  settings.blocked[id] = `${p.name} · ${p.code}`;
  save();
  reportBlocks(g);
  update();
}

function guestUnblock(id) {
  const g = guest;
  if (!g?.blockSent.delete(id)) return;
  safeSend(g.conn, { t: "unblock", id });
}

// --- Lecture recalée sur l'hôte ------------------------------------------------

function guestTick(msg) {
  if (msg.id) playerTick = { id: msg.id, time: msg.time, state: msg.state, at: Date.now() };
}

// Même vidéo, même moment (tolérance 1,5 s), même lecture ou pause que l'hôte
function followHost(g) {
  const s = g.sync;
  if (!s?.id || !/^[\w-]{11}$/.test(s.id) || g.status !== "joined") return;
  const target = Number(s.time) + (s.playing ? (Date.now() - s.at) / 1000 + g.latency : 0);
  const here = playerPort && playerTick?.id === s.id && Date.now() - playerTick.at < 3000 ? playerTick : null;
  if (!here) {
    // Autre vidéo, ou lecteur pas encore ouvert : on charge celle de l'hôte quand il joue
    if (s.playing && (g.loading?.id !== s.id || Date.now() - g.loading.at > 8000)) {
      g.loading = { id: s.id, at: Date.now() };
      send({ action: "load", id: s.id, start: target, volume: settings.volume });
    }
    return;
  }
  const time = here.time + (here.state === 1 ? (Date.now() - here.at) / 1000 : 0);
  if (Math.abs(time - target) > 1.5) send({ action: "seek", time: target });
  if (s.playing && here.state !== 1 && here.state !== 3) send({ action: "play" });
  if (!s.playing && here.state === 1) send({ action: "pause" });
}

// Onglet du lecteur fermé pendant le salon : on le rouvre (masqué dès qu'il est prêt), et la
// vidéo de l'hôte reprend au bon moment
function guestPlayerLost() {
  if (!guest || guest.status === "ended" || playerPort) return;
  guest.loading = null;
  playerTick = null;
  if (guest.sync?.playing) followHost(guest);
  else warmPlayer();
}

// Après une erreur de YouTube : on recharge la vidéo de l'hôte (voir retryVisible)
function guestRetry() {
  if (!guest) return;
  guest.loading = null;
  playerTick = null;
  followHost(guest);
}

// En blind test, tant que la réponse n'est pas révélée, la vidéo reste cachée (si l'hôte le veut)
function guestHidesVideo() {
  const blind = guest?.host?.blind;
  return !!blind && blind.hideVideo && blind.phase !== "revealed";
}

// --- Chat --------------------------------------------------------------------

function guestSend(msg) {
  const g = guest;
  if (g?.status !== "joined") return false;
  if (!rateOk(g.sendTimes, LIMITS.SEND_PER_SECOND)) {
    notice = { key: "errTooFast", args: [LIMITS.SEND_PER_SECOND] };
    update();
    return false;
  }
  safeSend(g.conn, msg);
  return true;
}

function guestChat(text, secret = true) {
  text = cleanText(text);
  if (!text || !guest) return;
  secret = secret !== false;
  // En blind test, une réponse cachée est masquée pour les autres : on la garde pour soi
  const phase = guest.host?.blind?.phase;
  if (guestSend({ t: "chat", text, secret }) && secret && (phase === "playing" || phase === "timeup")) guest.secrets.push(text);
}

// Proposer une vidéo, un chapitre ou un moment de la playlist de l'hôte
function guestRef(ref) {
  guestSend({ t: "chat", text: "", ref });
}

function shareMoment() {
  const s = guest?.sync;
  if (!s?.id) return;
  const time = playerTick?.id === s.id ? playerTick.time : s.time;
  guestRef({ id: s.id, start: Math.floor(time), label: guest.host?.title ?? "" });
}

function guestSnapshot() {
  const g = guest;
  if (!g) return null;
  return {
    code: g.code,
    link: `${JOIN_URL}#${g.code}`,
    status: g.status,
    endKey: g.endKey,
    endArgs: g.endArgs,
    me: g.me,
    // Les personnes bloquées n'apparaissent pas, même avant que l'hôte ait suivi
    players: g.players.filter((p) => !settings.blocked[p.id]),
    chat: g.chat.filter((m) => !settings.blocked[m.from]),
    host: g.host,
    hostCode: cleanText(g.host?.hostCode, 4),
    videoId: g.sync?.id ?? null,
  };
}

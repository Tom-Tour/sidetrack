// Rejoindre le salon de quelqu'un depuis l'extension : même protocole que la page join/,
// mais le chat et l'état du salon s'affichent dans la barre latérale, et la vidéo de
// l'hôte passe par notre propre lecteur (l'onglet masqué), recalé sur sa position.
//
// Identité : une clé Nostr gardée dans storage.local, avec sa preuve de travail pour les
// salons publics (calculée une seule fois, en arrière-plan dès le démarrage).

// { code, status: "connecting" | "proof" | "joined" | "ended", tries, endKey, endArgs,
//   peer, conn, me, players, chat, host (dernier état envoyé par l'hôte), sync, latency… }
let guest = null;
let identity = null; // { secret, pubkey }
let proof = null;    // { pubkey, bits, nonce }
let mining = null;   // { bits, promise } : calcul en cours
let playerTick = null; // dernière position annoncée par notre lecteur
let joinSeq = 0;       // seule la dernière demande pour rejoindre compte (double clic…)
const HOST_SILENCE = 30 * 1000; // l'hôte répond à nos pings : au-delà, il est perdu

const GUEST_SEND_PER_SECOND = 2; // ce que l'hôte accepte sans filtrer (voir RECV_PER_SECOND)
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

async function loadIdentity() {
  const s = await browser.storage.local.get(["identity", "pow"]);
  let secret = s.identity;
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) {
    secret = hex(NostrTools.generateSecretKey());
    browser.storage.local.set({ identity: secret });
  }
  identity = { secret: unhex(secret), pubkey: NostrTools.getPublicKey(unhex(secret)) };
  proof = s.pow?.pubkey === identity.pubkey && Number.isSafeInteger(s.pow.nonce) ? s.pow : null;
}

const identityReady = loadIdentity();

// Preuve de travail d'au moins `bits` bits pour notre identité (pow-worker.js)
function mine(bits) {
  if (mining && mining.bits >= bits) return mining.promise;
  const worker = new Worker("pow-worker.js");
  const job = { bits };
  job.promise = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.t === "progress") {
        if (guest?.status === "proof" && data.tries % 5 === 0) {
          guest.tries = data.tries;
          update();
        }
        return;
      }
      worker.terminate();
      if (mining === job) mining = null;
      proof = { pubkey: identity.pubkey, bits, nonce: data.nonce };
      browser.storage.local.set({ pow: proof });
      resolve(data.nonce);
    };
    worker.onerror = (e) => {
      worker.terminate();
      if (mining === job) mining = null;
      reject(e);
    };
  });
  worker.postMessage({ t: "mine", pubkey: identity.pubkey, bits });
  mining = job;
  return job.promise;
}

// Calcul fait une fois pour toutes en arrière-plan : rejoindre un salon public est ensuite immédiat
identityReady.then(() => {
  if (proof && proof.bits >= POW_BITS) return;
  setTimeout(() => {
    try {
      mine(POW_BITS).catch(() => {});
    } catch {
      // pas de Worker : le calcul se fera à la demande
    }
  }, 5000);
});

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
  await identityReady;
  if (seq !== joinSeq || room) return;
  // Notre propre musique et notre partie laissent la place au salon
  resetGame();
  send({ action: "pause" });
  guest = {
    code,
    status: "connecting",
    tries: 0,
    endKey: null,
    endArgs: [],
    peer: null,
    conn: null,
    me: null,
    players: [],
    chat: [],
    secrets: [], // mes propositions masquées, pour les afficher chez moi
    host: null,
    sync: null,
    latency: 0,
    sendTimes: [],
    loading: null,
    pingTimer: null,
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
      if (guest === g && g.conn === conn && g.status !== "ended" && g.status !== "proof") endGuest(g, "guestDisconnected");
    });
  });
  peer.on("error", (e) => {
    if (guest !== g || g.peer !== peer || g.status === "ended") return;
    endGuest(g, e.type === "peer-unavailable" ? "guestNotFound" : "guestCantConnect", e.type);
  });
}

// Réponse au défi : signée par notre identité, pour ce salon et ce défi précis
async function answerChallenge(g, msg) {
  const bits = Math.max(0, Math.floor(Number(msg.pow) || 0));
  if (bits && !(proof && proof.bits >= bits)) {
    // Preuve pas encore prête : on ne fait pas attendre l'hôte, on revient quand elle l'est
    g.status = "proof";
    g.powBits = bits;
    g.conn = null;
    g.peer.destroy();
    update();
    try {
      await mine(bits);
    } catch {
      return endGuest(g, "guestCantConnect", "pow");
    }
    if (guest !== g) return;
    g.status = "connecting";
    update();
    return connectGuest(g);
  }
  const ev = NostrTools.finalizeEvent(
    {
      kind: HELLO_KIND,
      created_at: nowSeconds(),
      tags: [["room", String(msg.room)], ["challenge", String(msg.c)], ["pow", String(bits ? proof.nonce : 0)]],
      content: "",
    },
    identity.secret
  );
  safeSend(g.conn, { t: "hello", name: state.nickname || t("defaultGuest"), ev });
}

// Fin de notre présence (salon fermé, exclusion, connexion perdue) : le panneau garde la raison
function endGuest(g, key, ...args) {
  g.status = "ended";
  g.endKey = key;
  g.endArgs = args;
  clearInterval(g.pingTimer);
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
  clearInterval(g.pingTimer);
  setTimeout(() => g.peer?.destroy(), 300);
  send({ action: "pause" });
  update();
}

// --- Messages de l'hôte ------------------------------------------------------

function onHostData(g, msg) {
  if (!msg || typeof msg !== "object") return;
  g.heard = Date.now();
  switch (msg.t) {
    case "welcome":
      g.status = "joined";
      g.me = msg.you;
      g.chat = Array.isArray(msg.chat) ? msg.chat : [];
      log(t("logJoined", g.code));
      clearInterval(g.pingTimer);
      g.heard = Date.now();
      g.pingTimer = setInterval(() => {
        if (Date.now() - g.heard > HOST_SILENCE) return endGuest(g, "guestDisconnected");
        safeSend(g.conn, { t: "ping", at: performance.now() });
      }, 5000);
      safeSend(g.conn, { t: "ping", at: performance.now() });
      break;
    case "state":
      g.host = msg;
      g.players = Array.isArray(msg.players) ? msg.players : [];
      break;
    case "chat":
      if (msg.msg.masked && msg.msg.from === g.me) msg.msg.mine = g.secrets.shift();
      g.chat.push(msg.msg);
      if (g.chat.length > 300) g.chat.shift();
      break;
    case "chatUpdate": {
      const i = g.chat.findIndex((m) => m.id === msg.msg.id);
      if (i >= 0) g.chat[i] = msg.msg;
      break;
    }
    case "sync":
      g.sync = { ...msg, at: Date.now() };
      followHost(g);
      break;
    case "pong":
      g.latency = (performance.now() - msg.at) / 2000;
      return;
    // Fin du salon, refus ou sanction de l'hôte
    case "closed":
    case "full":
    case "kicked":
    case "banned":
      return endGuest(g, `guest${msg.t[0].toUpperCase()}${msg.t.slice(1)}`);
    case "muted":
      notice = { key: "guestMuted" };
      break;
    default:
      return;
  }
  update();
}

// --- Lecture recalée sur l'hôte ------------------------------------------------

function guestTick(msg) {
  if (msg.id) playerTick = { id: msg.id, time: msg.time, state: msg.state, at: Date.now() };
}

// Même vidéo, même moment (tolérance 1,5 s), même lecture ou pause que l'hôte
function followHost(g) {
  const s = g.sync;
  if (!s?.id || g.status !== "joined") return;
  const target = s.time + (s.playing ? (Date.now() - s.at) / 1000 + g.latency : 0);
  const here = playerPort && playerTick?.id === s.id && Date.now() - playerTick.at < 3000 ? playerTick : null;
  if (!here) {
    // Autre vidéo, ou lecteur pas encore ouvert : on charge celle de l'hôte quand il joue
    if (s.playing && (g.loading?.id !== s.id || Date.now() - g.loading.at > 8000)) {
      g.loading = { id: s.id, at: Date.now() };
      send({ action: "load", id: s.id, start: target, volume: state.volume });
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
  if (!rateOk(g.sendTimes, GUEST_SEND_PER_SECOND)) {
    notice = { key: "guestTooFast" };
    update();
    return false;
  }
  safeSend(g.conn, msg);
  return true;
}

function guestChat(text, secret = true) {
  text = cleanText(text, TEXT_MAX);
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
    tries: g.tries,
    powBits: g.powBits ?? 0,
    endKey: g.endKey,
    endArgs: g.endArgs,
    me: g.me,
    players: g.players,
    chat: g.chat,
    host: g.host,
    videoId: g.sync?.id ?? null,
  };
}

// Page des invités d'un salon Sidetrack : connexion en pair-à-pair à l'hôte (PeerJS),
// lecteur YouTube recalé sur celui de l'hôte, playlist et chat.
//
// Mêmes outils que l'extension (copie du kit commun dans ../common/) : traductions
// (i18n-core.js), limites, nettoyage et poignée de main signée (net.js), preuve de travail
// et code d'identité (pow.js, même sel « sidetrack » que l'extension).
const ROOM_PREFIX = "sidetrack-room-";
const $ = (s) => document.querySelector(s);

// --- Traductions -------------------------------------------------------------
// Textes propres à cette page ; les termes communs (Rejoindre, Envoyer, Pseudo, Ton code…)
// viennent de i18n-core.js.

const STRINGS = {
  fr: {
    intro: "Rejoindre le salon pour écouter ou jouer au blind test ensemble.",
    roomName: "Nom du salon",
    volume: "Volume",
    shareMoment: "📍 Partager ce moment",
    shareMomentTitle: "Envoyer ce moment de la vidéo dans le chat",
    hostPlaylist: "Playlist de l'hôte",
    hostPlaylistHelp: "· un clic pour proposer dans le chat",
    chatPlaceholder: "Message (ou réponse en blind test)",
    players: "{0} joueur(s)",
    waiting: "En attente d'une vidéo…",
    chapters: "Chapitres",
    proposeVideoTitle: "Proposer cette vidéo dans le chat",
    proposeChapterTitle: "Proposer ce chapitre dans le chat",
    video: "vidéo",
    host: "Hôte",
    yourGuess: "🔒 Réponse cachée : {0}",
    someoneGuessed: "🔒 {0} a proposé une réponse",
    timeUp: "Temps écoulé",
    round: "Manche {0}/{1}",
    blindIdle: "En attente du lancement de la partie par l'hôte…",
    blindLoading: "La partie va commencer…",
    blindPlaying: "Morceau mystère : réponses dans le chat !",
    blindTimeup: "Temps écoulé !",
    blindRevealed: "Réponse : {0}",
    blindOver: "Partie terminée",
    found: "✓ Trouvé",
    missed: "✗ Raté",
    nextIn: "suite dans {0} s",
    hintMax: "max {0} pts",
    secretOnTitle: "Réponse cachée jusqu'à la révélation (un clic pour écrire en clair)",
    secretOffTitle: "Message visible par tous (un clic pour cacher la réponse)",
    sysJoined: "{0} a rejoint le salon",
    sysLeft: "{0} est parti",
    sysPointPlus: "+{0} pour {1} (total {2})",
    sysPointMinus: "{0} pour {1} (total {2})",
    sysKicked: "{0} a été exclu du salon",
    sysBanned: "{0} a été banni",
    sysNobody: "Personne n'a trouvé cette fois",
    errNotFound: "Salon introuvable : nom à vérifier, ou salon fermé par l'hôte.",
    errCantConnect: "Connexion impossible ({0}).",
    errDisconnected: "Déconnecté de l'hôte",
    errClosed: "L'hôte a fermé le salon",
    errFull: "Ce salon est complet (24 joueurs).",
    errKicked: "Exclu du salon par l'hôte.",
    errBanned: "Banni des salons de cet hôte.",
    noticeMuted: "Trop de messages : en sourdine pendant 1 minute.",
  },
  en: {
    intro: "Join the room to listen or play blind test together.",
    roomName: "Room name",
    volume: "Volume",
    shareMoment: "📍 Share this moment",
    shareMomentTitle: "Send this moment of the video to the chat",
    hostPlaylist: "Host's playlist",
    hostPlaylistHelp: "· click to suggest it in the chat",
    chatPlaceholder: "Type here (your answer in blind test)",
    players: "{0} player(s)",
    waiting: "Waiting for a video…",
    chapters: "Chapters",
    proposeVideoTitle: "Suggest this video in the chat",
    proposeChapterTitle: "Suggest this chapter in the chat",
    video: "video",
    host: "Host",
    yourGuess: "🔒 Your answer: {0}",
    someoneGuessed: "🔒 {0} made a guess",
    timeUp: "Time's up",
    round: "Round {0}/{1}",
    blindIdle: "Waiting for the host to start the game…",
    blindLoading: "The game is about to start…",
    blindPlaying: "Mystery track: type your answer in the chat!",
    blindTimeup: "Time's up!",
    blindRevealed: "Answer: {0}",
    blindOver: "Game over",
    found: "✓ Got it",
    missed: "✗ Missed",
    nextIn: "next in {0} s",
    hintMax: "max {0} pts",
    secretOnTitle: "Answer hidden until the reveal (click to write in the open)",
    secretOffTitle: "Message visible to everyone (click to hide your answer)",
    sysJoined: "{0} joined the room",
    sysLeft: "{0} left",
    sysPointPlus: "+{0} for {1} (total {2})",
    sysPointMinus: "{0} for {1} (total {2})",
    sysKicked: "{0} was kicked from the room",
    sysBanned: "{0} was banned",
    sysNobody: "Nobody got it this time",
    errNotFound: "Room not found: check the name, or the host closed the room.",
    errCantConnect: "Can't connect ({0}).",
    errDisconnected: "Disconnected from the host",
    errClosed: "The host closed the room",
    errFull: "This room is full (24 players).",
    errKicked: "The host kicked you from the room.",
    errBanned: "The host banned you from their rooms.",
    noticeMuted: "Too many messages: you're muted for 1 minute.",
  },
};

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null; // stockage indisponible (navigation privée stricte…) : identité le temps de la page
  }
}

setLang(store("sidetrack-lang") ?? "auto");

function translate() {
  applyI18n();
  for (const b of document.querySelectorAll("#langs button")) b.classList.toggle("on", b.dataset.lang === LANG);
}

for (const b of document.querySelectorAll("#langs button")) {
  b.addEventListener("click", () => {
    setLang(b.dataset.lang);
    store("sidetrack-lang", b.dataset.lang);
    translate();
    renderIdentity();
    if (room) render();
    renderChat();
  });
}
translate();

// --- État ----------------------------------------------------------------------

let peer = null;
let conn = null;
let me = null;
let room = null;       // dernier état envoyé par l'hôte
let lastSync = null;   // { id, time, playing } : position de l'hôte
let latency = 0;       // demi-aller-retour vers l'hôte, en secondes
let joined = false;
let ended = false;     // l'hôte a mis fin à notre présence (et dit pourquoi)
let heard = 0;         // dernier message de l'hôte (battement de cœur)
let apiReady = false;
let player = null;
let playerReady = false;
let chat = [];         // messages dans l'ordre d'arrivée
const mySecrets = [];  // mes propositions masquées, pour les afficher chez moi
const expanded = new Set();

// --- Identité --------------------------------------------------------------------
// Une clé Nostr gardée dans ce navigateur : elle signe le défi de l'hôte à chaque connexion,
// si bien que personne ne peut se faire passer pour toi, et que l'hôte peut exclure ou
// bannir une identité. Elle s'accompagne d'une preuve de travail, calculée une seule fois
// puis gardée, qui donne ton code de 4 caractères.

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
// Version à incrémenter avec le kit (cache de GitHub Pages)
const pow = createPow({ app: "sidetrack", worker: "../common/pow-worker.js?v=3" });

let secret = store("sidetrack-identity");
if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) {
  secret = hex(NostrTools.generateSecretKey());
  store("sidetrack-identity", secret);
}
const identity = { secret: unhex(secret), pubkey: NostrTools.getPublicKey(unhex(secret)), pow: null, code: "" };

let mining = null;      // { tries } pendant le calcul
let powWaiting = false; // l'invité attend la fin du calcul pour entrer
let proofReady = null;  // Promise de la preuve

function proofDone(nonce, code) {
  identity.pow = nonce;
  identity.code = code;
  mining = null;
  store("sidetrack-pow-v2", { v: POW.VERSION, pubkey: identity.pubkey, nonce, code });
  renderIdentity();
}

// Calcul lancé dès l'ouverture de la page, en arrière-plan : le temps de taper son pseudo,
// il est souvent déjà fini quand on rejoint le salon
function prepareProof() {
  const saved = store("sidetrack-pow-v2");
  if (saved?.pubkey === identity.pubkey && Number.isSafeInteger(saved.nonce)) {
    if (saved.v === POW.VERSION && typeof saved.code === "string") {
      proofDone(saved.nonce, saved.code);
      return Promise.resolve();
    }
    // Preuve d'avant le kit commun : même calcul, une vérification redonne le code
    return pow.check(identity.pubkey, saved.nonce).then(({ bits, code }) => {
      if (bits >= POW.BITS) return proofDone(saved.nonce, code);
      return mineProof();
    });
  }
  return mineProof();
}

function mineProof() {
  mining = { tries: 0 };
  return pow
    .mine(identity.pubkey, POW.BITS, (tries) => {
      mining.tries = tries;
      if (powWaiting) powProgress();
    })
    .then(({ nonce, code }) => proofDone(nonce, code));
}

try {
  proofReady = prepareProof();
} catch {
  proofReady = Promise.reject(new Error("pow")); // pas de Worker
}
proofReady.catch(() => {});

// Nombre d'essais imprévisible (en moyenne 2^bits) : la barre avance vite puis ralentit
function powProgress() {
  const share = 1 - Math.exp((-2 * (mining?.tries ?? 0)) / 2 ** POW.BITS);
  loginStatus(t("identityMining", Math.round(100 * share)));
  const bar = $("#pow-progress");
  bar.hidden = false;
  bar.value = share;
}

// Attend la preuve de travail, en affichant la progression
async function waitProof() {
  powWaiting = true;
  powProgress();
  try {
    await proofReady;
  } finally {
    powWaiting = false;
    $("#pow-progress").hidden = true;
  }
}

function renderIdentity() {
  for (const e of document.querySelectorAll(".my-code")) e.textContent = identity.code || "…";
}
renderIdentity();

// Réponse au défi : signée par notre identité, pour ce salon et ce défi précis
async function answerChallenge(msg, code, name) {
  if (identity.pow == null) {
    // Preuve pas encore prête : on ne fait pas attendre l'hôte, on revient quand elle l'est
    peer?.destroy();
    try {
      await waitProof();
    } catch {
      return loginError(t("errCantConnect", "pow"));
    }
    return join(code, name);
  }
  const tags = [["room", String(msg.room)], ["challenge", String(msg.c)], ["pow", String(identity.pow)]];
  safeSend(conn, { t: "hello", name, ev: signHello(identity.secret, tags) });
}

// La page n'envoie jamais plus que ce que l'hôte accepte
const sendTimes = [];

// --- Connexion ---------------------------------------------------------------

// Nom de salon = identifiant : même règle que l'extension (minuscules, sans accents, espaces → tirets)
function roomName(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

$("#code").value = decodeURIComponent(location.hash.slice(1));
$("#name").value = store("sidetrack-name") ?? "";
if ($("#code").value) $("#name").focus();

$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = roomName($("#code").value);
  const name = cleanName($("#name").value, "");
  if (!code || !name) return;
  store("sidetrack-name", name);
  join(code, name);
});

// Progression affichée pendant la connexion (preuve de travail)
function loginStatus(text) {
  $("#login-form button").textContent = text;
}

// text : message d'erreur, ou null pendant la connexion
function loginError(text) {
  $("#login-error").textContent = text;
  $("#login-error").hidden = !text;
  const btn = $("#login-form button");
  btn.disabled = !text;
  btn.textContent = text ? t("join") : t("connecting");
}

function join(code, name) {
  if (joined) return; // déjà dans le salon : pas de seconde connexion
  loginError(null);
  peer?.destroy();
  peer = new Peer();
  peer.on("open", () => {
    conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: "json" });
    // L'hôte commence par un défi : on y répond (voir onData)
    conn.on("data", (msg) => (msg?.t === "challenge" ? answerChallenge(msg, code, name) : onData(msg)));
    // Fermeture qui suit un message de l'hôte (salon fermé, exclusion…) : on garde ce message
    conn.on("close", () => ended || powWaiting || setStatus(t("errDisconnected")));
  });
  peer.on("error", (e) => {
    const text = e.type === "peer-unavailable" ? t("errNotFound") : t("errCantConnect", e.type);
    if (joined) setStatus(text);
    else loginError(text);
  });
}

function setStatus(text) {
  $("#room-status").textContent = text;
}

// --- Messages de l'hôte ------------------------------------------------------

// Ce que l'hôte nous dit des autres est revérifié ici (formes, longueurs, couleurs)
function cleanMsg(m) {
  if (!m || typeof m !== "object") return null;
  return {
    ...m,
    name: cleanName(m.name, ""),
    code: cleanText(m.code, 4),
    color: m.color ? cleanColor(m.color) : undefined,
    text: m.text == null ? undefined : cleanText(m.text),
  };
}

function onData(msg) {
  if (!msg || typeof msg !== "object") return;
  heard = Date.now(); // toute donnée reçue compte comme signe de vie
  switch (msg.t) {
    case "welcome":
      joined = true;
      me = msg.you;
      $("#login").hidden = true;
      $("#room").hidden = false;
      $("#room-code").textContent = msg.code;
      history.replaceState(null, "", `#${msg.code}`);
      chat = (Array.isArray(msg.chat) ? msg.chat : []).map(cleanMsg).filter(Boolean);
      renderChat();
      createPlayer();
      // Battement de cœur : un ping toutes les 5 s ; plus rien de l'hôte depuis 30 s, on est perdu
      setInterval(() => {
        if (!ended && Date.now() - heard > HEARTBEAT.SILENCE) setStatus(t("errDisconnected"));
        safeSend(conn, { t: "ping", at: performance.now() });
      }, HEARTBEAT.EVERY);
      safeSend(conn, { t: "ping", at: performance.now() });
      break;
    case "state":
      room = msg;
      room.players = (Array.isArray(msg.players) ? msg.players : []).map(cleanMsg).filter(Boolean);
      render();
      break;
    case "chat": {
      const m = cleanMsg(msg.msg);
      if (!m) return;
      if (m.masked && m.from === me) m.mine = mySecrets.shift();
      if (document.hidden && !m.system && m.from !== me) document.title = `(${++unseen}) Sidetrack`;
      chat.push(m);
      if (chat.length > 300) chat.shift();
      renderChat();
      break;
    }
    case "chatUpdate": {
      const m = cleanMsg(msg.msg);
      const i = m ? chat.findIndex((x) => x.id === m.id) : -1;
      if (i >= 0) chat[i] = m;
      renderChat();
      break;
    }
    // Un joueur banni : ses messages disparaissent
    case "chatRemove":
      chat = chat.filter((m) => m.from !== msg.from);
      renderChat();
      break;
    case "sync":
      lastSync = msg;
      applySync();
      break;
    case "pong":
      latency = (performance.now() - msg.at) / 2000;
      break;
    // Fin du salon, refus ou sanction de l'hôte
    case "closed":
    case "full":
    case "kicked":
    case "banned": {
      ended = true;
      const text = t(`err${msg.t[0].toUpperCase()}${msg.t.slice(1)}`);
      if (!joined) return loginError(text);
      setStatus(text);
      $("#chat-input").disabled = true;
      player?.pauseVideo?.();
      break;
    }
    case "muted":
      flash(t("noticeMuted"));
      break;
  }
}

// --- Lecteur -----------------------------------------------------------------

window.onYouTubeIframeAPIReady = () => {
  apiReady = true;
  createPlayer();
};

function createPlayer() {
  if (!apiReady || !joined || player) return;
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { autoplay: 1, playsinline: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        player.setVolume(Number($("#volume").value));
        applySync();
      },
    },
  });
}

// Recale le lecteur sur la position de l'hôte (tolérance 1,5 s)
function applySync() {
  if (!playerReady || !lastSync || !/^[\w-]{11}$/.test(lastSync.id ?? "")) return;
  const { id, playing } = lastSync;
  const target = Number(lastSync.time) + (playing ? latency : 0);
  if (player.getVideoData()?.video_id !== id) {
    if (playing) player.loadVideoById({ videoId: id, startSeconds: target });
    else player.cueVideoById({ videoId: id, startSeconds: target });
    return;
  }
  if (Math.abs(player.getCurrentTime() - target) > 1.5) player.seekTo(target, true);
  const state = player.getPlayerState();
  if (playing && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) player.playVideo();
  if (!playing && state === YT.PlayerState.PLAYING) player.pauseVideo();
}

$("#volume").addEventListener("input", (e) => {
  if (playerReady) player.setVolume(Number(e.target.value));
});

// --- Chat --------------------------------------------------------------------

function sendRef(ref, text = "") {
  if (!rateOk(sendTimes, LIMITS.SEND_PER_SECOND)) return flash(t("errTooFast", LIMITS.SEND_PER_SECOND));
  safeSend(conn, { t: "chat", text, ref });
}

// Message bref sous le chat (débit, sourdine)
let flashTimer = null;
function flash(text) {
  $("#chat-note").textContent = text;
  $("#chat-note").hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($("#chat-note").hidden = true), 4000);
}

// Chacun se juge : « Trouvé » ou « Raté », une fois par manche
let claimedRound = 0;
for (const [id, found] of [["#claim-found", true], ["#claim-missed", false]]) {
  $(id).addEventListener("click", () => {
    claimedRound = room?.blind?.round ?? 0;
    safeSend(conn, { t: "claim", found });
    render();
  });
}

// En blind test, chacun choisit d'écrire sa réponse cachée (par défaut) ou en clair
let secretGuess = true;
$("#chat-secret").addEventListener("click", () => {
  secretGuess = !secretGuess;
  renderSecret();
});

function renderSecret() {
  const b = $("#chat-secret");
  b.hidden = !room?.blind;
  b.textContent = secretGuess ? "🔒" : "💬";
  b.title = t(secretGuess ? "secretOnTitle" : "secretOffTitle");
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = cleanText($("#chat-input").value);
  if (!text) return;
  if (!rateOk(sendTimes, LIMITS.SEND_PER_SECOND)) return flash(t("errTooFast", LIMITS.SEND_PER_SECOND));
  // Réponse cachée pendant une manche : masquée pour les autres, on la garde pour soi
  if (secretGuess && room?.blind && ["playing", "timeup"].includes(room.blind.phase)) mySecrets.push(text);
  safeSend(conn, { t: "chat", text, secret: secretGuess });
  $("#chat-input").value = "";
});

$("#share-moment").addEventListener("click", () => {
  if (!lastSync || !playerReady) return;
  sendRef({ id: lastSync.id, start: Math.floor(player.getCurrentTime()), label: room?.title ?? "" });
});

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function formatTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// « Nom · CODE » : le code distingue deux personnes qui ont le même nom
const label = (name, code) => (code ? `${name} · ${code}` : name);

// Messages arrivés pendant que l'onglet était en arrière-plan : comptés dans le titre
let unseen = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  unseen = 0;
  document.title = "Sidetrack";
});

function renderChat() {
  const box = $("#chat");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.replaceChildren(
    ...chat.map((msg) => {
      // Messages système : clés traduites ici, dans la langue de l'invité
      if (msg.system) return el("p", msg.key ? t(msg.key, ...(Array.isArray(msg.args) ? msg.args : [])) : "", "system");
      const who = msg.from === "host" ? t("host") : msg.name;
      if (msg.masked) {
        return msg.mine ? el("p", t("yourGuess", msg.mine), "masked") : el("p", t("someoneGuessed", who), "masked");
      }
      const p = el("p");
      const name = p.appendChild(el("b", `${who} : `));
      name.title = label(who, msg.code);
      if (msg.color) name.style.color = msg.color;
      p.append(msg.text ?? "");
      if (msg.ref) {
        p.append(el("span", `▶ ${cleanText(msg.ref.label, 120) || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`, "pill ref"));
      }
      return p;
    })
  );
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// --- Affichage ---------------------------------------------------------------

function renderQueue() {
  $("#queue").replaceChildren(
    ...room.playlist.map((item, i) => {
      const li = el("li", null, i === room.index ? "current" : "");
      const row = li.appendChild(el("div", null, "row"));
      if (item.chapters?.length) {
        const open = expanded.has(item.id);
        const toggle = row.appendChild(el("button", open ? "▾" : "▸"));
        toggle.title = t("chapters");
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          renderQueue();
        });
        if (open) {
          const list = li.appendChild(el("ul", null, "chapters"));
          for (const c of item.chapters) {
            const crow = list.appendChild(el("li")).appendChild(el("div", null, "row"));
            crow.append(el("time", formatTime(c.start)), el("span", c.title));
            crow.title = t("proposeChapterTitle");
            crow.addEventListener("click", () => sendRef({ id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      const title = row.appendChild(el("span", item.title));
      row.title = t("proposeVideoTitle");
      title.title = item.title;
      row.addEventListener("click", () => sendRef({ id: item.id, start: 0, label: item.title }));
      return li;
    })
  );
}

// Pastille d'une personne : couleur, nom, code d'identité, score
function chip(p, { me: mine = false, score = null } = {}) {
  const li = el("li", null, mine ? "me" : "");
  const name = li.appendChild(el("span", p.name));
  if (p.color) name.style.color = p.color;
  li.append(" ", el("span", p.code || "…", "code"));
  if (score != null) li.append(el("b", String(score)));
  return li;
}

function render() {
  renderSecret();
  // L'hôte joue lui aussi : son score avec les nôtres
  const host = room.hostScore != null ? [chip({ name: t("host"), code: cleanText(room.hostCode, 4) }, { score: room.hostScore })] : [];
  $("#players").replaceChildren(
    ...host,
    ...room.players.map((p) => chip(p, { me: p.id === me, score: room.blind ? p.score : null }))
  );
  setStatus(t("players", room.players.length));

  const blind = room.blind;
  $("#playlist").hidden = !!blind;
  $("#share-moment").hidden = !!blind;
  $("#blind-status").hidden = !blind;

  if (!blind) {
    $("#mask").hidden = true;
    $("#hint").hidden = true;
    $("#now").textContent = room.title ?? t("waiting");
    renderQueue();
    return;
  }

  // Blind test : vidéo masquée tant que la réponse n'est pas révélée
  $("#mask").hidden = !blind.hideVideo || blind.phase === "revealed";
  $("#mask-time").textContent =
    blind.phase === "timeup" ? t("timeUp") : blind.phase === "playing" && blind.clip ? formatTime(blind.remaining) : "";
  $("#now").textContent = {
    idle: t("blindIdle"),
    loading: t("blindLoading"),
    playing: t("blindPlaying"),
    timeup: t("blindTimeup"),
    revealed: t("blindRevealed", blind.answer ?? "?") + (blind.nextIn ? ` · ${t("nextIn", blind.nextIn)}` : ""),
    over: t("blindOver"),
  }[blind.phase];
  $("#blind-status").textContent = blind.total && blind.phase !== "idle" ? t("round", blind.round, blind.total) : "";
  // Indice façon pendu : le titre se dévoile peu à peu, le maximum de points baisse
  $("#hint").hidden = !blind.hint;
  if (blind.hint) {
    $("#hint-mask").textContent = blind.hint;
    $("#hint-max").textContent = t("hintMax", blind.maxPts);
  }
  // Chacun se juge : une réponse par manche, après la révélation
  $("#claim").hidden = !(blind.claim && blind.phase === "revealed");
  $("#claim-found").disabled = $("#claim-missed").disabled = claimedRound === blind.round;
}

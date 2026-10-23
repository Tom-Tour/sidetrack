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

// Textes : ceux de Sidetrack (../i18n.js, chargé avant) et du kit commun. Ici, seulement
// ceux propres à cette page (sa mise en page diffère de la barre latérale).
Object.assign(STRINGS.fr, {
  intro: "Rejoindre le salon pour écouter ou jouer au blind test ensemble.",
  hostPlaylist: "Playlist de l'hôte",
  hostPlaylistHelp: "· un clic pour proposer dans le chat",
  chatPlaceholder: "Message (ou réponse en blind test)",
  proposeVideoTitle: "Proposer cette vidéo dans le chat",
  proposeChapterTitle: "Proposer ce chapitre dans le chat",
});
Object.assign(STRINGS.en, {
  intro: "Join the room to listen or play blind test together.",
  hostPlaylist: "Host's playlist",
  hostPlaylistHelp: "· click to suggest it in the chat",
  chatPlaceholder: "Type here (your answer in blind test)",
  proposeVideoTitle: "Suggest this video in the chat",
  proposeChapterTitle: "Suggest this chapter in the chat",
});

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

// Version à incrémenter avec le kit (cache de GitHub Pages)
const pow = createPow({ app: "sidetrack", worker: "../common/pow-worker.js?v=4" });
const myIdentity = createIdentity({
  pow,
  read: async () => ({ secret: store("sidetrack-identity"), proof: store("sidetrack-pow-v2") }),
  write: async ({ secret, proof }) => (secret ? store("sidetrack-identity", secret) : store("sidetrack-pow-v2", proof)),
  onChange: () => {
    renderIdentity();
    if (powWaiting) powProgress();
  },
});
const identity = myIdentity.identity; // { secret, pubkey, pow, code } : rempli par le kit
let powWaiting = false; // l'invité attend la fin du calcul pour entrer

// Calcul lancé dès l'ouverture de la page, en arrière-plan : le temps de taper son pseudo,
// il est souvent déjà fini quand on rejoint le salon
const proofReady = myIdentity.load().then(() => myIdentity.ready());
proofReady.catch(() => {});

function powProgress() {
  const pct = myIdentity.mining ? powPercent(myIdentity.mining.tries) : 0;
  loginStatus(t("identityMining", pct));
  const bar = $("#pow-progress");
  bar.hidden = false;
  bar.value = pct / 100;
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
      return loginError(t("identityFailed"));
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
// Pseudo proposé comme dans l'extension (« Invité-1234 »), sélectionné pour être remplacé d'un geste
$("#name").value = store("sidetrack-name") ?? proposedName();
if ($("#code").value) $("#name").select();

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
    at: Number.isFinite(m.at) ? m.at : undefined, // heure d'envoi chez l'hôte (ms)
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
      const p = chatLine(msg);
      // Heure d'envoi (HH:MM), donnée par l'hôte, comme dans la barre latérale
      if (Number.isFinite(msg.at)) {
        const date = new Date(msg.at);
        p.prepend(el("time", { textContent: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), dateTime: date.toISOString() }));
      }
      return p;
    })
  );
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// Contenu d'une ligne (sans l'heure)
function chatLine(msg) {
  // Messages système : clés traduites ici, dans la langue de l'invité
  if (msg.system) return el("p", { textContent: msg.key ? t(msg.key, ...(Array.isArray(msg.args) ? msg.args : [])) : "", className: "system" });
  const who = msg.from === "host" ? t("host") : msg.name;
  if (msg.masked) {
    return msg.mine ? el("p", { textContent: t("yourGuess", msg.mine), className: "masked" }) : el("p", { textContent: t("someoneGuessed", who), className: "masked" });
  }
  const p = el("p");
  const name = p.appendChild(el("b", { textContent: `${who} : ` }));
  name.title = label(who, msg.code);
  if (msg.color) name.style.color = msg.color;
  p.append(msg.text ?? "");
  if (msg.ref) {
    p.append(el("span", { textContent: `▶ ${cleanText(msg.ref.label, 120) || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`, className: "pill ref" }));
  }
  return p;
}

// --- Affichage ---------------------------------------------------------------

function renderQueue() {
  $("#queue").replaceChildren(
    ...room.playlist.map((item, i) => {
      const li = el("li", { className: i === room.index ? "current" : "" });
      const row = li.appendChild(el("div", { className: "row" }));
      if (item.chapters?.length) {
        const open = expanded.has(item.id);
        const toggle = row.appendChild(el("button", { textContent: open ? "▾" : "▸" }));
        toggle.title = t("chapters");
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          renderQueue();
        });
        if (open) {
          const list = li.appendChild(el("ul", { className: "chapters" }));
          for (const c of item.chapters) {
            const crow = list.appendChild(el("li")).appendChild(el("div", { className: "row" }));
            crow.append(el("time", { textContent: formatTime(c.start) }), el("span", { textContent: c.title }));
            crow.title = t("proposeChapterTitle");
            crow.addEventListener("click", () => sendRef({ id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      const title = row.appendChild(el("span", { textContent: item.title }));
      row.title = t("proposeVideoTitle");
      title.title = item.title;
      row.addEventListener("click", () => sendRef({ id: item.id, start: 0, label: item.title }));
      return li;
    })
  );
}

// Pastille d'une personne : couleur, nom, code d'identité, score
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
    $("#now").textContent = room.title ?? t("guestWaiting");
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
    timeup: t("timeUpBang"),
    revealed: t("blindRevealed", blind.answer ?? "?") + (blind.nextIn ? ` · ${t("nextIn", blind.nextIn)}` : ""),
    over: t("gameOver"),
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

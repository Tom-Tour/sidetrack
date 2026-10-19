// Page des invités d'un salon Sidetrack : connexion en pair-à-pair à l'hôte (PeerJS),
// lecteur YouTube recalé sur celui de l'hôte, playlist et chat.
const ROOM_PREFIX = "sidetrack-room-";
const $ = (s) => document.querySelector(s);

// --- Traductions -------------------------------------------------------------

const STRINGS = {
  fr: {
    intro: "Rejoins le salon pour écouter ou jouer au blind test ensemble.",
    codeLabel: "Nom du salon",
    nameLabel: "Ton pseudo",
    joinButton: "Rejoindre",
    connecting: "Connexion…",
    notFound: "Salon introuvable : vérifie le nom, ou l'hôte a fermé le salon.",
    cantConnect: "Connexion impossible ({0}).",
    room: "Salon",
    volume: "Volume",
    shareMoment: "📍 Partager ce moment",
    shareMomentHelp: "Envoyer ce moment de la vidéo dans le chat",
    hostPlaylist: "Playlist de l'hôte",
    hostPlaylistHelp: "· clique pour proposer dans le chat",
    chatPlaceholder: "Écris ici (ta réponse en blind test)",
    send: "Envoyer",
    disconnected: "Déconnecté de l'hôte",
    closed: "L'hôte a fermé le salon",
    players: "{0} joueur(s)",
    waiting: "En attente d'une vidéo…",
    chapters: "Chapitres",
    proposeVideo: "Proposer cette vidéo dans le chat",
    proposeChapter: "Proposer ce chapitre dans le chat",
    video: "vidéo",
    host: "Hôte",
    yourGuess: "🔒 Ta réponse : {0}",
    someoneGuessed: "🔒 {0} a proposé une réponse",
    timeUp: "Temps écoulé",
    round: "Manche {0}/{1}",
    blindIdle: "En attente de la partie…",
    blindLoading: "La partie va commencer…",
    blindPlaying: "Morceau mystère : écris ta réponse dans le chat !",
    blindTimeup: "Temps écoulé !",
    blindRevealed: "Réponse : {0}",
    blindOver: "Partie terminée",
    chatJoined: "{0} a rejoint le salon",
    chatLeft: "{0} est parti",
    chatPointPlus: "+{0} point pour {1} ({2})",
    chatPointMinus: "{0} point pour {1} ({2})",
  },
  en: {
    intro: "Join the room to listen or play blind test together.",
    codeLabel: "Room name",
    nameLabel: "Your nickname",
    joinButton: "Join",
    connecting: "Connecting…",
    notFound: "Room not found: check the name, or the host closed the room.",
    cantConnect: "Can't connect ({0}).",
    room: "Room",
    volume: "Volume",
    shareMoment: "📍 Share this moment",
    shareMomentHelp: "Send this moment of the video to the chat",
    hostPlaylist: "Host's playlist",
    hostPlaylistHelp: "· click to suggest it in the chat",
    chatPlaceholder: "Type here (your answer in blind test)",
    send: "Send",
    disconnected: "Disconnected from the host",
    closed: "The host closed the room",
    players: "{0} player(s)",
    waiting: "Waiting for a video…",
    chapters: "Chapters",
    proposeVideo: "Suggest this video in the chat",
    proposeChapter: "Suggest this chapter in the chat",
    video: "video",
    host: "Host",
    yourGuess: "🔒 Your answer: {0}",
    someoneGuessed: "🔒 {0} made a guess",
    timeUp: "Time's up",
    round: "Round {0}/{1}",
    blindIdle: "Waiting for the game…",
    blindLoading: "The game is about to start…",
    blindPlaying: "Mystery track: type your answer in the chat!",
    blindTimeup: "Time's up!",
    blindRevealed: "Answer: {0}",
    blindOver: "Game over",
    chatJoined: "{0} joined the room",
    chatLeft: "{0} left",
    chatPointPlus: "+{0} point for {1} ({2})",
    chatPointMinus: "{0} point for {1} ({2})",
  },
};

let LANG = "en";
try {
  LANG = localStorage.getItem("sidetrack-lang") ?? "";
} catch {}
if (!STRINGS[LANG]) LANG = navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";

function t(key, ...args) {
  const text = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\d)\}/g, (_, i) => String(args[i] ?? ""));
}

function applyI18n() {
  document.documentElement.lang = LANG;
  for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll("[data-i18n-title]")) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll("[data-i18n-placeholder]")) e.placeholder = t(e.dataset.i18nPlaceholder);
  for (const b of document.querySelectorAll("#langs button")) b.classList.toggle("on", b.dataset.lang === LANG);
}

for (const b of document.querySelectorAll("#langs button")) {
  b.addEventListener("click", () => {
    LANG = b.dataset.lang;
    try {
      localStorage.setItem("sidetrack-lang", LANG);
    } catch {}
    applyI18n();
    if (room) render();
    renderChat();
  });
}
applyI18n();

// --- État ----------------------------------------------------------------------

let peer = null;
let conn = null;
let me = null;
let room = null;       // dernier état envoyé par l'hôte
let lastSync = null;   // { id, time, playing } : position de l'hôte
let latency = 0;       // demi-aller-retour vers l'hôte, en secondes
let joined = false;
let apiReady = false;
let player = null;
let playerReady = false;
const chat = [];       // messages dans l'ordre d'arrivée
const mySecrets = [];  // mes propositions masquées, pour les afficher chez moi
const expanded = new Set();

// --- Connexion ---------------------------------------------------------------

// Nom de salon = identifiant : même règle que l'extension (minuscules, sans accents, espaces → tirets)
function roomName(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

$("#code").value = decodeURIComponent(location.hash.slice(1));
try {
  $("#name").value = localStorage.getItem("sidetrack-name") ?? "";
} catch {}
if ($("#code").value) $("#name").focus();

$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = roomName($("#code").value);
  const name = $("#name").value.trim();
  if (!code || !name) return;
  try {
    localStorage.setItem("sidetrack-name", name);
  } catch {}
  join(code, name);
});

// text : message d'erreur, ou null pendant la connexion
function loginError(text) {
  $("#login-error").textContent = text;
  $("#login-error").hidden = !text;
  const btn = $("#login-form button");
  btn.disabled = !text;
  btn.textContent = text ? t("joinButton") : t("connecting");
}

function join(code, name) {
  loginError(null);
  peer?.destroy();
  peer = new Peer();
  peer.on("open", () => {
    conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: "json" });
    conn.on("open", () => conn.send({ t: "hello", name }));
    conn.on("data", onData);
    conn.on("close", () => setStatus(t("disconnected")));
  });
  peer.on("error", (e) => {
    const text = e.type === "peer-unavailable" ? t("notFound") : t("cantConnect", e.type);
    if (joined) setStatus(text);
    else loginError(text);
  });
}

function setStatus(text) {
  $("#room-status").textContent = text;
}

function send(msg) {
  if (conn?.open) conn.send(msg);
}

// --- Messages de l'hôte ------------------------------------------------------

function onData(msg) {
  switch (msg?.t) {
    case "welcome":
      joined = true;
      me = peer.id;
      $("#login").hidden = true;
      $("#room").hidden = false;
      $("#room-code").textContent = msg.code;
      history.replaceState(null, "", `#${msg.code}`);
      chat.push(...msg.chat);
      renderChat();
      createPlayer();
      setInterval(() => send({ t: "ping", at: performance.now() }), 5000);
      send({ t: "ping", at: performance.now() });
      break;
    case "state":
      room = msg;
      render();
      break;
    case "chat":
      if (msg.msg.masked && msg.msg.from === me) msg.msg.mine = mySecrets.shift();
      chat.push(msg.msg);
      if (chat.length > 300) chat.shift();
      renderChat();
      break;
    case "chatUpdate": {
      const i = chat.findIndex((m) => m.id === msg.msg.id);
      if (i >= 0) chat[i] = msg.msg;
      renderChat();
      break;
    }
    case "sync":
      lastSync = msg;
      applySync();
      break;
    case "pong":
      latency = (performance.now() - msg.at) / 2000;
      break;
    case "closed":
      setStatus(t("closed"));
      $("#chat-input").disabled = true;
      player?.pauseVideo?.();
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
  if (!playerReady || !lastSync) return;
  const { id, playing } = lastSync;
  const target = lastSync.time + (playing ? latency : 0);
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
  send({ t: "chat", text, ref });
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  // En blind test, l'hôte masque la proposition pour les autres : on la garde pour soi
  if (room?.blind && ["playing", "timeup"].includes(room.blind.phase)) mySecrets.push(text);
  send({ t: "chat", text });
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

function renderChat() {
  const box = $("#chat");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.replaceChildren(
    ...chat.map((msg) => {
      // Messages système : clés traduites ici, dans la langue de l'invité
      if (msg.system) return el("p", msg.key ? t(msg.key, ...(msg.args ?? [])) : msg.text ?? "", "system");
      if (msg.masked) {
        return msg.mine ? el("p", t("yourGuess", msg.mine), "masked") : el("p", t("someoneGuessed", msg.name), "masked");
      }
      const p = el("p");
      p.append(el("b", `${msg.from === "host" ? t("host") : msg.name} : `), msg.text ?? "");
      if (msg.ref) {
        p.append(el("span", `▶ ${msg.ref.label || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`, "ref"));
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
            crow.title = t("proposeChapter");
            crow.addEventListener("click", () => sendRef({ id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      const title = row.appendChild(el("span", item.title));
      row.title = t("proposeVideo");
      title.title = item.title;
      row.addEventListener("click", () => sendRef({ id: item.id, start: 0, label: item.title }));
      return li;
    })
  );
}

function render() {
  $("#players").replaceChildren(
    ...room.players.map((p) => {
      const li = el("li", p.name, p.id === me ? "me" : "");
      if (room.blind) li.append(el("b", String(p.score)));
      return li;
    })
  );
  setStatus(t("players", room.players.length));

  const blind = room.blind;
  $("#playlist").hidden = !!blind;
  $("#share-moment").hidden = !!blind;
  $("#blind-status").hidden = !blind;

  if (!blind) {
    $("#mask").hidden = true;
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
    revealed: t("blindRevealed", blind.answer ?? "?"),
    over: t("blindOver"),
  }[blind.phase];
  $("#blind-status").textContent = blind.total && blind.phase !== "idle" ? t("round", blind.round, blind.total) : "";
}

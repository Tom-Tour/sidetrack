// Page des invités d'un salon Sidetrack : connexion en pair-à-pair à l'hôte (PeerJS),
// lecteur YouTube recalé sur celui de l'hôte, playlist et chat.
const ROOM_PREFIX = "sidetrack-room-";
const $ = (s) => document.querySelector(s);

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

$("#code").value = location.hash.slice(1).toUpperCase();
try {
  $("#name").value = localStorage.getItem("sidetrack-name") ?? "";
} catch {}
if ($("#code").value) $("#name").focus();

$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#code").value.trim().toUpperCase();
  const name = $("#name").value.trim();
  if (!code || !name) return;
  try {
    localStorage.setItem("sidetrack-name", name);
  } catch {}
  join(code, name);
});

function loginError(text) {
  $("#login-error").textContent = text;
  $("#login-error").hidden = !text;
  const btn = $("#login-form button");
  btn.disabled = !text;
  btn.textContent = text ? "Rejoindre" : "Connexion…";
}

function join(code, name) {
  loginError(null);
  peer?.destroy();
  peer = new Peer();
  peer.on("open", () => {
    conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: "json" });
    conn.on("open", () => conn.send({ t: "hello", name }));
    conn.on("data", onData);
    conn.on("close", () => setStatus("Déconnecté de l'hôte"));
  });
  peer.on("error", (e) => {
    const text =
      e.type === "peer-unavailable"
        ? "Salon introuvable : vérifie le code, ou l'hôte a fermé le salon."
        : `Connexion impossible (${e.type}).`;
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
      setStatus("L'hôte a fermé le salon");
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
      if (msg.system) return el("p", msg.text, "system");
      if (msg.masked) {
        return msg.mine
          ? el("p", `🔒 Ta réponse : ${msg.mine}`, "masked")
          : el("p", `🔒 ${msg.name} a proposé une réponse`, "masked");
      }
      const p = el("p");
      p.append(el("b", `${msg.name} : `), msg.text ?? "");
      if (msg.ref) {
        p.append(el("span", `▶ ${msg.ref.label || "vidéo"}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`, "ref"));
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
        toggle.title = "Chapitres";
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
            crow.title = "Proposer ce chapitre dans le chat";
            crow.addEventListener("click", () => sendRef({ id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      const title = row.appendChild(el("span", item.title));
      row.title = "Proposer cette vidéo dans le chat";
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
  setStatus(`${room.players.length} joueur(s)`);

  const blind = room.blind;
  $("#playlist").hidden = !!blind;
  $("#share-moment").hidden = !!blind;
  $("#blind-status").hidden = !blind;

  if (!blind) {
    $("#mask").hidden = true;
    $("#now").textContent = room.title ?? "En attente d'une vidéo…";
    renderQueue();
    return;
  }

  // Blind test : vidéo masquée tant que la réponse n'est pas révélée
  $("#mask").hidden = !blind.hideVideo || blind.phase === "revealed";
  $("#mask-time").textContent =
    blind.phase === "timeup" ? "Temps écoulé" : blind.phase === "playing" && blind.clip ? formatTime(blind.remaining) : "";
  $("#now").textContent = {
    idle: "En attente de la partie…",
    loading: "La partie va commencer…",
    playing: "Morceau mystère : écris ta réponse dans le chat !",
    timeup: "Temps écoulé !",
    revealed: `Réponse : ${blind.answer ?? "?"}`,
    over: "Partie terminée",
  }[blind.phase];
  $("#blind-status").textContent = blind.total && blind.phase !== "idle" ? `Manche ${blind.round}/${blind.total}` : "";
}

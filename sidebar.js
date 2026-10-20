// Télécommande : tout le moteur tourne dans background.js (et le salon dans room.js).
// On envoie des commandes par le port et on affiche l'état qu'il renvoie.

const $ = (s) => document.querySelector(s);

const port = browser.runtime.connect({ name: "sidebar" });
let view = null; // { state, game, playerState, notice, log, room, rooms }

function act(cmd, ...args) {
  port.postMessage({ cmd, args });
}

let translated = false;
port.onMessage.addListener((snap) => {
  view = snap;
  // Langue : traduction des textes fixes au premier état reçu, puis à chaque changement
  if (setLang(view.state.lang) || !translated) {
    translated = true;
    applyI18n();
  }
  render();
});

$("#version").textContent = browser.runtime.getManifest().version;

function items() {
  const { playlists, current } = view.state;
  return playlists.find((p) => p.id === current)?.items ?? [];
}

// --- Barre des playlists ---------------------------------------------------

let editing = null; // "new" | "rename" | null

function startEditing(kind) {
  editing = kind;
  const input = $("#pl-name");
  const current = view.state.playlists.find((p) => p.id === view.state.current);
  input.value = kind === "rename" ? current?.name ?? "" : "";
  input.hidden = false;
  $("#pl-select").hidden = true;
  input.focus();
  input.select();
}

function stopEditing(commit) {
  const name = $("#pl-name").value.trim();
  if (commit && name) act(editing === "new" ? "createPlaylist" : "renamePlaylist", name);
  editing = null;
  $("#pl-name").hidden = true;
  $("#pl-select").hidden = false;
}

$("#pl-select").addEventListener("change", (e) => act("selectPlaylist", e.target.value));
$("#pl-new").addEventListener("click", () => startEditing("new"));
$("#pl-rename").addEventListener("click", () => startEditing("rename"));
$("#pl-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") stopEditing(true);
  if (e.key === "Escape") stopEditing(false);
});
$("#pl-name").addEventListener("blur", () => editing && stopEditing(true));
$("#pl-export").addEventListener("click", () => act("exportPlaylist"));

// 📚 : les playlists toutes prêtes ; un clic l'ajoute (ou l'affiche si elle est déjà là)
let presetsOpen = false;
$("#pl-presets").addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  render();
});

function renderPresets() {
  $("#presets").hidden = !presetsOpen;
  $("#pl-presets").classList.toggle("on", presetsOpen);
  if (!presetsOpen) return;
  $("#preset-list").replaceChildren(
    ...Object.entries(PRESETS).map(([key, preset]) =>
      button(t("presetCount", preset.name[currentLang()] ?? preset.name.en, preset.items.length), () => {
        presetsOpen = false;
        act("addPreset", key);
      })
    )
  );
}

// Suppression en deux clics (confirm() n'est pas disponible dans la barre latérale)
let deleteArmed = null;
$("#pl-delete").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const disarm = () => {
    clearTimeout(deleteArmed);
    deleteArmed = null;
    btn.textContent = "🗑";
    btn.classList.remove("danger");
  };
  if (deleteArmed) {
    disarm();
    act("deletePlaylist");
    return;
  }
  btn.textContent = t("sure");
  btn.classList.add("danger");
  deleteArmed = setTimeout(disarm, 3000);
});

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#url").value.trim();
  if (!text) return;
  act("addLink", text);
  $("#url").value = "";
});

// --- Réglages --------------------------------------------------------------

function showSettings(open) {
  $("#main").hidden = open;
  $("#settings").hidden = !open;
}

$("#open-settings").addEventListener("click", () => showSettings(true));
$("#close-settings").addEventListener("click", () => showSettings(false));
$("#lang").addEventListener("change", (e) => act("setSetting", "lang", e.target.value));
$("#show-multi").addEventListener("change", (e) => act("setSetting", "showMulti", e.target.checked));
$("#chat-sound").addEventListener("change", (e) => act("setSetting", "chatSound", e.target.checked));
$("#hide-tab").addEventListener("change", (e) => act("setSetting", "hideTab", e.target.checked));
$("#nickname").addEventListener("change", (e) => act("setSetting", "nickname", e.target.value));

// --- Salon -------------------------------------------------------------------

// Bouton 🌐 : affiche les deux lignes du salon au-dessus des onglets
let roomOpen = false;
let hadRoom = false;
let lastSeenId = 0;   // dernier message lu (chat déplié)
let lastHeardId = 0;  // dernier message ayant déclenché le son

// Petit « bip » à l'arrivée d'un message (réglage), sans fichier audio
let audio = null;
function beep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.15);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.15);
  } catch {
    // pas de son possible : tant pis
  }
}
$("#toggle-room").addEventListener("click", () => {
  roomOpen = !roomOpen;
  if (roomOpen) act("refreshPublicRooms");
  render();
});

// Même règle que room.js : minuscules, sans accents, espaces → tirets
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

function suggestName() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
$("#room-name").value = suggestName();

// Un seul bouton : « Rejoindre » si le nom est celui d'un salon public listé, sinon « Créer ».
// Un nom de salon privé déjà ouvert fait aussi rejoindre (voir openRoom dans room.js).
function listedRoom() {
  const name = roomName($("#room-name").value);
  return view?.rooms.list.find((r) => r.code === name);
}

$("#room-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = roomName($("#room-name").value) || suggestName();
  if (listedRoom()) act("joinRoom", name);
  else act("openRoom", { name, isPublic: $("#room-public").checked });
});
$("#room-name").addEventListener("input", () => render());
$("#public-refresh").addEventListener("click", () => act("refreshPublicRooms"));

$("#room-close").addEventListener("click", () => act(view.guest ? "leaveRoom" : "closeRoom"));
$("#share-moment").addEventListener("click", () => act("shareMoment"));
$("#room-copy").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText((view.room ?? view.guest).link);
    btn.textContent = t("copied");
  } catch {
    btn.textContent = (view.room ?? view.guest).link; // copie manuelle
  }
  setTimeout(() => (btn.textContent = t("copyLink")), 2000);
});
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  act(view.guest ? "guestChat" : "hostChat", text, secretGuess);
  $("#chat-input").value = "";
});

// --- Contrôles ---------------------------------------------------------------

$("#prev").addEventListener("click", () => act("prev"));
$("#next").addEventListener("click", () => act("next"));
$("#toggle").addEventListener("click", () => act("toggle"));
$("#shuffle").addEventListener("click", () => act("toggleShuffle"));
$("#show-player").addEventListener("click", () => act("togglePlayerTab"));
$("#volume").addEventListener("input", (e) => act("setVolume", Number(e.target.value)));
$("#mode-listen").addEventListener("click", () => act("setMode", "listen"));
$("#mode-blind").addEventListener("click", () => act("setMode", "blind"));
$("#mode-emcee").addEventListener("click", () => act("setMode", "emcee"));

// Blind test : chacun choisit d'écrire sa réponse cachée (par défaut) ou en clair
let secretGuess = true;
$("#chat-secret").addEventListener("click", () => {
  secretGuess = !secretGuess;
  render();
});

$("#clip").addEventListener("change", (e) => act("setBlind", "clip", Number(e.target.value)));
$("#startMode").addEventListener("change", (e) => act("setBlind", "startMode", e.target.value));
$("#hideVideo").addEventListener("change", (e) => act("setBlind", "hideVideo", e.target.checked));
$("#hints").addEventListener("change", (e) => act("setBlind", "hints", e.target.checked));

// Indice façon pendu (joueurs seulement : l'animateur voit le titre)
function renderHint(hint) {
  $("#hint").hidden = !hint?.mask;
  if (!hint?.mask) return;
  $("#hint-mask").textContent = hint.mask;
  $("#hint-max").textContent = t("hintMax", hint.max);
}
$("#pause").addEventListener("change", (e) => act("setBlind", "pause", Number(e.target.value)));
$("#scoring").addEventListener("change", (e) => act("setBlind", "scoring", e.target.value));
$("#judge").addEventListener("change", (e) => act("setBlind", "judge", e.target.value));
$("#guess-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#guess-input").value.trim();
  if (!text) return;
  act("soloGuess", text);
  $("#guess-input").value = "";
});
// Invité, chacun se juge : une réponse par manche
let claimedRound = 0;
for (const [id, found] of [["#guest-found", true], ["#guest-missed", false]]) {
  $(id).addEventListener("click", () => {
    claimedRound = view.guest?.host?.blind?.round ?? 0;
    act("guestClaim", found);
    render();
  });
}

// --- Affichage -------------------------------------------------------------

function button(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

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

function renderNotice() {
  const box = $("#notice");
  box.hidden = !view.notice;
  if (!view.notice) return;
  box.textContent = t(view.notice.key, ...(view.notice.args ?? []));
  const row = box.appendChild(el("div"));
  if (view.notice.focus) row.appendChild(button(t("goToTab"), () => act("focusPlayer")));
  row.appendChild(button(t("ok"), () => act("dismissNotice")));
}

// Texte de chat, pour l'hôte : un lien YouTube s'ajoute à la playlist d'un clic (＋),
// un timecode (1:23, 1:02:03) amène tout le salon à ce moment
const CHAT_LINKS = /(https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?\S*|shorts\/\S+|live\/\S+|playlist\?\S*)|youtu\.be\/\S+))|\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

function chatText(parent, text) {
  let last = 0;
  for (const m of text.matchAll(CHAT_LINKS)) {
    parent.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      parent.appendChild(el("span", m[1], "yt"));
      parent.appendChild(button("＋", () => act("addLink", m[1]), "ref")).title = t("addToPlaylist");
      continue;
    }
    const seconds = (Number(m[2] ?? 0) * 60 + Number(m[3])) * 60 + Number(m[4]);
    parent.appendChild(button(m[0], () => act("seek", seconds), "tc")).title = t("seekAll");
  }
  parent.append(text.slice(last));
}

// Salons publics : un clic sur une ligne rejoint le salon
function renderPublicRooms() {
  const { list, loading, at } = view.rooms;
  $("#public-refresh").classList.toggle("on", loading);
  $("#public-status").textContent = loading
    ? t("searching")
    : at && !list.length
      ? t("noRooms")
      : t("roomsOpen", list.length);
  $("#public-list").replaceChildren(
    ...view.rooms.list.map((r) => {
      const li = el("li");
      li.title = t("join");
      const name = `${r.mode === "blind" ? "❓" : "🎵"} ${r.code}${r.game ? ` · ${t("gameInProgress")}` : ""}`;
      li.append(el("span", name, "name"), el("span", `${r.players} 👤`, "muted"));
      li.addEventListener("click", () => act("joinRoom", r.code));
      return li;
    })
  );
}

// Ligne de chat. Hôte : timecodes et vidéos proposées cliquables (pour tout le salon),
// indice « probable », +1. Invité : propositions masquées pendant une manche.
function chatLine(msg, { guest, blind, playing }) {
  if (msg.system) return el("p", t(msg.key, ...(msg.args ?? [])), "system");
  const who = (m) => (m.from === "host" ? t("host") : m.name);
  if (msg.masked) return el("p", msg.mine ? t("yourGuess", msg.mine) : t("someoneGuessed", who(msg)), "masked");
  // L'hôte joue (onglet Blind test) : pendant la manche, il ne voit que ses propres réponses
  if (playing && msg.private) {
    return el("p", msg.from === "host" ? t("yourGuess", msg.text ?? "") : t("someoneGuessed", who(msg)), "masked");
  }
  const p = el("p", null, msg.private ? "private" : "");
  if (msg.private) p.append("🔒 ");
  const name = p.appendChild(el("b", `${who(msg)} : `));
  if (msg.color) name.style.color = msg.color;
  if (msg.text) {
    if (guest) p.append(msg.text);
    else chatText(p, msg.text);
  }
  // Aide à l'arbitrage : la proposition ressemble au titre
  if (msg.hint) p.appendChild(el("span", t("probable"), "hint")).title = t("probableTitle");
  if (msg.ref) {
    const label = `▶ ${msg.ref.label || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`;
    p.append(guest ? el("span", label, "ref plain") : button(label, () => act("playRef", msg.ref), "ref"));
  }
  // En blind test, l'hôte donne les points directement depuis une proposition
  if (!guest && blind && msg.from !== "host" && !msg.system) p.append(button("+1", () => act("award", msg.from, 1)));
  return p;
}

function guestStatus(g) {
  if (g.status === "connecting") return t("guestConnecting");
  if (g.status === "proof") return t("guestProof");
  if (g.status === "ended") return t(g.endKey, ...(g.endArgs ?? []));
  return t("players", g.players.length);
}

// Notre salon (hôte) ou celui de quelqu'un d'autre (invité) : même panneau
function renderRoom(blind) {
  const guest = view.guest;
  const room = view.room ?? guest;
  // Le salon s'affiche au-dessus des onglets : les deux lignes, ou le chat une fois dedans
  // À l'ouverture d'un salon, le chat s'affiche ; 🌐 permet ensuite de le replier
  if (room && !hadRoom) roomOpen = true;
  // Après la fermeture, un nouveau nom est proposé (sinon le champ vide montre « Nom du salon »)
  if (!room && hadRoom) $("#room-name").value = suggestName();
  hadRoom = !!room;
  $("#toggle-room").hidden = !view.state.showMulti && !room;
  $("#toggle-room").classList.toggle("on", roomOpen);

  // Messages des autres : badge de non-lus sur 🌐 quand le chat est replié, son en option
  const me = guest ? guest.me : "host";
  const others = room ? room.chat.filter((m) => !m.system && m.from !== me) : [];
  const latest = others.length ? others[others.length - 1].id : 0;
  if (roomOpen && !$("#main").hidden) lastSeenId = latest;
  const unread = others.filter((m) => m.id > lastSeenId).length;
  $("#unread").hidden = !unread;
  $("#unread").textContent = unread > 9 ? "9+" : String(unread);
  if (latest > lastHeardId) {
    if (lastHeardId && view.state.chatSound) beep();
    lastHeardId = latest;
  }
  if (!room) lastSeenId = lastHeardId = 0; // un autre salon recommence sa numérotation

  $("#online").hidden = !roomOpen;
  $("#room-panel").hidden = !room;
  $("#room-form").hidden = !!room;
  $("#rooms-row").hidden = !!room;
  $("#public-list").hidden = !!room;
  if (!room) {
    $("#room-go").textContent = listedRoom() ? t("join") : t("create");
    return renderPublicRooms();
  }
  if (room.code === roomName($("#room-name").value)) $("#room-name").value = "";

  $("#room-code").textContent = room.code;
  $("#room-public-badge").hidden = !room.public;
  if (!$("#room-copy").textContent.startsWith("✓")) $("#room-copy").textContent = t("copyLink");
  $("#room-close").title = t(guest ? "leaveRoom" : "closeRoom");
  $("#room-status").textContent = guest
    ? guestStatus(guest)
    : room.status === "opening"
      ? t("roomOpening")
      : room.status === "error"
        ? t("roomError")
        : t("guests", room.players.length);
  // Preuve de travail : nombre d'essais imprévisible, la barre avance vite puis ralentit
  const proving = guest?.status === "proof";
  $("#room-progress").hidden = !proving;
  if (proving) $("#room-progress").value = 1 - Math.exp((-2 * guest.tries) / 2 ** (guest.powBits || 7));
  $("#chat-input").placeholder = t(guest ? "guestChatPlaceholder" : "chatPlaceholder");
  $("#chat-input").disabled = !!guest && guest.status !== "joined";

  // Pastilles des joueurs : couleur, score ; l'hôte peut, au survol, exclure ou bannir
  const scores = guest ? !!guest.host?.blind : true;
  const hostScore = guest ? guest.host?.hostScore : view.state.mode === "blind" ? room.hostScore : null;
  const hostChip = () => {
    const li = el("li", null, guest ? "" : "me");
    li.append(el("span", t("host")), el("b", String(hostScore)));
    if (!guest) li.append(button("+1", () => act("award", "host", 1)), button("−1", () => act("award", "host", -1)));
    return li;
  };
  $("#room-players").replaceChildren(
    ...(hostScore != null ? [hostChip()] : []),
    ...room.players.map((p) => {
      const li = el("li", null, p.id === me ? "me" : "");
      const name = li.appendChild(el("span", p.name));
      name.style.color = p.color;
      if (scores) li.append(el("b", String(p.score)));
      if (guest) return li;
      if (blind) {
        li.append(button("+1", () => act("award", p.id, 1)), button("−1", () => act("award", p.id, -1)));
      }
      li.appendChild(button("✕", () => act("kick", p.id), "mod")).title = t("kick");
      li.appendChild(button("🚫", () => act("ban", p.id), "mod")).title = t("ban");
      return li;
    })
  );

  const chat = $("#chat");
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
  const playing = !guest && view.state.mode === "blind";
  const referee = !guest && view.state.mode === "emcee";
  chat.replaceChildren(...room.chat.map((msg) => chatLine(msg, { guest: !!guest, blind: referee, playing })));

  // Bouton 🔒/💬 devant le champ : en blind test, pour les joueurs (pas pour l'animateur)
  const plays = guest ? !!guest.host?.blind : playing;
  $("#chat-secret").hidden = !plays;
  $("#chat-secret").textContent = secretGuess ? "🔒" : "💬";
  $("#chat-secret").title = t(secretGuess ? "secretOn" : "secretOff");
  $("#chat-secret").classList.toggle("on", secretGuess);
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

// Invité : l'écran suit l'hôte (sa vidéo, son blind test) ; sa playlist sert à proposer dans le chat
function renderGuest(g) {
  const h = g.host;
  const blind = h?.blind;
  const hidden = !!blind && blind.hideVideo && blind.phase !== "revealed";
  const art = $("#art");
  art.hidden = !g.videoId || hidden;
  if (!art.hidden) {
    const src = `https://i.ytimg.com/vi/${g.videoId}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = hidden;
  $("#show-player").classList.toggle("on", !!view.playerShown);
  $("#loading").hidden = !view.loading;
  $("#mask").hidden = !hidden;
  $("#mask-time").textContent =
    blind?.phase === "timeup" ? t("timeUp") : blind?.phase === "playing" && blind.clip ? formatTime(blind.remaining) : "";
  $("#now").textContent = !blind
    ? h?.title ?? t("guestWaiting")
    : {
        idle: t("blindIdle"),
        loading: t("blindLoading"),
        playing: t("blindPlaying"),
        timeup: t("timeUpBang"),
        revealed: t("blindRevealed", blind.answer ?? "?") + (blind.nextIn ? ` · ${t("nextIn", blind.nextIn)}` : ""),
        over: t("gameOver"),
      }[blind.phase] ?? "";
  $("#guest-status").textContent = blind?.total && blind.phase !== "idle" ? t("round", blind.round, blind.total) : "";
  renderHint(blind?.hint ? { mask: blind.hint, max: blind.maxPts } : null);
  $("#guest-claim").hidden = !(blind?.claim && blind.phase === "revealed");
  $("#guest-found").disabled = $("#guest-missed").disabled = claimedRound === blind?.round;
  $("#guest-listen").hidden = !h?.playlist;
  if (!h?.playlist) return;
  $("#share-moment").disabled = !g.videoId;
  $("#guest-queue").replaceChildren(
    ...h.playlist.map((item, i) => {
      const li = el("li", null, i === h.index ? "current" : "");
      const row = li.appendChild(el("div", null, "row"));
      const key = `guest:${item.id}`;
      if (item.chapters?.length) {
        const open = expanded.has(key);
        row.appendChild(
          button(open ? "▾" : "▸", (e) => {
            e.stopPropagation();
            if (open) expanded.delete(key);
            else expanded.add(key);
            render();
          })
        ).title = t("chapters");
        if (open) {
          const list = li.appendChild(el("ul", null, "chapters"));
          for (const c of item.chapters) {
            const crow = list.appendChild(el("li")).appendChild(el("div", null, "row"));
            crow.append(el("time", formatTime(c.start)), el("span", c.title));
            crow.title = c.title;
            crow.addEventListener("click", () => act("guestRef", { id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      row.appendChild(el("span", item.title)).title = item.title;
      row.addEventListener("click", () => act("guestRef", { id: item.id, start: 0, label: item.title }));
      return li;
    })
  );
}

// multi : animateur (il arbitre) ; room : dans un salon, qu'on anime ou qu'on joue
function renderBlind(game, n, multi, room = multi) {
  const status = $("#blind-status");
  const blind = view.state.blind;
  const self = !multi && blind.judge === "self"; // chacun se juge (Trouvé / Raté)
  const total = game.order.length;
  // Score « x/y » en solo seulement : dans un salon, les points s'affichent sur les pastilles
  const round = room
    ? t("round", game.pos + 1, total)
    : `${t("round", game.pos + 1, total)} · ${t("score", game.score, game.played)}`;
  const how = multi ? (blind.scoring === "manual" ? t("givePoints") : t("autoPoints")) : room ? t(self ? "selfPoints" : "autoPoints") : "";
  const next = game.nextIn ? ` · ${t("nextIn", game.nextIn)}` : "";
  status.textContent = {
    idle: n ? t("tracks", n) : t("emptyShort"),
    loading: t("loadingChapters"),
    playing: round,
    timeup: `${round} · ${t("timeUpBang")}`,
    revealed: `${round}${how ? ` · ${how}` : ""}${next}`,
    over: t("gameOver"),
  }[game.phase];
  if (game.phase === "over" && !room) {
    status.append(" : ");
    status.appendChild(el("strong", `${game.score}/${game.played}`));
  }
  $("#blind-actions").replaceChildren(...(multi ? emceeControls(game, n) : playerActions(game, n, room, self)));

  // Seul, points à l'écrit : champ de réponse et réponses de la manche
  const writing = !room && !self && ["playing", "timeup", "revealed"].includes(game.phase);
  $("#solo-guess").hidden = !writing;
  if (writing) {
    $("#guess-list").replaceChildren(...game.guesses.map((g) => el("li", `🔒 ${g.text}`)));
    if (game.phase === "revealed") $("#guess-list").appendChild(el("li", t("soloPoints", game.lastPoints), "points"));
    $("#guess-input").disabled = game.phase === "revealed";
  }

  $("#blind-settings").hidden = !multi && !["idle", "over"].includes(game.phase);
  $("#hideVideo-label").textContent = t(room ? "hideVideoGuests" : "hideVideo");
  $("#judge-row").hidden = multi;
  $("#scoring-row").hidden = !multi;
}

// Animateur : quatre boutons comme en mode Playlist, la liste des pistes en dessous
function emceeControls(game, n) {
  const live = ["playing", "timeup"].includes(game.phase);
  const b = (label, title, cmd, enabled) => {
    const x = button(label, () => act(cmd));
    x.title = t(title);
    x.disabled = !enabled;
    return x;
  };
  return [
    b("🔀", "newGame", "startGame", n > 0 && game.phase !== "loading"),
    b(view.playerState === 1 ? "⏸" : "▶", "playPause", "playPause", !["idle", "over", "loading"].includes(game.phase)),
    b("👁", "revealTitle", "reveal", live),
    b("⏭", "nextRoundTitle", "nextRound", live || game.phase === "revealed"),
  ];
}

// On joue : démarrer, révéler, passer ; à la révélation, se juger ou passer à la suite
function playerActions(game, n, room, self) {
  switch (game.phase) {
    case "idle": {
      const start = button(t("startGame"), () => act("startGame"));
      start.disabled = !n;
      return [start];
    }
    case "playing":
      return [button(t("reveal"), () => act("reveal")), button(t("skip"), () => act("nextRound"))];
    case "timeup":
      return [button(t("reveal"), () => act("reveal"))];
    case "revealed": {
      const nextBtn = button(t("nextRound"), () => act("nextRound"));
      if (!self) return [nextBtn];
      const done = room ? !!view.room.hostClaimed : !!game.answered;
      const found = button(t("found"), () => act("claim", true), "good");
      const missed = button(t("missed"), () => act("claim", false), "bad");
      found.disabled = missed.disabled = done;
      return room ? [found, missed, nextBtn] : [found, missed];
    }
    case "over":
      return [button(t("replay"), () => act("startGame"))];
    default:
      return [];
  }
}

// Hôte d'un salon : lecture / pause du morceau de la manche (pour réécouter, faire durer…)
function playPause() {
  const b = button(view.playerState === 1 ? "⏸" : "▶", () => act("playPause"), "icon");
  b.title = t("playPause");
  return b;
}

// File de lecture : glisser-déposer pour réordonner, ▸ pour dérouler les chapitres
const expanded = new Set();      // ids des vidéos dépliées
const chaptersAsked = new Set(); // ids dont on a demandé les chapitres
let dragging = false;

// Une liste de pistes. Mode Playlist : glisser-déposer, suppression, clic = lecture.
// Blind test de l'hôte : clic = prochaine manche, pistes déjà jouées grisées, rien d'éditable.
function trackList(index, { picking = false, played = new Set() } = {}) {
  return items().map((item, i) => {
      const li = el("li", null, i === index ? (view.loading ? "current loading" : "current") : played.has(`${i}`) ? "played" : "");
      li.draggable = !picking;
      li.addEventListener("dragstart", (e) => {
        dragging = true;
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragend", () => {
        dragging = false;
        render();
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        li.classList.add("drop-target");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        dragging = false;
        act("moveItem", Number(e.dataTransfer.getData("text/plain")), i);
      });

      const row = li.appendChild(el("div", null, "row"));
      const open = expanded.has(item.id);
      row.appendChild(
        button(open ? "▾" : "▸", (e) => {
          e.stopPropagation();
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          render();
        })
      ).title = t("chapters");
      const title = row.appendChild(el("span", item.title));
      title.title = item.title;
      row.addEventListener("click", () => act(picking ? "blindPick" : "play", i, null));
      if (!picking) {
        const del = row.appendChild(
          button("✕", (e) => {
            e.stopPropagation();
            act("removeItem", i);
          }, "del")
        );
        del.title = t("removeItem");
      }

      if (open) {
        const list = li.appendChild(el("ul", null, "chapters"));
        if (!Array.isArray(item.chapters)) {
          list.appendChild(el("li", t("loadingChapters"), "muted"));
          if (!chaptersAsked.has(item.id)) {
            chaptersAsked.add(item.id);
            act("loadChapters", i);
          }
        } else if (!item.chapters.length) {
          list.appendChild(el("li", t("noChapters"), "muted"));
        } else {
          item.chapters.forEach((c, k) => {
            const cli = list.appendChild(el("li", null, played.has(`${i}:${k}`) ? "played" : ""));
            const crow = cli.appendChild(el("div", null, "row"));
            crow.append(el("time", formatTime(c.start)), el("span", c.title));
            crow.title = c.title;
            crow.addEventListener("click", () => (picking ? act("blindPick", i, k) : act("playAt", i, c.start)));
          });
        }
      }
      return li;
    });
}

function renderQueue(index) {
  if (dragging) return; // reconstruire la liste annulerait le glisser-déposer en cours
  $("#queue").replaceChildren(...trackList(index));
  $("#empty").hidden = items().length > 0;
}

// Blind test avec un salon : l'hôte arbitre, il voit les pistes et choisit la prochaine manche
let hostTracksShown = true;
$("#host-tracks-toggle").addEventListener("click", () => {
  hostTracksShown = !hostTracksShown;
  render();
});

function renderHostTracks(game) {
  const played = new Set(game.order.slice(0, game.pos + 1).map(({ i, chapter }) => (chapter == null ? `${i}` : `${i}:${chapter}`)));
  $("#host-tracks-title").textContent = t("tracksTitle", items().length);
  $("#host-tracks-toggle").textContent = hostTracksShown ? t("hide") : t("show");
  $("#host-queue").hidden = !hostTracksShown;
  if (hostTracksShown) $("#host-queue").replaceChildren(...trackList(view.state.index, { picking: true, played }));
}

function render() {
  const { state, game } = view;
  const multi = !!view.room;
  // Animateur (hôte d'un salon, onglet 🎤) : il voit tout. Sinon, en blind test, on joue.
  const referee = multi && state.mode === "emcee";

  if (!editing) {
    $("#pl-select").replaceChildren(
      ...state.playlists.map((p) => {
        const o = new Option(`${p.name} (${p.items.length})`, p.id);
        o.selected = p.id === state.current;
        return o;
      })
    );
  }
  renderNotice();
  renderPresets();

  const blind = state.mode === "blind" || state.mode === "emcee";
  // On joue (seul, ou avec ses invités) : rien n'est dévoilé pendant la manche
  const secret = blind && !referee && ["playing", "timeup"].includes(game.phase);
  $("#mode-listen").classList.toggle("on", !blind);
  $("#mode-blind").classList.toggle("on", blind && !referee);
  $("#mode-emcee").classList.toggle("on", referee);
  $("#mode-emcee").hidden = !multi;
  renderRoom(blind);
  renderSettings(state);

  // Invité d'un salon : pas de playlist à soi ni de blind test, on suit l'hôte
  const guest = view.guest;
  $("#add").hidden = !!guest;
  $("#tabs").hidden = !!guest;
  $("#guest").hidden = !guest;
  $("#listen").hidden = !!guest || blind;
  $("#blind").hidden = !!guest || !blind;
  if (document.activeElement !== $("#volume")) $("#volume").value = String(state.volume ?? 100);
  if (guest) return renderGuest(guest);

  // Miniature du morceau (la vidéo est dans l'onglet masqué). En blind test solo, aperçu noir
  // sauf une fois la réponse révélée (ou pendant la manche si on ne masque pas la vidéo).
  const current = items()[state.index];
  const art = $("#art");
  const showArt =
    current && (!blind || referee || game.phase === "revealed" || (secret && !state.blind.hideVideo));
  art.hidden = !showArt;
  if (showArt) {
    const src = `https://i.ytimg.com/vi/${current.id}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = blind && !referee;
  $("#mask").hidden = !(secret && state.blind.hideVideo);
  $("#mask-time").textContent =
    game.phase === "timeup" ? t("timeUp") : game.clip ? formatTime(game.remaining) : "";
  // Une fois révélé (ou pour l'arbitre), en partie par chapitres, la réponse est le titre du chapitre
  const answer =
    blind && (referee || game.phase === "revealed") && game.chapter?.title
      ? `${game.chapter.title} · ${current?.title ?? ""}`
      : current?.title;
  const timer = blind && referee && game.phase === "playing" && game.clip ? ` · ${formatTime(game.remaining)}` : "";
  $("#now").textContent = secret ? t("mystery") : (answer ?? t("nothingPlaying")) + timer;

  $("#toggle").textContent = view.playerState === 1 ? "⏸" : "▶";
  $("#loading").hidden = !view.loading;
  $("#show-player").classList.toggle("on", !!view.playerShown);
  $("#shuffle").classList.toggle("on", state.shuffle);

  $("#clip").querySelector('option[value="-1"]').disabled = state.blind.startMode !== "chapter";
  if (document.activeElement !== $("#clip")) $("#clip").value = String(state.blind.clip);
  if (document.activeElement !== $("#startMode")) $("#startMode").value = state.blind.startMode;
  $("#hideVideo").checked = state.blind.hideVideo;
  $("#hints").checked = state.blind.hints !== false;
  renderHint(secret ? view.hint : null);
  if (document.activeElement !== $("#pause")) $("#pause").value = String(state.blind.pause ?? 10);
  if (document.activeElement !== $("#scoring")) $("#scoring").value = state.blind.scoring ?? "auto";
  if (document.activeElement !== $("#judge")) $("#judge").value = state.blind.judge ?? "chat";
  $("#scoring-row").hidden = !referee;

  $("#host-tracks").hidden = !referee;
  if (referee) renderHostTracks(game);
  if (blind) renderBlind(game, items().length, referee, multi);
  else renderQueue(state.index);
}

function renderSettings(state) {
  $("#lang").value = state.lang ?? "auto";
  $("#show-multi").checked = state.showMulti !== false;
  $("#chat-sound").checked = !!state.chatSound;
  $("#hide-tab").checked = state.hideTab !== false;
  const banned = Object.entries(state.banned ?? {});
  $("#banned").replaceChildren(
    ...(banned.length
      ? banned.map(([id, name]) => {
          const li = el("li");
          li.appendChild(el("span", name)).title = id;
          li.append(button(t("unban"), () => act("unban", id)));
          return li;
        })
      : [el("li", t("noBanned"), "muted")])
  );
  if (document.activeElement !== $("#nickname")) $("#nickname").value = state.nickname ?? "";
  $("#nickname").placeholder = t("defaultGuest");
  $("#log").textContent = view.log.join("\n");
}

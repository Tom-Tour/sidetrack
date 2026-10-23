// Télécommande : tout le moteur tourne dans background.js (et le salon dans room.js).
// On envoie des commandes par le port et on affiche l'instantané qu'il renvoie.

const $ = (s) => document.querySelector(s);

const port = browser.runtime.connect({ name: "sidebar" });
let view = null; // dernier instantané du moteur : { state, settings, game, me, room, guest, rooms… }

function act(cmd, ...args) {
  port.postMessage({ cmd, args });
}

// Commande dont on attend la réponse : → clé d'erreur, ou null
let reqSeq = 0;
const replies = new Map();
function ask(cmd, ...args) {
  const req = ++reqSeq;
  port.postMessage({ cmd, args, req });
  return new Promise((resolve) => replies.set(req, resolve));
}

let translated = false;
port.onMessage.addListener((msg) => {
  if (msg.t === "reply") {
    replies.get(msg.req)?.(msg.error);
    replies.delete(msg.req);
    return;
  }
  if (msg.t !== "snap") return;
  view = msg.snap;
  // Langue : traduction des textes fixes au premier état reçu, puis à chaque changement
  if (setLang(view.settings.lang) || !translated) {
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

// Suppression d'une playlist : « Sûr ? », second clic dans les 3 s (common/ui.js)
const sure = createSure(() => render());
$("#pl-delete").addEventListener("click", () => sure.click("delete", () => act("deletePlaylist")));

// 📚 : les playlists toutes prêtes ; un clic l'ajoute (ou l'affiche si elle est déjà là)
let presetsOpen = false;
$("#pl-presets").addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  render();
});

function renderPresets() {
  const shown = view.settings.showPresets;
  $("#pl-presets").hidden = !shown;
  if (!shown) presetsOpen = false;
  $("#presets").hidden = !presetsOpen;
  $("#pl-presets").classList.toggle("on", presetsOpen);
  if (!presetsOpen) return;
  $("#preset-list").replaceChildren(
    ...Object.entries(PRESETS).map(([key, preset]) =>
      button(t("presetCount", t(preset.name), preset.items.length), () => {
        presetsOpen = false;
        act("addPreset", key);
      })
    )
  );
}

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
$("#set-lang").addEventListener("change", (e) => act("setSetting", "lang", e.target.value));
for (const key of ["chatSound", "showPresets", "hideTab", "showMulti"]) {
  $(`#set-${key}`).addEventListener("change", (e) => act("setSetting", key, e.target.checked));
}
$("#set-nickname").addEventListener("change", (e) => act("setSetting", "nickname", e.target.value));

// Sauvegarde : un fichier JSON avec toutes les playlists, téléchargé depuis le panneau
$("#backup-save").addEventListener("click", () => {
  const backup = {
    app: "sidetrack",
    version: 1,
    saved: new Date().toISOString(),
    playlists: view.state.playlists.map(({ id, name, preset, items }) => ({ id, name, preset, items })),
  };
  const name = `sidetrack-playlists-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  act("logBackup", backup.playlists.length, name);
});

// Restauration : le moteur vérifie le contenu du fichier avant de l'ajouter
$("#backup-restore").addEventListener("click", () => $("#backup-file").click());
$("#backup-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    // pas du JSON : le moteur le signalera comme fichier invalide
  }
  act("restorePlaylists", data);
});

// --- Salon -------------------------------------------------------------------

// Bouton 🌐 : affiche les deux lignes du salon au-dessus des onglets
let roomOpen = false;
let hadRoom = false;
let lastSeenId = 0;   // dernier message lu (chat déplié)
let lastHeardId = 0;  // dernier message ayant déclenché le son

$("#toggle-room").addEventListener("click", () => {
  roomOpen = !roomOpen;
  if (roomOpen) act("refreshPublicRooms");
  render();
});

// Même règle que room.js : minuscules, sans accents, espaces → tirets
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

// Premier salon : le pseudo de la ligne (pré-remplie avec celui proposé) est gardé, avec OK
// ou en entrant dans un salon
function commitName() {
  if (view.settings.nameSet) return;
  const name = $("#ask-name").value.trim();
  if (name && name !== view.settings.nickname) act("setSetting", "nickname", name);
  else act("setSetting", "nameSet", true);
}
$("#name-ask").addEventListener("submit", (e) => {
  e.preventDefault();
  commitName();
  $("#room-name").focus();
});

$("#room-form").addEventListener("submit", (e) => {
  e.preventDefault();
  commitName();
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
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  $("#chat-input").value = "";
  if (view.guest) return act("guestChat", text, secretGuess);
  const error = await ask("hostChat", text, secretGuess);
  // Trop rapide : le moteur affiche le bandeau errTooFast, et le texte n'est pas perdu
  if (error) $("#chat-input").value = text;
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

// Indice façon pendu (joueurs seulement : l'animateur voit le titre)
function renderHint(hint) {
  $("#hint").hidden = !hint?.mask;
  if (!hint?.mask) return;
  $("#hint-mask").textContent = hint.mask;
  $("#hint-max").textContent = t("hintMax", hint.max);
}

// --- Éléments d'interface ------------------------------------------------------
// el, button, swatch, codeTag, chip, personCard, peopleList : common/ui.js

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
  const actions = el("div", { className: "actions" });
  if (view.notice.focus) actions.appendChild(button(t("goToTab"), () => act("focusPlayer")));
  actions.appendChild(button(t("ok"), () => act("dismissNotice")));
  box.replaceChildren(t(view.notice.key, ...(view.notice.args ?? [])), actions);
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
      parent.appendChild(el("span", { textContent: m[1], className: "yt" }));
      parent.appendChild(button("＋", () => act("addLink", m[1]), "pill ref")).title = t("addToPlaylistTitle");
      continue;
    }
    const seconds = (Number(m[2] ?? 0) * 60 + Number(m[3])) * 60 + Number(m[4]);
    parent.appendChild(button(m[0], () => act("seek", seconds), "pill ref")).title = t("seekAllTitle");
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
      li.append(el("span", { textContent: name, className: "name" }), el("span", { textContent: `${r.players} 👤`, className: "muted" }));
      li.addEventListener("click", () => {
        commitName();
        act("joinRoom", r.code);
      });
      return li;
    })
  );
}

// --- Fiche d'une personne ------------------------------------------------------
// Clic sur un nom → fiche. Hôte : points en blind test, « Exclure… », « Bannir… ». Invité :
// « Bloquer… » (une autre personne ou l'hôte). Toujours par un panneau qui écrit les
// conséquences (GUIDE.md).

let person = null; // { id, confirm: null | "kick" | "ban" | "block" }

function openPerson(id) {
  person = { id, confirm: null };
  render();
}

function closePerson() {
  person = null;
  render();
}

function renderPerson(blind) {
  const box = $("#person");
  const guest = view.guest;
  const room = view.room ?? (guest?.status === "joined" ? guest : null);
  const known =
    person &&
    room &&
    (person.id === "host"
      ? { id: "host", name: t("host"), code: guest ? guest.hostCode : view.me.code, score: room.hostScore }
      : room.players.find((p) => p.id === person.id && p.id !== guest?.me));
  box.hidden = !known;
  if (!known) {
    person = null;
    return;
  }
  if (person.confirm) {
    const kind = person.confirm;
    const confirm = {
      kind,
      help: kind === "block" && known.id === "host" ? t("blockHostConfirmHelp") : undefined,
      onYes: () => {
        act(kind, known.id);
        closePerson();
      },
      onNo: () => {
        person.confirm = null;
        render();
      },
    };
    box.replaceChildren(...personCard(known, { onClose: closePerson, confirm }));
    return;
  }
  const ask = (kind) => () => {
    person.confirm = kind;
    render();
  };
  const actions = [];
  if (guest) {
    actions.push(askButton("block", ask("block")));
  } else {
    if (blind) actions.push(button("+1", () => act("award", known.id, 1)), button("−1", () => act("award", known.id, -1)));
    if (known.id !== "host") actions.push(askButton("kick", ask("kick")), askButton("ban", ask("ban")));
  }
  box.replaceChildren(...personCard(known, { onClose: closePerson, actions }));
}

// Heure d'envoi (HH:MM), donnée par l'hôte : la même pour tout le salon
function chatTime(msg) {
  if (!Number.isFinite(msg.at)) return null;
  const date = new Date(msg.at);
  return el("time", { textContent: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), dateTime: date.toISOString() });
}

// Ligne de chat, précédée de son heure (GUIDE §3)
function chatLine(msg, options) {
  const p = chatBody(msg, options);
  const time = chatTime(msg);
  if (time) p.prepend(time);
  return p;
}

// Contenu d'une ligne. Hôte : timecodes et vidéos proposées cliquables (pour tout le salon),
// indice « probable », +1, nom cliquable (fiche). Invité : propositions masquées pendant une manche.
function chatBody(msg, { guest, referee, playing }) {
  if (msg.system) return el("p", { textContent: t(msg.key, ...(msg.args ?? [])), className: "msg system" });
  const who = (m) => (m.from === "host" ? t("host") : m.name);
  if (msg.masked) return el("p", { textContent: msg.mine ? t("yourGuess", msg.mine) : t("someoneGuessed", who(msg)), className: "msg masked" });
  // L'hôte joue (onglet Blind test) : pendant la manche, il ne voit que ses propres réponses
  if (playing && msg.private) {
    return el("p", { textContent: msg.from === "host" ? t("yourGuess", msg.text ?? "") : t("someoneGuessed", who(msg)), className: "msg masked" });
  }
  const p = el("p", { className: msg.private ? "msg private" : "msg" });
  if (msg.private) p.append("🔒 ");
  // Nom cliquable (fiche) : chez l'hôte, un invité présent ; chez un invité, l'hôte ou un autre invité
  const clickable = guest
    ? msg.from !== view.guest.me && (msg.from === "host" || view.guest.players.some((x) => x.id === msg.from))
    : msg.from !== "host" && view.room?.players.some((x) => x.id === msg.from);
  // Surligné : seulement son propre pseudo (pas celui d'un joueur parti, non cliquable lui aussi)
  const mine = guest ? msg.from === view.guest.me : msg.from === "host";
  const name = p.appendChild(el("span", { textContent: `${who(msg)} : `, className: mine ? "who me" : "who" }));
  name.title = nameWithCode(who(msg), msg.code);
  if (msg.color) name.style.color = msg.color;
  if (clickable) name.addEventListener("click", () => openPerson(msg.from));
  if (msg.text) {
    if (guest) p.append(msg.text);
    else chatText(p, msg.text);
  }
  // Aide à l'arbitrage : la proposition ressemble au titre
  if (msg.hint) p.appendChild(el("span", { textContent: t("probable"), className: "pill good" })).title = t("probableTitle");
  if (msg.ref) {
    const text = `▶ ${msg.ref.label || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`;
    p.append(guest ? el("span", { textContent: text, className: "pill ref plain" }) : button(text, () => act("playRef", msg.ref), "pill ref"));
  }
  // Animateur : il donne les points directement depuis une proposition
  if (!guest && referee && msg.from !== "host") p.append(button("+1", () => act("award", msg.from, 1)));
  return p;
}

function guestStatus(g) {
  if (g.status === "connecting") return t("connecting");
  if (g.status === "proof") return view.me.mining ? t("identityMining", view.me.mining.percent) : t("connecting");
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
  $("#toggle-room").hidden = !view.settings.showMulti && !room;
  $("#toggle-room").classList.toggle("on", roomOpen);
  // Tant que le salon en ligne n'est pas ouvert, 🌐 pulse doucement pour inviter à rejoindre
  // des playlists en ligne
  $("#toggle-room").classList.toggle("beckon", !roomOpen && !room);

  // Messages des autres : badge de non-lus sur 🌐 quand le chat est replié, son en option
  const me = guest ? guest.me : "host";
  const others = room ? room.chat.filter((m) => !m.system && m.from !== me) : [];
  const latest = others.length ? others[others.length - 1].id : 0;
  if (roomOpen && !$("#main").hidden) lastSeenId = latest;
  const unread = others.filter((m) => m.id > lastSeenId).length;
  $("#unread").hidden = !unread;
  $("#unread").textContent = countText(unread);
  if (latest > lastHeardId) {
    if (lastHeardId && view.settings.chatSound) beep();
    lastHeardId = latest;
  }
  if (!room) lastSeenId = lastHeardId = 0; // un autre salon recommence sa numérotation

  // Premier lancement : identité anti-spam en cours de calcul
  const mining = view.me.mining;
  $("#online").hidden = !roomOpen;
  $("#mining").hidden = !mining || !!room;
  if (mining) {
    $("#mining-title").textContent = t("identityMining", mining.percent);
    $("#mining-bar").value = mining.percent;
  }
  $("#room-panel").hidden = !room;
  $("#room-form").hidden = !!room;
  $("#name-ask").hidden = !!room || view.settings.nameSet;
  if (document.activeElement !== $("#ask-name")) $("#ask-name").value = view.settings.nickname;
  $("#rooms-row").hidden = !!room;
  $("#public-list").hidden = !!room;
  if (!room) {
    person = null;
    $("#person").hidden = true;
    $("#room-go").textContent = listedRoom() ? t("join") : t("create");
    return renderPublicRooms();
  }
  if (room.code === roomName($("#room-name").value)) $("#room-name").value = "";

  $("#room-code").textContent = room.code;
  $("#room-public-badge").hidden = !room.public;
  if (!$("#room-copy").textContent.startsWith("✓")) $("#room-copy").textContent = t("copyLink");
  $("#room-close").title = t(guest ? "leave" : "closeRoom");
  $("#room-status").textContent = guest
    ? guestStatus(guest)
    : room.status === "opening"
      ? t("roomOpening")
      : room.status === "error"
        ? t("connError")
        : t("guests", room.players.length);
  $("#chat-input").placeholder = t(guest ? "guestChatPlaceholder" : "chatPlaceholder");
  $("#chat-input").disabled = !!guest && guest.status !== "joined";

  // Pastilles : couleur, nom, code, score. L'hôte clique sur un nom pour ouvrir sa fiche.
  const scores = guest ? !!guest.host?.blind : blind;
  const hostScore = guest ? guest.host?.hostScore : view.state.mode === "blind" ? room.hostScore : null;
  const hostChip = () =>
    chip(
      { name: t("host"), code: guest ? guest.hostCode : view.me.code },
      { me: !guest, score: hostScore, onClick: () => openPerson("host") }
    );
  $("#room-players").replaceChildren(
    ...(hostScore != null ? [hostChip()] : []),
    ...room.players.map((p) =>
      chip(p, { me: p.id === me, score: scores ? p.score : null, onClick: p.id === me ? null : () => openPerson(p.id) })
    )
  );
  renderPerson(blind);

  const chat = $("#chat");
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
  const playing = !guest && view.state.mode === "blind";
  const referee = !guest && view.state.mode === "emcee";
  chat.replaceChildren(...room.chat.map((msg) => chatLine(msg, { guest: !!guest, referee, playing })));

  // Bouton 🔒/💬 devant le champ : en blind test, pour les joueurs (pas pour l'animateur)
  const plays = guest ? !!guest.host?.blind : playing;
  $("#chat-secret").hidden = !plays;
  $("#chat-secret").textContent = secretGuess ? "🔒" : "💬";
  $("#chat-secret").title = t(secretGuess ? "secretOnTitle" : "secretOffTitle");
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
  if (!changed("guest", h.index, itemsKey(h.playlist))) return;
  $("#guest-queue").replaceChildren(
    ...h.playlist.map((item, i) => {
      const li = el("li", { className: i === h.index ? "current" : "" });
      const row = li.appendChild(el("div", { className: "row" }));
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
          const list = li.appendChild(el("ul", { className: "chapters" }));
          for (const c of item.chapters) {
            const crow = list.appendChild(el("li")).appendChild(el("div", { className: "row" }));
            crow.append(el("time", { textContent: formatTime(c.start) }), el("span", { textContent: c.title }));
            crow.title = c.title;
            crow.addEventListener("click", () => act("guestRef", { id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      row.appendChild(el("span", { textContent: item.title })).title = item.title;
      row.addEventListener("click", () => act("guestRef", { id: item.id, start: 0, label: item.title }));
      return li;
    })
  );
}

// multi : animateur (il arbitre) ; room : dans un salon, qu'on anime ou qu'on joue
function renderBlind(game, n, multi, room = multi) {
  const status = $("#blind-status");
  const blind = view.settings.blind;
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
    status.appendChild(el("strong", { textContent: `${game.score}/${game.played}` }));
  }
  $("#blind-actions").replaceChildren(...(multi ? emceeControls(game, n) : playerActions(game, n, room, self)));

  // Seul, points à l'écrit : champ de réponse et réponses de la manche
  const writing = !room && !self && ["playing", "timeup", "revealed"].includes(game.phase);
  $("#solo-guess").hidden = !writing;
  if (writing) {
    $("#guess-list").replaceChildren(...game.guesses.map((g) => el("li", { textContent: `🔒 ${g.text}` })));
    if (game.phase === "revealed") $("#guess-list").appendChild(el("li", { textContent: t("soloPoints", game.lastPoints), className: "points" }));
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
  const b = (text, title, cmd, enabled) => {
    const x = button(text, () => act(cmd));
    x.title = t(title);
    x.disabled = !enabled;
    return x;
  };
  return [
    b("🔀", "newGameTitle", "startGame", n > 0 && game.phase !== "loading"),
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

// File de lecture : glisser-déposer pour réordonner, ▸ pour dérouler les chapitres
const expanded = new Set();      // ids des vidéos dépliées
const chaptersAsked = new Set(); // ids dont on a demandé les chapitres
let dragging = false;

// Une liste de pistes. Mode Playlist : glisser-déposer, suppression, clic = lecture.
// Animateur : clic = prochaine manche, pistes déjà jouées grisées, rien d'éditable.
function trackList(index, { picking = false, played = new Set() } = {}) {
  return items().map((item, i) => {
    const li = el("li", { className: i === index ? (view.loading ? "current loading" : "current") : played.has(`${i}`) ? "played" : "" });
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

    const row = li.appendChild(el("div", { className: "row" }));
    const open = expanded.has(item.id);
    row.appendChild(
      button(open ? "▾" : "▸", (e) => {
        e.stopPropagation();
        if (open) expanded.delete(item.id);
        else expanded.add(item.id);
        render();
      })
    ).title = t("chapters");
    const title = row.appendChild(el("span", { textContent: item.title }));
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
      const list = li.appendChild(el("ul", { className: "chapters" }));
      if (!Array.isArray(item.chapters)) {
        list.appendChild(el("li", { textContent: t("loadingChapters"), className: "muted" }));
        if (!chaptersAsked.has(item.id)) {
          chaptersAsked.add(item.id);
          act("loadChapters", i);
        }
      } else if (!item.chapters.length) {
        list.appendChild(el("li", { textContent: t("noChapters"), className: "muted" }));
      } else {
        item.chapters.forEach((c, k) => {
          const cli = list.appendChild(el("li", { className: played.has(`${i}:${k}`) ? "played" : "" }));
          const crow = cli.appendChild(el("div", { className: "row" }));
          crow.append(el("time", { textContent: formatTime(c.start) }), el("span", { textContent: c.title }));
          crow.title = c.title;
          crow.addEventListener("click", () => (picking ? act("blindPick", i, k) : act("playAt", i, c.start)));
        });
      }
    }
    return li;
  });
}

// Pendant une partie, le moteur renvoie son état chaque seconde : une liste n'est reconstruite
// que si ce qu'elle affiche a changé (et un clic en cours sur une ligne n'est pas perdu)
const drawn = new Map();
function changed(list, ...parts) {
  const key = JSON.stringify([document.documentElement.lang, [...expanded], view.loading, ...parts]);
  if (drawn.get(list) === key) return false;
  drawn.set(list, key);
  return true;
}
const itemsKey = (list) => list.map((it) => `${it.id}|${it.title}|${Array.isArray(it.chapters) ? it.chapters.length : "-"}`);

function renderQueue(index) {
  if (dragging) return; // reconstruire la liste annulerait le glisser-déposer en cours
  if (!changed("queue", view.state.current, index, itemsKey(items()))) return;
  $("#queue").replaceChildren(...trackList(index));
  $("#empty").hidden = items().length > 0;
}

// Animateur : il voit les pistes et choisit la prochaine manche
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
  if (hostTracksShown && changed("host", view.state.current, view.state.index, [...played], itemsKey(items()))) {
    $("#host-queue").replaceChildren(...trackList(view.state.index, { picking: true, played }));
  }
}

// --- Affichage -------------------------------------------------------------

function render() {
  if (!view) return;
  const { state, settings, game } = view;
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
  const armed = sure.armed("delete");
  $("#pl-delete").textContent = armed ? t("sure") : "🗑";
  $("#pl-delete").classList.toggle("danger", armed);
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
  renderSettings(settings);

  // Invité d'un salon : pas de playlist à soi ni de blind test, on suit l'hôte
  const guest = view.guest;
  $("#add").hidden = !!guest;
  $("#tabs").hidden = !!guest;
  $("#guest").hidden = !guest;
  $("#listen").hidden = !!guest || blind;
  $("#blind").hidden = !!guest || !blind;
  if (document.activeElement !== $("#volume")) $("#volume").value = String(settings.volume);
  if (guest) return renderGuest(guest);

  // Miniature du morceau (la vidéo est dans l'onglet masqué). En blind test joué, aperçu noir
  // sauf une fois la réponse révélée (ou pendant la manche si on ne masque pas la vidéo).
  const current = items()[state.index];
  const art = $("#art");
  const showArt = current && (!blind || referee || game.phase === "revealed" || (secret && !settings.blind.hideVideo));
  art.hidden = !showArt;
  if (showArt) {
    const src = `https://i.ytimg.com/vi/${current.id}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = blind && !referee;
  $("#mask").hidden = !(secret && settings.blind.hideVideo);
  $("#mask-time").textContent = game.phase === "timeup" ? t("timeUp") : game.clip ? formatTime(game.remaining) : "";
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

  $("#clip").querySelector('option[value="-1"]').disabled = settings.blind.startMode !== "chapter";
  if (document.activeElement !== $("#clip")) $("#clip").value = String(settings.blind.clip);
  if (document.activeElement !== $("#startMode")) $("#startMode").value = settings.blind.startMode;
  $("#hideVideo").checked = settings.blind.hideVideo;
  $("#hints").checked = settings.blind.hints;
  renderHint(secret ? view.hint : null);
  if (document.activeElement !== $("#pause")) $("#pause").value = String(settings.blind.pause);
  if (document.activeElement !== $("#scoring")) $("#scoring").value = settings.blind.scoring;
  if (document.activeElement !== $("#judge")) $("#judge").value = settings.blind.judge;
  $("#scoring-row").hidden = !referee;

  $("#host-tracks").hidden = !referee;
  if (referee) renderHostTracks(game);
  if (blind) renderBlind(game, items().length, referee, multi);
  else renderQueue(state.index);
}

function renderSettings(settings) {
  $("#set-lang").value = settings.lang;
  for (const key of ["chatSound", "showPresets", "hideTab", "showMulti"]) $(`#set-${key}`).checked = settings[key];
  if (document.activeElement !== $("#set-nickname")) $("#set-nickname").value = settings.nickname;
  $("#set-nickname").placeholder = t("defaultName");
  $("#my-code").textContent = view.me.code || "…";
  // Personnes bloquées puis bannies, au format « Nom · CODE »
  $("#blocked").replaceChildren(
    ...peopleList(Object.entries(settings.blocked), { empty: t("noBlocked"), action: t("unblock"), onAction: (id) => act("unblock", id) })
  );
  $("#banned").replaceChildren(
    ...peopleList(Object.entries(settings.banned), { empty: t("noBanned"), action: t("unban"), onAction: (id) => act("unban", id) })
  );
  $("#log").textContent = view.log.join("\n");
}

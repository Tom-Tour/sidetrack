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

// --- Salon -------------------------------------------------------------------

// Bouton 🌐 : affiche les deux lignes du salon au-dessus des onglets
let roomOpen = false;
let hadRoom = false;
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

$("#room-close").addEventListener("click", () => act("closeRoom"));
$("#room-copy").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(view.room.link);
    btn.textContent = t("copied");
  } catch {
    btn.textContent = view.room.link; // copie manuelle
  }
  setTimeout(() => (btn.textContent = t("copyLink")), 2000);
});
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  act("hostChat", text);
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

$("#clip").addEventListener("change", (e) => act("setBlind", "clip", Number(e.target.value)));
$("#startMode").addEventListener("change", (e) => act("setBlind", "startMode", e.target.value));
$("#hideVideo").addEventListener("change", (e) => act("setBlind", "hideVideo", e.target.checked));

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

// Texte de chat : les timecodes (1:23, 1:02:03) deviennent des boutons pour l'hôte
const TIMECODE = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

function chatText(parent, text) {
  let last = 0;
  for (const m of text.matchAll(TIMECODE)) {
    parent.append(text.slice(last, m.index));
    const seconds = (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
    parent.appendChild(button(m[0], () => act("seek", seconds), "tc")).title = t("seekAll");
    last = m.index + m[0].length;
  }
  parent.append(text.slice(last));
}

// Salons publics : un clic sur une ligne rejoint le salon
function renderPublicRooms() {
  $("#public-refresh").classList.toggle("on", view.rooms.loading);
  $("#public-list").replaceChildren(
    ...view.rooms.list.map((r) => {
      const li = el("li");
      li.title = t("join");
      li.append(el("span", `${r.mode === "blind" ? "❓" : "🎵"} ${r.code}`, "name"), el("span", `${r.players} 👤`, "muted"));
      li.addEventListener("click", () => act("joinRoom", r.code));
      return li;
    })
  );
}

function renderRoom(blind) {
  const room = view.room;
  // Le salon s'affiche au-dessus des onglets : les deux lignes, ou le chat une fois dedans
  // À l'ouverture d'un salon, le chat s'affiche ; 🌐 permet ensuite de le replier
  if (room && !hadRoom) roomOpen = true;
  // Après la fermeture, un nouveau nom est proposé (sinon le champ vide montre « Nom du salon »)
  if (!room && hadRoom) $("#room-name").value = suggestName();
  hadRoom = !!room;
  $("#toggle-room").hidden = !view.state.showMulti && !room;
  $("#toggle-room").classList.toggle("on", roomOpen);
  $("#online").hidden = !roomOpen;
  $("#room-panel").hidden = !room;
  $("#room-form").hidden = !!room;
  $("#rooms-row").hidden = !!room;
  if (!room) {
    $("#room-go").textContent = listedRoom() ? t("join") : t("create");
    return renderPublicRooms();
  }
  if (room.code === roomName($("#room-name").value)) $("#room-name").value = "";

  $("#room-code").textContent = room.code;
  $("#room-public-badge").hidden = !room.public;
  if (!$("#room-copy").textContent.startsWith("✓")) $("#room-copy").textContent = t("copyLink");
  $("#room-status").textContent =
    room.status === "opening" ? t("roomOpening") : room.status === "error" ? t("roomError") : t("guests", room.players.length);

  $("#room-players").replaceChildren(
    ...room.players.map((p) => {
      const li = el("li");
      li.append(el("span", p.name), el("b", String(p.score)));
      if (blind) {
        li.append(button("+1", () => act("award", p.id, 1)), button("−1", () => act("award", p.id, -1)));
      }
      return li;
    })
  );

  const chat = $("#chat");
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
  chat.replaceChildren(
    ...room.chat.map((msg) => {
      if (msg.system) return el("p", t(msg.key, ...(msg.args ?? [])), "system");
      const p = el("p", null, msg.private ? "private" : "");
      if (msg.private) p.append("🔒 ");
      p.append(el("b", `${msg.from === "host" ? t("host") : msg.name} : `));
      if (msg.text) chatText(p, msg.text);
      if (msg.ref) {
        const label = `▶ ${msg.ref.label || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`;
        p.append(button(label, () => act("playRef", msg.ref), "ref"));
      }
      // En blind test, l'hôte donne les points directement depuis une proposition
      if (blind && msg.from !== "host") p.append(button("+1", () => act("award", msg.from, 1)));
      return p;
    })
  );
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function renderBlind(game, n, multi) {
  const status = $("#blind-status");
  const actions = $("#blind-actions");
  const total = game.order.length;
  const round = multi
    ? t("round", game.pos + 1, total)
    : `${t("round", game.pos + 1, total)} · ${t("score", game.score, game.played)}`;

  switch (game.phase) {
    case "idle":
      status.textContent = n ? t("tracks", n) : t("emptyShort");
      actions.replaceChildren(button(t("startGame"), () => act("startGame")));
      actions.firstChild.disabled = !n;
      break;
    case "loading":
      status.textContent = t("loadingChapters");
      actions.replaceChildren();
      break;
    case "playing":
      status.textContent = round;
      actions.replaceChildren(button(t("reveal"), () => act("reveal")), button(t("skip"), () => act("nextRound")));
      break;
    case "timeup":
      status.textContent = `${round} · ${t("timeUpBang")}`;
      actions.replaceChildren(button(t("reveal"), () => act("reveal")));
      break;
    case "revealed":
      status.textContent = multi ? `${round} · ${t("givePoints")}` : round;
      actions.replaceChildren(
        ...(multi
          ? [button(t("nextRound"), () => act("nextRound"))]
          : [
              button(t("found"), () => act("answer", true), "good"),
              button(t("missed"), () => act("answer", false), "bad"),
            ])
      );
      break;
    case "over":
      status.textContent = t("gameOver");
      if (!multi) {
        status.append(" : ");
        status.appendChild(el("strong", `${game.score}/${game.played}`));
      }
      actions.replaceChildren(button(t("replay"), () => act("startGame")));
      break;
  }
  $("#blind-settings").hidden = !["idle", "over"].includes(game.phase);
}

// File de lecture : glisser-déposer pour réordonner, ▸ pour dérouler les chapitres
const expanded = new Set();      // ids des vidéos dépliées
const chaptersAsked = new Set(); // ids dont on a demandé les chapitres
let dragging = false;

function renderQueue(index) {
  if (dragging) return; // reconstruire la liste annulerait le glisser-déposer en cours
  $("#queue").replaceChildren(
    ...items().map((item, i) => {
      const li = el("li", null, i === index ? "current" : "");
      li.draggable = true;
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
      row.addEventListener("click", () => act("play", i));
      const del = row.appendChild(
        button("✕", (e) => {
          e.stopPropagation();
          act("removeItem", i);
        }, "del")
      );
      del.title = t("removeItem");

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
          for (const c of item.chapters) {
            const crow = list.appendChild(el("li")).appendChild(el("div", null, "row"));
            crow.append(el("time", formatTime(c.start)), el("span", c.title));
            crow.title = c.title;
            crow.addEventListener("click", () => act("playAt", i, c.start));
          }
        }
      }
      return li;
    })
  );
  $("#empty").hidden = items().length > 0;
}

function render() {
  const { state, game } = view;
  const multi = !!view.room;

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

  const blind = state.mode === "blind";
  // Dans un salon, l'hôte est l'arbitre : il voit tout, même pendant une manche
  const secret = blind && !multi && ["playing", "timeup"].includes(game.phase);
  $("#mode-listen").classList.toggle("on", !blind);
  $("#mode-blind").classList.toggle("on", blind);
  $("#listen").hidden = blind;
  $("#blind").hidden = !blind;
  renderRoom(blind);

  // Miniature du morceau (la vidéo est dans l'onglet masqué). En blind test solo, aperçu noir
  // sauf une fois la réponse révélée (ou pendant la manche si on ne masque pas la vidéo).
  const current = items()[state.index];
  const art = $("#art");
  const showArt =
    current && (!blind || multi || game.phase === "revealed" || (secret && !state.blind.hideVideo));
  art.hidden = !showArt;
  if (showArt) {
    const src = `https://i.ytimg.com/vi/${current.id}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = blind && !multi;
  $("#mask").hidden = !(secret && state.blind.hideVideo);
  $("#mask-time").textContent =
    game.phase === "timeup" ? t("timeUp") : game.clip ? formatTime(game.remaining) : "";
  // Une fois révélé (ou pour l'arbitre), en partie par chapitres, la réponse est le titre du chapitre
  const answer =
    blind && (multi || game.phase === "revealed") && game.chapter?.title
      ? `${game.chapter.title} · ${current?.title ?? ""}`
      : current?.title;
  const timer = blind && multi && game.phase === "playing" && game.clip ? ` · ${formatTime(game.remaining)}` : "";
  $("#now").textContent = secret ? t("mystery") : (answer ?? t("nothingPlaying")) + timer;

  $("#toggle").textContent = view.playerState === 1 ? "⏸" : "▶";
  $("#shuffle").classList.toggle("on", state.shuffle);
  if (document.activeElement !== $("#volume")) $("#volume").value = String(state.volume ?? 100);

  $("#clip").querySelector('option[value="-1"]').disabled = state.blind.startMode !== "chapter";
  if (document.activeElement !== $("#clip")) $("#clip").value = String(state.blind.clip);
  if (document.activeElement !== $("#startMode")) $("#startMode").value = state.blind.startMode;
  $("#hideVideo").checked = state.blind.hideVideo;

  $("#lang").value = state.lang ?? "auto";
  $("#show-multi").checked = state.showMulti !== false;
  $("#log").textContent = view.log.join("\n");

  if (blind) renderBlind(game, items().length, multi);
  else renderQueue(state.index);
}

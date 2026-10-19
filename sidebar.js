// Page du lecteur (dossier player/), hébergée sur GitHub Pages.
const PLAYER_URL = "https://tom-tour.github.io/sidetrack/player/index.html";

const $ = (s) => document.querySelector(s);
const frame = $("#player");

// État sauvegardé dans storage.local
let state = {
  playlists: [],       // [{ id, name, items: [{ id, title }] }]
  current: null,       // id de la playlist affichée
  index: -1,           // morceau en cours dans la playlist
  shuffle: false,
  mode: "listen",      // "listen" | "blind"
  blind: { clip: 20, randomStart: true, hideVideo: true },
};

let playerState = -1;  // -1 non démarré, 0 fini, 1 lecture, 2 pause, 5 prête
let importTarget = null;

// Partie de blind test en cours (non sauvegardée)
let game = { phase: "idle", order: [], pos: -1, score: 0, played: 0, remaining: 0, timer: null };

function log(msg) {
  const t = new Date().toLocaleTimeString();
  $("#log").textContent = `[${t}] ${msg}\n` + $("#log").textContent;
}

function save() {
  browser.storage.local.set({ sidetrack: state });
}

// --- Playlists -------------------------------------------------------------

function playlist(id = state.current) {
  return state.playlists.find((p) => p.id === id);
}

function items() {
  return playlist()?.items ?? [];
}

function createPlaylist(name) {
  const p = { id: crypto.randomUUID(), name, items: [] };
  state.playlists.push(p);
  selectPlaylist(p.id);
  return p;
}

function selectPlaylist(id) {
  if (state.current === id) return;
  state.current = id;
  state.index = -1;
  resetGame();
  send({ action: "pause" });
  render();
  save();
}

function deletePlaylist() {
  state.playlists = state.playlists.filter((p) => p.id !== state.current);
  state.current = null;
  if (state.playlists.length) selectPlaylist(state.playlists[0].id);
  else createPlaylist("Ma playlist");
}

let editing = null; // "new" | "rename" | null

function startEditing(kind) {
  editing = kind;
  const input = $("#pl-name");
  input.value = kind === "rename" ? playlist()?.name ?? "" : "";
  input.hidden = false;
  $("#pl-select").hidden = true;
  input.focus();
  input.select();
}

function stopEditing(commit) {
  const name = $("#pl-name").value.trim();
  if (commit && name) {
    if (editing === "new") createPlaylist(name);
    else if (playlist()) playlist().name = name;
    save();
  }
  editing = null;
  $("#pl-name").hidden = true;
  $("#pl-select").hidden = false;
  render();
}

$("#pl-select").addEventListener("change", (e) => selectPlaylist(e.target.value));
$("#pl-new").addEventListener("click", () => startEditing("new"));
$("#pl-rename").addEventListener("click", () => startEditing("rename"));
$("#pl-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") stopEditing(true);
  if (e.key === "Escape") stopEditing(false);
});
$("#pl-name").addEventListener("blur", () => editing && stopEditing(true));

// Suppression en deux clics (confirm() n'est pas disponible dans la barre latérale)
let deleteArmed = null;
$("#pl-delete").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  if (deleteArmed) {
    clearTimeout(deleteArmed);
    deleteArmed = null;
    btn.textContent = "🗑";
    btn.classList.remove("danger");
    deletePlaylist();
    return;
  }
  btn.textContent = "Sûr ?";
  btn.classList.add("danger");
  deleteArmed = setTimeout(() => {
    deleteArmed = null;
    btn.textContent = "🗑";
    btn.classList.remove("danger");
  }, 3000);
});

// --- Analyse des liens ---------------------------------------------------

function parseLink(text) {
  text = text.trim();
  if (/^[\w-]{11}$/.test(text)) return { id: text, list: null };
  try {
    const u = new URL(text);
    let id = u.searchParams.get("v");
    if (u.hostname === "youtu.be") id = u.pathname.slice(1, 12);
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
    if (m) id = m[2];
    if (id && !/^[\w-]{11}$/.test(id)) id = null;
    return { id, list: u.searchParams.get("list") };
  } catch {
    return { id: null, list: null };
  }
}

async function fetchTitle(item) {
  try {
    const r = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + item.id)
    );
    item.title = r.ok ? (await r.json()).title : `(indisponible) ${item.id}`;
  } catch {
    item.title = item.id;
  }
  render();
  save();
}

function addItems(p, ids) {
  for (const id of ids) {
    const item = { id, title: id };
    p.items.push(item);
    fetchTitle(item);
  }
}

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = playlist();
  const { id, list } = parseLink($("#url").value);
  if (list && !id) {
    importTarget = p.id;
    log(`Import de la playlist ${list}…`);
    send({ action: "playlist", list });
  } else if (id) {
    addItems(p, [id]);
    if (state.mode === "listen" && (state.index < 0 || playerState === 0)) play(p.items.length - 1);
    else render();
  } else {
    log("✗ Lien non reconnu");
    return;
  }
  $("#url").value = "";
  save();
});

function removeItem(i) {
  items().splice(i, 1);
  if (i < state.index) state.index--;
  else if (i === state.index) state.index = -1;
  render();
  save();
}

// --- Lecteur ---------------------------------------------------------------

function send(cmd) {
  frame.contentWindow?.postMessage({ sidetrack: true, ...cmd }, new URL(PLAYER_URL).origin);
}

function play(i, opts = {}) {
  if (i < 0 || i >= items().length) return;
  state.index = i;
  send({ action: "load", id: items()[i].id, ...opts });
  render();
  save();
}

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow || !e.data?.sidetrack) return;
  const msg = e.data;
  switch (msg.type) {
    case "ready":
      log("✓ Lecteur prêt");
      break;
    case "state":
      playerState = msg.state;
      if (msg.state === 0) onEnded();
      break;
    case "started":
      if (state.mode === "blind" && game.phase === "playing") startCountdown();
      break;
    case "error":
      log(`✗ Erreur YouTube ${msg.code}`);
      if (msg.code === "playlist-empty") break;
      if (state.mode === "blind") setTimeout(nextRound, 1000);
      else setTimeout(next, 1500);
      break;
    case "playlist": {
      const p = playlist(importTarget) ?? playlist();
      log(`✓ Playlist importée : ${msg.ids.length} vidéos`);
      const start = p.items.length;
      addItems(p, msg.ids);
      if (state.mode === "listen" && p.id === state.current) play(start);
      else render();
      save();
      break;
    }
  }
});

function onEnded() {
  if (state.mode === "listen") next();
  else if (game.phase === "playing") timeUp();
}

// --- Mode écoute -----------------------------------------------------------

function next() {
  const n = items().length;
  if (!n) return;
  if (state.shuffle && n > 1) {
    let i;
    do i = Math.floor(Math.random() * n); while (i === state.index);
    play(i);
  } else if (state.index + 1 < n) {
    play(state.index + 1);
  }
}

function prev() {
  if (state.index > 0) play(state.index - 1);
}

$("#prev").addEventListener("click", prev);
$("#next").addEventListener("click", next);
$("#toggle").addEventListener("click", () => {
  if (state.index < 0 && items().length) return play(0);
  send({ action: playerState === 1 ? "pause" : "play" });
});
$("#shuffle").addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  render();
  save();
});

// --- Mode blind test -------------------------------------------------------

function shuffled(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resetGame() {
  clearInterval(game.timer);
  game = { phase: "idle", order: [], pos: -1, score: 0, played: 0, remaining: 0, timer: null };
}

function startGame() {
  resetGame();
  game.order = shuffled(items().length);
  nextRound();
}

function nextRound() {
  clearInterval(game.timer);
  game.pos++;
  if (game.pos >= game.order.length) {
    game.phase = "over";
    send({ action: "pause" });
    render();
    return;
  }
  game.phase = "playing";
  game.remaining = state.blind.clip;
  play(game.order[game.pos], { randomStart: state.blind.randomStart, clip: state.blind.clip });
}

function startCountdown() {
  clearInterval(game.timer);
  if (!state.blind.clip) return render();
  game.timer = setInterval(() => {
    game.remaining--;
    if (game.remaining <= 0) timeUp();
    else render();
  }, 1000);
  render();
}

function timeUp() {
  clearInterval(game.timer);
  game.remaining = 0;
  game.phase = "timeup";
  send({ action: "pause" });
  render();
}

function reveal() {
  clearInterval(game.timer);
  game.phase = "revealed";
  send({ action: "play" });
  render();
}

function answer(found) {
  if (found) game.score++;
  game.played++;
  nextRound();
}

function blindButton(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function renderBlind() {
  const n = items().length;
  const status = $("#blind-status");
  const actions = $("#blind-actions");
  const round = `Manche ${game.pos + 1}/${game.order.length} · Score ${game.score}/${game.played}`;

  switch (game.phase) {
    case "idle":
      status.textContent = n ? `${n} morceau${n > 1 ? "x" : ""} dans la playlist.` : "Playlist vide.";
      actions.replaceChildren(blindButton("▶ Démarrer la partie", startGame));
      actions.firstChild.disabled = !n;
      break;
    case "playing":
      status.textContent = round;
      actions.replaceChildren(blindButton("👁 Révéler", reveal), blindButton("⏭ Passer", nextRound));
      break;
    case "timeup":
      status.textContent = `${round} · Temps écoulé !`;
      actions.replaceChildren(blindButton("👁 Révéler", reveal));
      break;
    case "revealed":
      status.textContent = round;
      actions.replaceChildren(
        blindButton("✓ Trouvé", () => answer(true), "good"),
        blindButton("✗ Raté", () => answer(false), "bad")
      );
      break;
    case "over":
      status.innerHTML = "";
      status.append("Partie terminée : ");
      status.appendChild(document.createElement("strong")).textContent = `${game.score}/${game.played}`;
      actions.replaceChildren(blindButton("↻ Rejouer", startGame));
      break;
  }
  $("#blind-settings").hidden = !["idle", "over"].includes(game.phase);
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  resetGame();
  send({ action: "pause" });
  render();
  save();
}

$("#mode-listen").addEventListener("click", () => setMode("listen"));
$("#mode-blind").addEventListener("click", () => setMode("blind"));

$("#clip").addEventListener("change", (e) => {
  state.blind.clip = Number(e.target.value);
  save();
});
for (const key of ["randomStart", "hideVideo"]) {
  $("#" + key).addEventListener("change", (e) => {
    state.blind[key] = e.target.checked;
    save();
  });
}

// --- Affichage -------------------------------------------------------------

function formatTime(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function render() {
  // Barre des playlists
  const select = $("#pl-select");
  select.replaceChildren(
    ...state.playlists.map((p) => {
      const o = new Option(`${p.name} (${p.items.length})`, p.id);
      o.selected = p.id === state.current;
      return o;
    })
  );

  const blind = state.mode === "blind";
  const secret = blind && ["playing", "timeup"].includes(game.phase);
  $("#mode-listen").classList.toggle("on", !blind);
  $("#mode-blind").classList.toggle("on", blind);
  $("#listen").hidden = blind;
  $("#blind").hidden = !blind;

  // Masque du lecteur pendant une manche
  $("#mask").hidden = !(secret && state.blind.hideVideo);
  $("#mask-time").textContent =
    game.phase === "timeup" ? "Temps écoulé" : state.blind.clip ? formatTime(game.remaining) : "";

  const current = items()[state.index];
  $("#now").textContent = secret ? "Morceau mystère" : current?.title ?? "Rien en lecture";

  if (blind) return renderBlind();

  // File de lecture
  $("#queue").replaceChildren(
    ...items().map((item, i) => {
      const li = document.createElement("li");
      const span = li.appendChild(document.createElement("span"));
      span.textContent = item.title;
      span.title = item.title;
      if (i === state.index) li.className = "current";
      li.addEventListener("click", () => play(i));
      const del = li.appendChild(document.createElement("button"));
      del.textContent = "✕";
      del.title = "Retirer de la playlist";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeItem(i);
      });
      return li;
    })
  );
  $("#empty").hidden = items().length > 0;
  $("#shuffle").classList.toggle("on", state.shuffle);
}

// --- Démarrage -------------------------------------------------------------

frame.src = PLAYER_URL;

browser.storage.local.get(["sidetrack", "queue"]).then((s) => {
  if (s.sidetrack) {
    state = { ...state, ...s.sidetrack, blind: { ...state.blind, ...s.sidetrack.blind } };
  } else if (s.queue?.length) {
    // Reprise de la file du premier prototype
    state.playlists = [{ id: crypto.randomUUID(), name: "Ma playlist", items: s.queue }];
    browser.storage.local.remove(["queue", "index", "shuffle"]);
  }
  if (!state.playlists.length) state.playlists.push({ id: crypto.randomUUID(), name: "Ma playlist", items: [] });
  if (!playlist()) state.current = state.playlists[0].id;
  state.index = -1;

  $("#clip").value = String(state.blind.clip);
  $("#randomStart").checked = state.blind.randomStart;
  $("#hideVideo").checked = state.blind.hideVideo;
  render();
  save();
});

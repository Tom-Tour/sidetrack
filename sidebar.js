// Télécommande : tout le moteur tourne dans background.js.
// On envoie des commandes par le port et on affiche l'état qu'il renvoie.

const $ = (s) => document.querySelector(s);

const port = browser.runtime.connect({ name: "sidebar" });
let view = null; // { state, game, playerState, notice, log }

function act(cmd, ...args) {
  port.postMessage({ cmd, args });
}

port.onMessage.addListener((snap) => {
  view = snap;
  render();
});

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
  btn.textContent = "Sûr ?";
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

function formatTime(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderNotice() {
  const el = $("#notice");
  el.hidden = !view.notice;
  if (!view.notice) return;
  el.textContent = view.notice.text;
  const row = el.appendChild(document.createElement("div"));
  if (view.notice.focus) row.appendChild(button("Aller à l'onglet", () => act("focusPlayer")));
  row.appendChild(button("OK", () => act("dismissNotice")));
}

function renderBlind(game, n) {
  const status = $("#blind-status");
  const actions = $("#blind-actions");
  const round = `Manche ${game.pos + 1}/${game.order.length} · Score ${game.score}/${game.played}`;

  switch (game.phase) {
    case "idle":
      status.textContent = n ? `${n} morceau${n > 1 ? "x" : ""} dans la playlist.` : "Playlist vide.";
      actions.replaceChildren(button("▶ Démarrer la partie", () => act("startGame")));
      actions.firstChild.disabled = !n;
      break;
    case "loading":
      status.textContent = "Chargement des chapitres…";
      actions.replaceChildren();
      break;
    case "playing":
      status.textContent = round;
      actions.replaceChildren(button("👁 Révéler", () => act("reveal")), button("⏭ Passer", () => act("nextRound")));
      break;
    case "timeup":
      status.textContent = `${round} · Temps écoulé !`;
      actions.replaceChildren(button("👁 Révéler", () => act("reveal")));
      break;
    case "revealed":
      status.textContent = round;
      actions.replaceChildren(
        button("✓ Trouvé", () => act("answer", true), "good"),
        button("✗ Raté", () => act("answer", false), "bad")
      );
      break;
    case "over":
      status.textContent = "Partie terminée : ";
      status.appendChild(document.createElement("strong")).textContent = `${game.score}/${game.played}`;
      actions.replaceChildren(button("↻ Rejouer", () => act("startGame")));
      break;
  }
  $("#blind-settings").hidden = !["idle", "over"].includes(game.phase);
}

function renderQueue(index) {
  $("#queue").replaceChildren(
    ...items().map((item, i) => {
      const li = document.createElement("li");
      const span = li.appendChild(document.createElement("span"));
      span.textContent = item.title;
      span.title = item.title;
      if (i === index) li.className = "current";
      li.addEventListener("click", () => act("play", i));
      const del = li.appendChild(button("✕", (e) => {
        e.stopPropagation();
        act("removeItem", i);
      }));
      del.title = "Retirer de la playlist";
      return li;
    })
  );
  $("#empty").hidden = items().length > 0;
}

function render() {
  const { state, game } = view;

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
  const secret = blind && ["playing", "timeup"].includes(game.phase);
  $("#mode-listen").classList.toggle("on", !blind);
  $("#mode-blind").classList.toggle("on", blind);
  $("#listen").hidden = blind;
  $("#blind").hidden = !blind;

  // Miniature du morceau (la vidéo est dans l'onglet masqué). En blind test, aperçu noir
  // sauf une fois la réponse révélée (ou pendant la manche si on ne masque pas la vidéo).
  const current = items()[state.index];
  const art = $("#art");
  const showArt =
    current && (!blind || game.phase === "revealed" || (secret && !state.blind.hideVideo));
  art.hidden = !showArt;
  if (showArt) {
    const src = `https://i.ytimg.com/vi/${current.id}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = blind;
  $("#mask").hidden = !(secret && state.blind.hideVideo);
  $("#mask-time").textContent =
    game.phase === "timeup" ? "Temps écoulé" : game.clip ? formatTime(game.remaining) : "";
  // Une fois révélé, en partie par chapitres, la réponse est le titre du chapitre
  const answer =
    blind && game.phase === "revealed" && game.chapter?.title
      ? `${game.chapter.title} · ${current?.title ?? ""}`
      : current?.title;
  $("#now").textContent = secret ? "Morceau mystère" : answer ?? "Rien en lecture";

  $("#toggle").textContent = view.playerState === 1 ? "⏸" : "▶";
  $("#shuffle").classList.toggle("on", state.shuffle);
  if (document.activeElement !== $("#volume")) $("#volume").value = String(state.volume ?? 100);

  $("#clip").querySelector('option[value="-1"]').disabled = state.blind.startMode !== "chapter";
  if (document.activeElement !== $("#clip")) $("#clip").value = String(state.blind.clip);
  if (document.activeElement !== $("#startMode")) $("#startMode").value = state.blind.startMode;
  $("#hideVideo").checked = state.blind.hideVideo;

  $("#log").textContent = view.log.join("\n");

  if (blind) renderBlind(game, items().length);
  else renderQueue(state.index);
}

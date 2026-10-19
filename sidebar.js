// Page du lecteur (dossier player/), hébergée sur GitHub Pages.
const PLAYER_URL = "https://tom-tour.github.io/sidetrack/player/index.html";

const $ = (s) => document.querySelector(s);
const frame = $("#player");

let queue = [];        // [{ id, title }]
let index = -1;
let shuffle = false;
let playerState = -1;  // -1 non démarré, 0 fini, 1 lecture, 2 pause, 5 prête

function log(msg) {
  const t = new Date().toLocaleTimeString();
  $("#log").textContent = `[${t}] ${msg}\n` + $("#log").textContent;
}

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

// --- Lecteur ---------------------------------------------------------------

function send(cmd) {
  frame.contentWindow?.postMessage({ sidetrack: true, ...cmd }, new URL(PLAYER_URL).origin);
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
      if (msg.state === 0) next();
      break;
    case "error":
      log(`✗ Erreur YouTube ${msg.code}, passage au suivant`);
      if (msg.code !== "playlist-empty") setTimeout(next, 1500);
      break;
    case "playlist":
      importPlaylist(msg.ids);
      break;
  }
});

function importPlaylist(ids) {
  log(`✓ Playlist importée : ${ids.length} vidéos`);
  const start = queue.length;
  for (const id of ids) {
    const item = { id, title: id };
    queue.push(item);
    fetchTitle(item);
  }
  play(start);
}

// --- File de lecture -------------------------------------------------------

function play(i) {
  if (i < 0 || i >= queue.length) return;
  index = i;
  send({ action: "load", id: queue[i].id });
  render();
  save();
}

function next() {
  if (!queue.length) return;
  if (shuffle && queue.length > 1) {
    let i;
    do i = Math.floor(Math.random() * queue.length); while (i === index);
    play(i);
  } else if (index + 1 < queue.length) {
    play(index + 1);
  }
}

function prev() {
  if (index > 0) play(index - 1);
}

function render() {
  $("#queue").replaceChildren(
    ...queue.map((item, i) => {
      const li = document.createElement("li");
      li.textContent = item.title;
      li.title = item.title;
      if (i === index) li.className = "current";
      li.addEventListener("click", () => play(i));
      return li;
    })
  );
  $("#now").textContent = queue[index]?.title ?? "Rien en lecture";
  $("#shuffle").classList.toggle("on", shuffle);
}

function save() {
  browser.storage.local.set({ queue, index, shuffle });
}

// --- Interface -------------------------------------------------------------

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const { id, list } = parseLink($("#url").value);
  if (list && !id) {
    log(`Import de la playlist ${list}…`);
    send({ action: "playlist", list });
  } else if (id) {
    const item = { id, title: id };
    queue.push(item);
    fetchTitle(item);
    if (index < 0 || playerState === 0) play(queue.length - 1);
    else render();
  } else {
    log("✗ Lien non reconnu");
    return;
  }
  $("#url").value = "";
});

$("#prev").addEventListener("click", prev);
$("#next").addEventListener("click", next);
$("#toggle").addEventListener("click", () => {
  if (index < 0 && queue.length) return play(0);
  send({ action: playerState === 1 ? "pause" : "play" });
});
$("#shuffle").addEventListener("click", () => {
  shuffle = !shuffle;
  render();
  save();
});
$("#clear").addEventListener("click", () => {
  queue = [];
  index = -1;
  render();
  save();
});

frame.src = PLAYER_URL;
log(`Lecteur : ${PLAYER_URL}`);

browser.storage.local.get(["queue", "index", "shuffle"]).then((s) => {
  queue = s.queue ?? [];
  index = s.index ?? -1;
  shuffle = !!s.shuffle;
  render();
});

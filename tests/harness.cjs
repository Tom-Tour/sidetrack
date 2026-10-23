// Banc d'essai commun aux tests : moteurs Sidetrack dans des contextes vm séparés, faux réseau
// PeerJS, faux relais Nostr, faux Worker (vrai pow-worker.js, difficulté réduite), et
// barre latérale ou page invité dans jsdom reliées à ces moteurs.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Attend une condition (jamais un délai fixe) : true si elle est vraie avant `ms`
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await wait(15);
  }
  try {
    return !!fn();
  } catch {
    return false;
  }
}

let failures = 0;
function check(name, ok, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
}
function done() {
  console.log(failures ? `\n${failures} échec(s)` : "\nTout passe");
  process.exit(failures ? 1 : 0);
}

// Difficulté réduite (2 bits au lieu de 7) et, au besoin, battement de cœur accéléré
function transform(code, opts = {}) {
  code = code.replace("BITS: 7,", "BITS: 2,");
  if (opts.fastHeartbeat) code = code.replace("const HEARTBEAT = { EVERY: 5 * 1000, SILENCE: 30 * 1000 };", "const HEARTBEAT = { EVERY: 200, SILENCE: 1500 };");
  return code;
}

// --- Faux réseau PeerJS (commun à tous les moteurs et pages) ---
const peers = new Map();
function makePeerClass(parse) {
  return function Peer(id) {
    const h = {};
    const self = {
      id: id ?? "p-" + Math.random().toString(36).slice(2, 10),
      parse,
      h,
      conns: [],
      on: (e, fn) => (h[e] = fn),
      destroy() {
        if (peers.get(self.id) === self) peers.delete(self.id);
        for (const c of self.conns) c.close();
      },
      reconnect() {},
      connect(target) {
        const host = peers.get(target);
        const mine = makeConn(parse);
        self.conns.push(mine);
        if (!host) {
          setTimeout(() => h.error?.({ type: "peer-unavailable" }), 5);
          return mine;
        }
        const theirs = makeConn(host.parse);
        host.conns.push(theirs);
        mine.other = theirs;
        theirs.other = mine;
        setTimeout(() => {
          host.h.connection?.(theirs);
          setTimeout(() => {
            mine.open = theirs.open = true;
            mine.h.open?.();
            theirs.h.open?.();
          }, 5);
        }, 5);
        return mine;
      },
    };
    if (id && peers.has(id)) {
      setTimeout(() => h.error?.({ type: "unavailable-id" }), 5);
      return self;
    }
    peers.set(self.id, self);
    setTimeout(() => h.open?.(self.id), 5);
    return self;
  };
}
function makeConn(parse) {
  const c = {
    parse,
    open: false,
    h: {},
    on: (e, fn) => (c.h[e] = fn),
    send(msg) {
      if (!c.open) return;
      if (c.mute) return; // connexion morte sans le dire (test des fantômes)
      const copy = c.other.parse(JSON.stringify(msg));
      setTimeout(() => c.other?.h.data?.(copy), 1);
    },
    close() {
      if (!c.open) return;
      c.open = false;
      c.h.close?.();
      if (c.other?.open) c.other.close();
    },
  };
  return c;
}

// --- Faux Worker : le vrai pow-worker.js dans son propre contexte ---
class FakeWorker {
  constructor(file) {
    const clean = file.replace(/\?.*$/, "").replace(/^\.\.\//, "");
    const w = vm.createContext({ TextEncoder, Uint8Array, Uint32Array, Int32Array, Math, setTimeout, console });
    const base = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/") + 1) : "";
    w.importScripts = (f) => vm.runInContext(read(base + f), w);
    w.postMessage = (data) => setTimeout(() => this.onmessage?.({ data: JSON.parse(JSON.stringify(data)) }));
    vm.runInContext("var self = this;", w);
    vm.runInContext(read(clean), w);
    this.w = w;
    FakeWorker.created++;
  }
  postMessage(data) {
    setTimeout(() => this.w.onmessage({ data }));
  }
  terminate() {}
}
FakeWorker.created = 0;

// --- Faux relais Nostr ---
const relay = { events: [] };
class FakePool {
  publish(_r, ev) {
    relay.events.push(ev);
    return [Promise.resolve("ok")];
  }
  querySync(_r, filter) {
    return Promise.resolve(relay.events.filter((e) => filter.kinds.includes(e.kind) && e.tags.some((t) => t[0] === "t" && filter["#t"].includes(t[1]))));
  }
}

// --- Un moteur complet (background.js et ses scripts), avec son faux onglet de lecteur ---
function makeEngine(label, stored = {}, opts = {}) {
  const listeners = { connect: [], activated: [] };
  const store = JSON.parse(JSON.stringify(stored));
  const player = { cmds: [], port: null, opened: 0 };
  const badge = { text: "", color: null };
  let tabSeq = 0;
  const ev = (arr) => ({ addListener: (f) => arr.push(f) });
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, performance, structuredClone,
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder, Uint8Array,
    navigator: { language: opts.language ?? "fr-FR" },
    RTCPeerConnection: function () {},
    Worker: FakeWorker,
    WebSocket: class {
      constructor() {
        throw new Error("pas de réseau dans les tests");
      }
    },
    browser: {
      runtime: { onConnect: ev(listeners.connect), getManifest: () => JSON.parse(read("manifest.json")) },
      tabs: {
        onActivated: ev(listeners.activated),
        query: async () => [],
        create: async (o) => {
          const id = ++tabSeq;
          if (!String(o.url).includes("/player/")) return { id };
          player.opened++;
          setTimeout(() => {
            const handlers = { msg: [], disc: [] };
            const port = {
              name: "player",
              sender: { tab: { id, active: true } },
              onDisconnect: ev(handlers.disc),
              onMessage: ev(handlers.msg),
              postMessage: (m) => player.cmds.push(JSON.parse(JSON.stringify(m))),
              deliver: (m) => handlers.msg.forEach((f) => f(m)),
              close: () => handlers.disc.forEach((f) => f()),
            };
            player.port = port;
            listeners.connect.forEach((l) => l(port));
          }, 5);
          return { id };
        },
        remove: async () => {},
        update: async () => {},
        hide: async () => {},
        show: async () => {},
      },
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            for (const k of [].concat(keys)) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
            return out;
          },
          set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
        },
      },
      browserAction: {
        onClicked: ev([]),
        setBadgeText: async ({ text }) => (badge.text = text),
        setBadgeBackgroundColor: async ({ color }) => (badge.color = color),
      },
      sidebarAction: { toggle() {} },
    },
  });
  ctx.Peer = makePeerClass(vm.runInContext("JSON.parse", ctx));
  vm.runInContext(read("vendor/nostr.bundle.js"), ctx, { filename: "nostr.bundle.js" });
  ctx.NostrTools = { ...ctx.NostrTools, SimplePool: FakePool };
  const manifest = JSON.parse(read("manifest.json"));
  for (const f of manifest.background.scripts.filter((f) => !f.startsWith("vendor/"))) {
    vm.runInContext(transform(read(f), opts), ctx, { filename: `${label}:${f}` });
  }

  // Une barre latérale (port « sidebar ») : instantanés reçus, commandes et réponses
  function sidebar() {
    const handlers = { msg: [], disc: [] };
    const inbox = [];
    const port = {
      name: "sidebar",
      onMessage: ev(handlers.msg),
      onDisconnect: ev(handlers.disc),
      postMessage: (m) => inbox.push(JSON.parse(JSON.stringify(m))),
    };
    listeners.connect.forEach((l) => l(port));
    let req = 0;
    return {
      inbox,
      act: (cmd, ...args) => handlers.msg.forEach((h) => h({ cmd, args })),
      async ask(cmd, ...args) {
        const id = ++req + 1000;
        handlers.msg.forEach((h) => h({ cmd, args, req: id }));
        await until(() => inbox.some((m) => m.t === "reply" && m.req === id), 3000);
        return inbox.find((m) => m.t === "reply" && m.req === id)?.error;
      },
      snap: () => [...inbox].reverse().find((m) => m.t === "snap")?.snap,
      close: () => handlers.disc.forEach((h) => h()),
    };
  }
  const main = sidebar();
  return {
    label, ctx, store, player, badge, listeners,
    sidebar,
    act: main.act,
    ask: main.ask,
    snap: main.snap,
    closePanel: main.close,
    fromPlayer: (msg) => player.port?.deliver(msg),
    eval: (code) => vm.runInContext(code, ctx),
    errors: () => (main.snap()?.log ?? []).filter((l) => l.includes("✗")),
  };
}

// --- La vraie barre latérale dans jsdom, reliée au moteur ---
function sidebarFor(engine, language = "fr-FR") {
  const { JSDOM } = require("jsdom");
  const html = read("sidebar.html").replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  Object.defineProperty(win.navigator, "language", { value: language });
  const errors = [];
  win.addEventListener("error", (e) => errors.push(e.message));
  win.Blob.prototype.text ??= function () {
    return new Promise((resolve) => {
      const r = new win.FileReader();
      r.onload = () => resolve(r.result);
      r.readAsText(this);
    });
  };
  win.browser = {
    runtime: {
      getManifest: () => JSON.parse(read("manifest.json")),
      connect: () => {
        const handlers = { msg: [], disc: [] };
        const engineSide = {
          name: "sidebar",
          onMessage: { addListener: (f) => handlers.msg.push(f) },
          onDisconnect: { addListener: (f) => handlers.disc.push(f) },
          postMessage: (m) => side.deliver?.(JSON.parse(JSON.stringify(m))),
        };
        const side = {
          onMessage: { addListener: (f) => (side.deliver = f) },
          postMessage: (m) => handlers.msg.forEach((h) => h(JSON.parse(JSON.stringify(m)))),
        };
        setTimeout(() => engine.listeners.connect.forEach((l) => l(engineSide)), 5);
        return side;
      },
    },
  };
  // Comme dans la page : scripts classiques qui partagent leurs déclarations (STRINGS…)
  const scripts = ["common/i18n-core.js", "i18n.js", "common/ui.js", "presets.js", "sidebar.js"].map(read).join("\n;\n");
  win.eval(scripts);
  const $ = (s) => win.document.querySelector(s);
  const $$ = (s) => [...win.document.querySelectorAll(s)];
  return {
    win, $, $$, errors,
    click: (s) => (typeof s === "string" ? $(s) : s).dispatchEvent(new win.MouseEvent("click", { bubbles: true })),
    fire: (s, type) => (typeof s === "string" ? $(s) : s).dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true })),
    type(s, value) {
      $(s).value = value;
      $(s).dispatchEvent(new win.Event("input", { bubbles: true }));
    },
  };
}

// --- La vraie page invité (join/) dans jsdom ---
function joinPage(code, language = "fr-FR", storage = {}) {
  const { JSDOM } = require("jsdom");
  const html = read("join/index.html").replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
  const dom = new JSDOM(html, { url: `https://tom-tour.github.io/sidetrack/join/#${code}`, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  Object.defineProperty(win.navigator, "language", { value: language });
  const errors = [];
  win.addEventListener("error", (e) => errors.push(e.message));
  // Ce que jsdom n'a pas : encodeur dont les octets sont du bon contexte (sinon nostr-tools refuse)
  const Outer = TextEncoder;
  win.TextEncoder = class {
    encode(s) {
      return win.Uint8Array.from(new Outer().encode(s));
    }
  };
  win.TextDecoder = TextDecoder;
  win.MessageChannel = MessageChannel;
  win.Peer = makePeerClass(win.JSON.parse);
  win.Worker = FakeWorker;
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  // Comme dans la page : scripts classiques qui partagent leurs déclarations
  const scripts = [read("vendor/nostr.bundle.js") + ";window.NostrTools = NostrTools;", ...["common/i18n-core.js", "i18n.js", "common/net.js", "common/pow.js", "common/ui.js", "join/join.js"].map((f) => transform(read(f)))].join("\n;\n");
  win.eval(scripts);
  const $ = (s) => win.document.querySelector(s);
  return {
    win, $, errors,
    join(name) {
      $("#name").value = name;
      $("#login-form").dispatchEvent(new win.Event("submit", { cancelable: true }));
    },
    say(text) {
      $("#chat-input").value = text;
      $("#chat-form").dispatchEvent(new win.Event("submit", { cancelable: true }));
    },
    chat: () => [...$("#chat").children].map((p) => p.textContent),
  };
}

const playlist = {
  playlists: [{
    id: "p1",
    name: "Soirée",
    items: [
      { id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up", chapters: [{ title: "Intro", start: 0 }, { title: "Refrain", start: 43 }] },
      { id: "9bZkp7q19f0", title: "PSY - Gangnam Style", chapters: [] },
    ],
  }],
  current: "p1",
};

module.exports = { DIR, read, wait, until, check, done, makeEngine, sidebarFor, joinPage, playlist, peers, relay, FakeWorker, transform };

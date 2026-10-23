// addon-kit — outils réseau communs (salons pair-à-pair PeerJS + présence Nostr).
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.
// Fonctions pures, sans état : chaque extension garde sa propre logique de salon.

const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"];
const HELLO_KIND = 27235; // poignée de main signée : jamais publiée, seulement échangée
const PRESENCE_KIND = 30078; // annonce remplaçable (une par clé jetable)

// Limites identiques dans toutes les extensions (GUIDE.md, « Protection ») : la réception
// tolère un peu plus que l'envoi, si bien qu'un client normal n'est jamais filtré.
const LIMITS = {
  SEND_PER_SECOND: 2, // chat et messages privés envoyés
  RECV_PER_SECOND: 3, // chat et messages privés acceptés, par personne
  META_PER_SECOND: 4, // autres messages (profil, ping…), par personne
  LIVE_PER_SECOND: 40, // flux continus (curseurs…), par personne
  FLOOD_DROPS: 30, // messages refusés en 10 s avant la sourdine
  FLOOD_MUTE: 60 * 1000,
  TEXT_MAX: 500,
  NAME_MAX: 24,
  MAX_PEERS: 24,
};

// Battement de cœur : WebRTC ne signale pas toujours une connexion perdue (navigateur fermé
// brutalement, extension rechargée, réseau coupé). Chaque côté envoie { t: "ping" } toutes
// les EVERY ms ; une connexion dont rien n'est arrivé depuis SILENCE ms est fermée, sinon
// la personne resterait affichée en fantôme et reviendrait en double.
const HEARTBEAT = { EVERY: 5 * 1000, SILENCE: 30 * 1000 };

// Couleurs du badge du bouton de la barre d'outils (GUIDE.md section 3) : rouge pour les
// messages privés non lus, bleu pour le nombre propre à l'extension
const BADGE_COLORS = { PRIVATE: "#e5484d", COUNT: "#0090ff" };

const nowSeconds = () => Math.floor(Date.now() / 1000);

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

// Couleurs des personnes, lisibles sur fond clair comme sombre (choix de couleur dans les
// réglages, ou couleur tirée de l'identité avec colorFor)
const PALETTE = ["#e5484d", "#f76b15", "#d5a000", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8e4ec6", "#ab6400"];

// Couleur stable pour une identité (clé publique en hexadécimal)
function colorFor(id) {
  return PALETTE[parseInt(String(id).slice(0, 8), 16) % PALETTE.length || 0];
}

// Journal (Réglages > Journal) : « [heure] texte », la ligne la plus récente en premier.
//   const journal = createLog();  journal.add("…");  snapshot : { log: journal.lines }
function createLog(max = 100) {
  const lines = [];
  return {
    lines,
    add(text) {
      lines.unshift(`[${new Date().toLocaleTimeString()}] ${text}`);
      lines.length = Math.min(lines.length, max);
    },
  };
}

// Compteur glissant sur une seconde : true si l'événement passe (et il est compté)
function rateOk(times, limit, now = Date.now()) {
  while (times.length && now - times[0] >= 1000) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

// Message refusé : après FLOOD_DROPS refus en 10 s, sourdine. → true si on vient de couper.
function floodCheck(drops, now = Date.now()) {
  drops.push(now);
  while (drops.length && now - drops[0] > 10000) drops.shift();
  if (drops.length < LIMITS.FLOOD_DROPS) return false;
  drops.length = 0;
  return true;
}

// Envoi qui ne lève jamais : une connexion qui tombe déclenchera son « close »
function safeSend(conn, msg) {
  try {
    if (conn?.open) conn.send(msg);
  } catch {
    // connexion en train de tomber
  }
}

// Tout ce qui arrive des autres est nettoyé : texte borné, caractères de contrôle remplacés
// par une espace (sauf le retour à la ligne), caractères invisibles et d'inversion du sens
// d'écriture retirés (sinon un message pourrait se faire passer pour un autre à l'affichage).
function cleanText(value, max = LIMITS.TEXT_MAX) {
  return String(value ?? "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .slice(0, max)
    .trim();
}

function cleanName(value, fallback = "?") {
  return cleanText(value).replace(/\s+/g, " ").slice(0, LIMITS.NAME_MAX).trim() || fallback;
}

function cleanColor(value, fallback = "#888888") {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

// Poignée de main signée avec l'identité durable (clé Nostr). tags : [["from", monId],
// ["to", sonId], …] ; la vérification exige les mêmes valeurs et une signature valide.
function signHello(secret, tags) {
  return NostrTools.finalizeEvent({ kind: HELLO_KIND, created_at: nowSeconds(), tags, content: "" }, secret);
}

// → pubkey de l'auteur, ou null. expected : { from, to, … } valeurs attendues des tags.
function verifyHello(ev, expected) {
  if (!ev || typeof ev !== "object" || ev.kind !== HELLO_KIND || !Array.isArray(ev.tags)) return null;
  try {
    if (!NostrTools.verifyEvent(ev)) return null;
  } catch {
    return null; // événement mal formé
  }
  const tag = (k) => ev.tags.find((x) => x[0] === k)?.[1];
  for (const [k, v] of Object.entries(expected)) if (tag(k) !== String(v)) return null;
  if (Math.abs(nowSeconds() - ev.created_at) > 300) return null;
  return ev.pubkey;
}

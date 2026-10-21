// addon-kit — traductions communes des extensions tom-tour (Sidetrack, Pagemates…).
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.
//
// À charger AVANT le i18n.js de l'extension, qui déclare `const STRINGS = { fr, en }` avec
// ses propres textes. t() cherche d'abord dans les textes de l'extension, puis dans ceux
// d'ici : une extension n'a donc à écrire que ce qui lui est propre, et tous les termes
// communs (Réglages, Salon, Bloquer…) sont identiques partout. Voir GUIDE.md, « Vocabulaire ».
//
// « {0} », « {1} »… sont remplacés par les arguments de t(). La langue suit le réglage
// (auto = langue du navigateur).

const COMMON_STRINGS = {
  fr: {
    // Navigation, réglages
    settings: "Réglages",
    back: "← Retour",
    general: "Général",
    display: "Affichage",
    profile: "Profil",
    language: "Langue",
    langAuto: "Automatique (langue du navigateur)",
    log: "Journal",
    about: "À propos",
    amoPage: "Fiche sur addons.mozilla.org",
    sourceCode: "Code source sur GitHub",
    support: "Soutenir sur Ko-fi",
    // Actions
    send: "Envoyer",
    cancel: "Annuler",
    close: "Fermer",
    sure: "Sûr ?",
    yes: "Oui",
    no: "Non",
    refresh: "Actualiser",
    join: "Rejoindre",
    leave: "Quitter",
    copyLink: "🔗 Copier le lien",
    copied: "✓ Copié",
    // Salons
    room: "Salon",
    channel: "Canal",
    connecting: "Connexion…",
    connError: "⚠ Connexion impossible",
    privateMessage: "Message privé",
    chatSound: "Son à chaque nouveau message",
    // Identité
    nickname: "Pseudo",
    defaultName: "Invité",
    codeLabel: "Code d'identité",
    codeHelp: "Ce code accompagne le pseudo partout. Il est lié à l'identité : quelqu'un qui reprend le même pseudo n'aura pas le même code.",
    identityMining: "Création de l'identité anti-spam… {0} %",
    identityMiningHelp: "Une seule fois, une vingtaine de secondes : ce petit calcul rend les faux comptes coûteux, pour que les blocages tiennent.",
    ipNotice: "Les personnes d'un salon sont connectées directement entre elles (pair-à-pair) : chacun peut voir l'adresse IP des autres.",
    // Protection
    errTooFast: "Doucement : {0} messages par seconde au plus.",
    sysFlood: "{0} envoie trop de messages : en sourdine pendant 1 minute",
    block: "Bloquer",
    blockAsk: "Bloquer…",
    blockConfirmTitle: "Bloquer {0} ?",
    blockConfirm: "Bloquer {0}",
    unblock: "Débloquer",
    blockedList: "Personnes bloquées",
    noBlocked: "Personne n'est bloqué.",
    kick: "Exclure",
    kickAsk: "Exclure…",
    kickConfirmTitle: "Exclure {0} ?",
    kickConfirm: "Exclure {0}",
    ban: "Bannir",
    banAsk: "Bannir…",
    banConfirmTitle: "Bannir {0} ?",
    banConfirm: "Bannir {0}",
    unban: "Débannir",
    bannedList: "Personnes bannies",
    noBanned: "Personne n'est banni.",
  },
  en: {
    settings: "Settings",
    back: "← Back",
    general: "General",
    display: "Display",
    profile: "Profile",
    language: "Language",
    langAuto: "Automatic (browser language)",
    log: "Log",
    about: "About",
    amoPage: "Page on addons.mozilla.org",
    sourceCode: "Source code on GitHub",
    support: "Support on Ko-fi",
    send: "Send",
    cancel: "Cancel",
    close: "Close",
    sure: "Sure?",
    yes: "Yes",
    no: "No",
    refresh: "Refresh",
    join: "Join",
    leave: "Leave",
    copyLink: "🔗 Copy link",
    copied: "✓ Copied",
    room: "Room",
    channel: "Channel",
    connecting: "Connecting…",
    connError: "⚠ Can't connect",
    privateMessage: "Private message",
    chatSound: "Sound for every new message",
    nickname: "Nickname",
    defaultName: "Guest",
    codeLabel: "Your code",
    codeHelp: "This code goes with your name everywhere. It's tied to your identity: someone taking your nickname won't have the same code.",
    identityMining: "Creating your anti-spam identity… {0}%",
    identityMiningHelp: "Only once, about 20 seconds: this small computation makes fake accounts costly, so blocks hold.",
    ipNotice: "People in a room are connected directly to each other (peer-to-peer): everyone can see the others' IP address.",
    errTooFast: "Slow down: {0} messages per second at most.",
    sysFlood: "{0} is sending too many messages: muted for 1 minute",
    block: "Block",
    blockAsk: "Block…",
    blockConfirmTitle: "Block {0}?",
    blockConfirm: "Block {0}",
    unblock: "Unblock",
    blockedList: "Blocked people",
    noBlocked: "Nobody is blocked.",
    kick: "Kick",
    kickAsk: "Kick…",
    kickConfirmTitle: "Kick {0}?",
    kickConfirm: "Kick {0}",
    ban: "Ban",
    banAsk: "Ban…",
    banConfirmTitle: "Ban {0}?",
    banConfirm: "Ban {0}",
    unban: "Unban",
    bannedList: "Banned people",
    noBanned: "Nobody is banned.",
  },
};

let LANG = "fr";

// pref : "auto" | "fr" | "en" → true si la langue a changé
function setLang(pref) {
  const auto = (navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
  const lang = pref === "fr" || pref === "en" ? pref : auto;
  const changed = lang !== LANG;
  LANG = lang;
  return changed;
}

function t(key, ...args) {
  const app = typeof STRINGS === "undefined" ? {} : STRINGS;
  const text = app[LANG]?.[key] ?? COMMON_STRINGS[LANG][key] ?? app.fr?.[key] ?? COMMON_STRINGS.fr[key] ?? key;
  return text.replace(/\{(\d)\}/g, (_, i) => String(args[i] ?? ""));
}

// Remplit les éléments marqués data-i18n (texte), data-i18n-title, data-i18n-placeholder
function applyI18n(root = document) {
  document.documentElement.lang = LANG;
  for (const e of root.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll("[data-i18n-title]")) e.title = t(e.dataset.i18nTitle);
  for (const e of root.querySelectorAll("[data-i18n-placeholder]")) e.placeholder = t(e.dataset.i18nPlaceholder);
}

setLang("auto");

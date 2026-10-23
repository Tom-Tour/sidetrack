// Page invité (join/, publiée sur GitHub Pages) : la vraie page dans jsdom 24.1.3, avec le kit
// commun (../common/), reliée à un vrai moteur hôte. Lancer : node tests/join.test.cjs
const { read, until, check, done, makeEngine, joinPage, playlist, FakeWorker } = require("./harness.cjs");

(async () => {
  try {
    const html = read("join/index.html");
    const order = ["../common/i18n-core.js", "../common/net.js", "../common/pow.js", "join.js"].map((f) => html.search(new RegExp(`src="${f.replace(/[./]/g, "\\$&")}\\?v=\\d+"`)));
    check("page invité : kit commun chargé avant join.js, avec numéro de version", order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
    check("worker du kit (avec scrypt.js à côté), plus l'ancien pow-worker.js", read("join/join.js").includes('"../common/pow-worker.js?v=') && !read("join/join.js").includes("../pow-worker.js"));

    const host = makeEngine("hôte", { sidetrack: playlist });
    await until(() => host.snap()?.me.code, 10000);
    host.act("openRoom", { name: "invites", isPublic: true });
    await until(() => host.snap()?.room?.status === "open");

    // --- Identité : calculée dès l'ouverture de la page, code affiché ---
    const alice = joinPage("invites");
    await until(() => /^[0-9A-F]{4}$/.test(alice.$(".my-code").textContent), 10000);
    const codeAlice = alice.$(".my-code").textContent;
    check("code d'identité affiché sur l'écran de connexion", /^[0-9A-F]{4}$/.test(codeAlice));
    const saved = JSON.parse(alice.win.localStorage.getItem("sidetrack-pow-v2"));
    check("preuve gardée au format du kit", saved.v === 2 && saved.code === codeAlice);
    check("textes communs du kit (Rejoindre, Pseudo, Code d'identité)", alice.$("#login-form button").textContent === "Rejoindre" && alice.$("#login").textContent.includes("Pseudo") && alice.$("#login").textContent.includes("Code d'identité"));

    check("pseudo proposé « Invité-1234 », comme dans l'extension", /^Invité-\d{4}$/.test(alice.$("#name").value), alice.$("#name").value);
    alice.join("Alice");
    await until(() => !alice.$("#room").hidden && host.snap().room.players.some((p) => p.name === "Alice"), 5000);
    check("Alice entre dans le salon", !alice.$("#room").hidden && host.snap().room.players.some((p) => p.name === "Alice" && p.code === codeAlice));
    await until(() => alice.$("#players .chip"));
    check("pastille avec son code", alice.$("#players .chip.me .code")?.textContent === codeAlice);

    // --- Chat : codes en infobulle, limites ---
    host.act("hostChat", "bienvenue Alice");
    await until(() => alice.chat().some((t) => t.includes("bienvenue Alice")));
    const hostLine = [...alice.$("#chat").children].find((p) => p.textContent.includes("bienvenue Alice"));
    check("message de l'hôte : « Hôte · CODE » en infobulle", hostLine.querySelector("b").title === `Hôte · ${host.snap().me.code}`);
    for (let i = 0; i < 4; i++) alice.say(`vite ${i}`);
    await until(() => !alice.$("#chat-note").hidden);
    check("débit : « Doucement : 2 messages par seconde au plus. »", alice.$("#chat-note").textContent === "Doucement : 2 messages par seconde au plus.");

    // --- Ancienne preuve (avant le kit) : reprise sans recalcul, même code ---
    const workers = FakeWorker.created;
    const back = joinPage("invites", "fr-FR", {
      "sidetrack-identity": alice.win.localStorage.getItem("sidetrack-identity"),
      "sidetrack-pow-v2": JSON.stringify({ pubkey: saved.pubkey, bits: 7, nonce: saved.nonce }),
    });
    await until(() => /^[0-9A-F]{4}$/.test(back.$(".my-code").textContent), 5000);
    const upgraded = JSON.parse(back.win.localStorage.getItem("sidetrack-pow-v2"));
    check("ancienne preuve : même code, une seule vérification", back.$(".my-code").textContent === codeAlice && upgraded.v === 2 && FakeWorker.created === workers + 1);

    // --- Bannir : messages effacés, raison affichée ---
    await until(() => false, 1100);
    alice.say("dernier message");
    await until(() => host.snap().room.chat.some((m) => m.text === "dernier message"));
    const aliceId = host.snap().room.players.find((p) => p.name === "Alice").id;
    host.act("ban", aliceId);
    await until(() => alice.$("#room-status").textContent.includes("banni"), 3000);
    check("bannie : « Banni des salons de cet hôte »", alice.$("#room-status").textContent === "Banni des salons de cet hôte");
    check("messages du système traduits (clés sys*)", alice.chat().some((t) => t === "Alice a rejoint le salon"));

    // --- Langue ---
    const en = [...alice.win.document.querySelectorAll("#langs button")].find((b) => b.dataset.lang === "en");
    en.click();
    check("bouton EN : textes retraduits", alice.$("#chat-form button[type=submit]").textContent === "Send" && alice.chat().some((t) => t === "Alice joined the room"));

    const errs = [...alice.errors, ...back.errors, ...host.errors()];
    check("aucune erreur", !errs.length, errs.join(" / "));
  } catch (err) {
    check("exception", false, err.stack);
  }
  done();
})();

// Barre latérale : la vraie page (sidebar.html + common/ + sidebar.js) dans jsdom 24.1.3,
// reliée à de vrais moteurs. Lancer : node tests/sidebar.test.cjs
const { read, until, check, done, makeEngine, sidebarFor, playlist } = require("./harness.cjs");

(async () => {
  try {
    // --- Ce que le kit impose à la page ---
    const html = read("sidebar.html");
    const css = read("sidebar.css");
    check("common/theme.css lié avant sidebar.css", html.indexOf("common/theme.css") > 0 && html.indexOf("common/theme.css") < html.indexOf("sidebar.css"));
    const order = ["common/i18n-core.js", "i18n.js", "common/ui.js", "sidebar.js"].map((f) => html.indexOf(`src="${f}"`));
    check("scripts : i18n-core, i18n.js, ui.js, puis la page", order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
    check("sidebar.css ne redéfinit ni couleurs ni composants du kit", !/:root|--bg:|^\s*\.(tab|tabs|notice|chip|chips|card|settings|badge|icon|line|muted)\b/m.test(css));
    check("i18n.js : seulement les textes de Sidetrack", !/function (t|setLang|applyI18n)\b/.test(read("i18n.js")));

    const host = makeEngine("hôte", { sidetrack: playlist, settings: { nickname: "Hôtesse" } });
    const bob = makeEngine("bob", { settings: { nickname: "Bob" } });
    await until(() => host.snap()?.me.code && bob.snap()?.me.code, 10000);
    const sb = sidebarFor(host);
    await until(() => sb.$("#pl-select").options.length > 0);
    const { $, $$ } = sb;

    // --- Réglages : cadres dans l'ordre du guide ---
    sb.click("#open-settings");
    const legends = $$("#settings > fieldset > legend").map((l) => l.textContent);
    check("cadres : Général, Affichage, Multijoueur, Sauvegarde, Profil, Personnes bloquées, Personnes bannies, À propos", legends.join(" | ") === "Général | Affichage | Multijoueur | Sauvegarde | Profil | Personnes bloquées | Personnes bannies | À propos", legends.join(" | "));
    const kids = [...$("#settings").children].map((e) => e.tagName);
    check("Journal repliable juste avant À propos (en dernier)", kids.at(-2) === "DETAILS" && kids.at(-1) === "FIELDSET" && $("#settings").classList.contains("settings"));
    check("son des messages dans Général (texte commun)", $$("#settings fieldset")[0].textContent.includes("Son à chaque nouveau message"));
    check("cases à cocher en label.check", $$("#settings input[type=checkbox]").every((c) => c.closest("label").classList.contains("check")));
    check("Profil : pseudo, ton code, avertissement IP", $("#my-code").textContent === host.snap().me.code && $$("#settings fieldset")[4].textContent.includes("adresse IP"));
    sb.click("#close-settings");

    // --- Onglets : style du kit ---
    check("onglets : conteneur .tabs, boutons .tab", $("#tabs").classList.contains("tabs") && $$("#tabs .tab").length === 3);

    // --- Supprimer une playlist : « Sûr ? » (createSure) ---
    host.act("createPlaylist", "À jeter");
    await until(() => host.snap().state.playlists.length === 2);
    sb.click("#pl-delete");
    await until(() => $("#pl-delete").textContent === "Sûr ?");
    check("premier clic : « Sûr ? » en rouge", $("#pl-delete").textContent === "Sûr ?" && $("#pl-delete").classList.contains("danger"));
    sb.click("#pl-delete");
    await until(() => host.snap().state.playlists.length === 1);
    check("second clic : playlist supprimée", host.snap().state.playlists.length === 1 && $("#pl-delete").textContent === "🗑");

    // --- Salon : pastilles avec code, nom du chat avec code en infobulle ---
    host.act("openRoom", { name: "barre" });
    await until(() => host.snap()?.room?.status === "open");
    bob.act("joinRoom", "barre");
    await until(() => host.snap().room?.players.length === 1, 5000);
    await until(() => $$("#room-players .chip").length === 1);
    const chip = $("#room-players .chip");
    check("pastille : nom et code d'identité", chip.textContent.includes("Bob") && chip.querySelector(".code").textContent === bob.snap().me.code);
    bob.act("guestChat", "coucou");
    await until(() => $$("#chat .msg").some((p) => p.textContent.includes("coucou")));
    const line = $$("#chat .msg").find((p) => p.textContent.includes("coucou"));
    check("chat : infobulle « Nom · CODE »", line.querySelector(".who").title === `Bob · ${bob.snap().me.code}`);
    check("pas de boutons d'exclusion au survol", !$("#room-players .mod") && !$$("#room-players button").some((b) => /✕|🚫/.test(b.textContent)));

    // --- Bannir : nom → fiche → « Bannir… » → panneau qui écrit les conséquences ---
    sb.click(line.querySelector(".who"));
    await until(() => !$("#person").hidden);
    check("clic sur le nom : fiche avec nom et code", !$("#person").hidden && $("#person .head").textContent.includes("Bob") && $("#person .code").textContent === bob.snap().me.code);
    const banAsk = $$("#person button").find((b) => b.textContent.includes("Bannir"));
    sb.click(banAsk);
    await until(() => $("#person .warn"));
    check("panneau de confirmation : conséquences écrites", $("#person .warn").textContent === "Bannir Bob ?" && $("#person").textContent.includes("ne pourra plus entrer"));
    const cancel = $$("#person button").find((b) => b.textContent === "Annuler");
    sb.click(cancel);
    await until(() => !$("#person .warn"));
    check("Annuler : retour à la fiche, personne n'est banni", !$("#person .warn") && host.snap().room.players.length === 1);
    sb.click($$("#person button").find((b) => b.textContent.includes("Bannir")));
    await until(() => $("#person .warn"));
    const confirm = $$("#person button").find((b) => b.textContent === "Bannir Bob");
    check("bouton de confirmation rouge « Bannir Bob »", confirm?.classList.contains("danger"));
    sb.click(confirm);
    await until(() => !host.snap().room.players.length, 3000);
    check("Bob banni et sorti du salon", !host.snap().room.players.length);
    sb.click("#open-settings");
    await until(() => $("#banned li span")?.textContent.includes("·"));
    check("liste des bannis : « Bob · CODE » et Débannir", $("#banned li span").textContent === `Bob · ${bob.snap().me.code}` && $("#banned li button").textContent === "Débannir");
    sb.click("#banned li button");
    await until(() => !Object.keys(host.snap().settings.banned).length);
    check("Débannir", !Object.keys(host.snap().settings.banned).length && $("#banned li").textContent === "Personne n'est banni.");
    sb.click("#close-settings");

    // --- Bloquer, chez un invité : nom → fiche → « Bloquer… » → conséquences → confirmer ---
    const carol = makeEngine("carol", { settings: { nickname: "Carol" } });
    await until(() => carol.snap()?.me.code, 10000);
    bob.act("leaveRoom");
    bob.act("joinRoom", "barre");
    carol.act("joinRoom", "barre");
    await until(() => carol.snap()?.guest?.players.length === 2, 5000);
    check("débanni : Bob peut revenir dans le salon ouvert", bob.snap().guest.status === "joined");
    const cb = sidebarFor(carol);
    await until(() => cb.$$("#room-players .chip").length === 2);
    await until(() => false, 1100);
    bob.act("guestChat", "salut Carol", false);
    await until(() => cb.$$("#chat .msg").some((p) => p.textContent.includes("salut Carol")));
    const bobLine = cb.$$("#chat .msg").find((p) => p.textContent.includes("salut Carol"));
    check("invité : nom d'un autre invité cliquable", bobLine.querySelector(".who").classList.contains("who") && !bobLine.querySelector(".who").classList.contains("me"));
    cb.click(bobLine.querySelector(".who"));
    await until(() => !cb.$("#person").hidden);
    const blockAsk = cb.$$("#person button").find((b) => b.textContent.includes("Bloquer"));
    check("fiche d'invité : « ⛔ Bloquer… » seulement", blockAsk?.textContent === "⛔ Bloquer…" && !cb.$$("#person button").some((b) => /Bannir|Exclure|\+1/.test(b.textContent)));
    cb.click(blockAsk);
    await until(() => cb.$("#person .warn"));
    check("conséquences écrites, dont ce que sait l'hôte", cb.$("#person .warn").textContent === "Bloquer Bob ?" && cb.$("#person").textContent.includes("L'hôte du salon saura"));
    const yes = cb.$$("#person button").find((b) => b.textContent === "Bloquer Bob");
    check("bouton rouge « Bloquer Bob »", yes?.classList.contains("danger"));
    cb.click(yes);
    await until(() => cb.$$("#room-players .chip").length === 1 && !cb.$$("#chat .msg").some((p) => p.textContent.includes("salut Carol")), 3000);
    check("Bob disparaît des pastilles et du chat de Carol", cb.$$("#room-players .chip").length === 1);
    cb.click("#open-settings");
    await until(() => cb.$("#blocked li span")?.textContent.includes("·"));
    check("liste des bloqués : « Bob · CODE » et Débloquer", cb.$("#blocked li span").textContent === `Bob · ${bob.snap().me.code}` && cb.$("#blocked li button").textContent === "Débloquer");
    cb.click("#blocked li button");
    await until(() => !Object.keys(carol.snap().settings.blocked).length);
    check("Débloquer", cb.$("#blocked li").textContent === "Personne n'est bloqué.");
    cb.click("#close-settings");
    carol.act("leaveRoom");

    // --- Réglages : envoyés au moteur et nettoyés ---
    sb.click("#open-settings");
    $("#set-chatSound").checked = true;
    sb.fire("#set-chatSound", "change");
    $("#set-nickname").value = "  Nouvelle   hôtesse ";
    sb.fire("#set-nickname", "change");
    await until(() => host.snap().settings.nickname === "Nouvelle hôtesse" && host.snap().settings.chatSound);
    check("réglages transmis (et pseudo nettoyé)", host.snap().settings.chatSound === true && host.snap().settings.nickname === "Nouvelle hôtesse");
    $("#set-lang").value = "en";
    sb.fire("#set-lang", "change");
    await until(() => $("#close-settings").textContent === "← Back");
    check("langue changée : textes communs et propres retraduits", $$("#settings legend")[0].textContent === "General" && $$("#settings legend")[5].textContent === "Blocked people" && $$("#settings legend")[6].textContent === "Banned people");

    // --- Première identité : barre de progression ---
    const fresh = makeEngine("neuve", {});
    const sf = sidebarFor(fresh);
    fresh.eval("mining = { tries: 3 }; update()");
    await until(() => sf.$("#mining-title")?.textContent.includes("%"));
    sf.click("#toggle-room");
    await until(() => !sf.$("#mining").hidden);
    check("identité en calcul : « Création de l'identité anti-spam… N % »", /Création de l'identité anti-spam… \d+ %/.test(sf.$("#mining-title").textContent), sf.$("#mining-title").textContent);

    const errs = [...sb.errors, ...sf.errors];
    check("aucune erreur dans la page", !errs.length, errs.join(" / "));
  } catch (err) {
    check("exception", false, err.stack);
  }
  done();
})();

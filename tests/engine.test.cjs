// Moteur : plusieurs moteurs Sidetrack dans des contextes vm séparés, faux réseau PeerJS,
// faux relais Nostr, vraie cryptographie et vraie preuve de travail (difficulté réduite).
// Lancer : node tests/engine.test.cjs
const { until, check, done, makeEngine, playlist, FakeWorker } = require("./harness.cjs");

(async () => {
  try {
    // --- Identité, preuve de travail, code ---
    const host = makeEngine("hôte", { sidetrack: playlist, settings: { nickname: "Hôtesse" } });
    const bob = makeEngine("bob", { settings: { nickname: "Bob" } });
    await until(() => host.snap()?.me.code && bob.snap()?.me.code, 10000);
    const codeHost = host.snap().me.code;
    const codeBob = bob.snap().me.code;
    check("identités prêtes, code de 4 caractères", /^[0-9A-F]{4}$/.test(codeHost) && /^[0-9A-F]{4}$/.test(codeBob), `${codeHost} ${codeBob}`);
    check("preuve rangée au format du kit", host.store.pow?.v === 2 && host.store.pow.pubkey === host.eval("identity.pubkey") && host.store.pow.code === codeHost);

    // Ancienne preuve (avant le kit) : reprise sans recalcul, le code est retrouvé
    const old = { identity: host.store.identity, pow: { pubkey: host.store.pow.pubkey, bits: 7, nonce: host.store.pow.nonce } };
    const workers = FakeWorker.created;
    const again = makeEngine("ancienne preuve", old);
    await until(() => again.snap()?.me.code, 5000);
    check("ancienne preuve gardée : même code, pas de nouveau calcul", again.snap().me.code === codeHost && again.store.pow.v === 2 && FakeWorker.created === workers + 1, `${again.snap()?.me.code}`);

    // --- Réglages : DEFAULTS, nettoyage, reprise des anciens réglages ---
    const legacy = makeEngine("anciens réglages", { sidetrack: { ...playlist, lang: "en", volume: 40, chatSound: true, banned: { ["a".repeat(64)]: "Eve" }, blind: { clip: 15, judge: "self" } } });
    await until(() => legacy.snap()?.settings.lang === "en", 3000);
    const ls = legacy.snap().settings;
    check("anciens réglages repris sous « settings »", ls.lang === "en" && ls.volume === 40 && ls.chatSound === true && ls.blind.clip === 15 && ls.blind.judge === "self" && ls.banned["a".repeat(64)] === "Eve");
    check("rangés sous « settings » dans le stockage", legacy.store.settings?.lang === "en" && !("lang" in (legacy.store.sidetrack ?? {})));
    legacy.act("setSetting", "lang", "klingon");
    legacy.act("setSetting", "volume", 900);
    legacy.act("setBlind", "pause", "beaucoup");
    legacy.act("setSetting", "nickname", "  Bob   le   bricoleur  ");
    await until(() => legacy.snap().settings.nickname === "Bob le bricoleur");
    const ls2 = legacy.snap().settings;
    check("réglage invalide refusé", ls2.lang === "en" && ls2.volume === 40 && ls2.blind.pause === 10);
    check("pseudo nettoyé (cleanName)", ls2.nickname === "Bob le bricoleur");

    // --- Salon, poignée de main signée, codes ---
    host.act("openRoom", { name: "soiree", isPublic: true });
    await until(() => host.snap()?.room?.status === "open");
    bob.act("joinRoom", "Soirée");
    await until(() => bob.snap()?.guest?.status === "joined", 5000);
    check("Bob entre dans le salon public", bob.snap().guest.status === "joined");
    const hp = host.snap().room.players;
    check("l'hôte voit Bob avec son code", hp.length === 1 && hp[0].name === "Bob" && hp[0].code === codeBob, JSON.stringify(hp));
    await until(() => bob.snap().guest.hostCode);
    check("Bob voit le code de l'hôte", bob.snap().guest.hostCode === codeHost);

    // Double clic sur « Rejoindre » : pas de seconde connexion
    bob.act("joinRoom", "soiree");
    bob.act("joinRoom", "soiree");
    await until(() => false, 300);
    check("rejoindre deux fois : une seule présence", host.snap().room.players.length === 1);

    // --- Chat, limites ---
    // Un caractère d'inversion du sens d'écriture glissé dans le texte est retiré à l'arrivée
    bob.act("guestChat", "sa" + String.fromCharCode(0x202e) + "lut");
    await until(() => host.snap().room.chat.some((m) => m.text === "salut"));
    const m = host.snap().room.chat.find((x) => x.text === "salut");
    check("message de Bob reçu avec son code, nettoyé", m.code === codeBob && m.name === "Bob");
    host.act("hostChat", "bienvenue");
    const tooFast = [await host.ask("hostChat", "un"), await host.ask("hostChat", "deux"), await host.ask("hostChat", "trois")];
    check("hôte : réponse errTooFast au-delà de 2 messages par seconde", tooFast.includes("errTooFast"), JSON.stringify(tooFast));
    await until(() => host.snap().notice?.key === "errTooFast");
    check("hôte : bandeau errTooFast (2 par seconde), comme un invité", host.snap().notice?.key === "errTooFast" && host.snap().notice?.args?.[0] === 2, JSON.stringify(host.snap().notice));
    await until(() => bob.snap().guest.chat.some((x) => x.text === "bienvenue"));
    check("Bob reçoit le message de l'hôte avec son code", bob.snap().guest.chat.find((x) => x.text === "bienvenue")?.code === codeHost);
    check("heure d'envoi gardée chez l'invité (at)", Math.abs(bob.snap().guest.chat.find((x) => x.text === "bienvenue").at - Date.now()) < 5000);
    check("heure invalide écartée chez l'invité", bob.eval('cleanGuestChat({ text: "x", at: "12:00" }).at') === undefined && bob.eval('cleanGuestChat({ text: "x", at: NaN }).at') === undefined);
    await until(() => false, 1100);
    for (let i = 0; i < 4; i++) bob.act("guestChat", `vite ${i}`);
    await until(() => bob.snap().notice?.key === "errTooFast");
    check("invité : bandeau errTooFast (2 par seconde)", bob.snap().notice?.args?.[0] === 2);

    // Client modifié qui inonde : sourdine annoncée (sysFlood)
    const conn = bob.eval("guest.conn");
    for (let i = 0; i < 60; i++) conn.send({ t: "chat", text: `spam ${i}` });
    await until(() => host.snap().room.chat.some((x) => x.key === "sysFlood"));
    check("inondation : sourdine et message sysFlood", host.snap().room.chat.some((x) => x.key === "sysFlood" && x.args[0] === "Bob"));
    check("et au plus 3 messages acceptés par seconde", host.snap().room.chat.filter((x) => String(x.text).startsWith("spam")).length <= 4);

    // --- Blind test : réponses cachées, points à l'écrit, indices ---
    host.act("setBlind", "startMode", "start");
    host.act("setMode", "blind");
    host.act("blindPick", 0);
    await until(() => bob.snap().guest.host?.blind?.phase === "playing");
    await until(() => false, 1100); // laisse passer la seconde du débit d'envoi
    bob.eval("guest.sendTimes.length = 0");
    host.eval("for (const p of room.players.values()) p.mutedUntil = 0");
    bob.act("guestChat", "never gonna give you up", true);
    await until(() => host.snap().room.chat.some((x) => x.text === "never gonna give you up"));
    const guess = host.snap().room.chat.find((x) => x.text === "never gonna give you up");
    check("réponse cachée pendant la manche", guess.private === true);
    await until(() => bob.snap().guest.chat.some((x) => x.masked));
    check("Bob voit sa réponse, pas les autres", bob.snap().guest.chat.find((x) => x.masked)?.mine === "never gonna give you up");
    host.act("reveal");
    await until(() => host.snap().room.players[0].score > 0);
    check("points à l'écrit : 10 pour une réponse juste", host.snap().room.players[0].score === 10, String(host.snap().room.players[0].score));

    // Chacun se juge
    host.act("setBlind", "judge", "self");
    host.act("blindPick", 1);
    await until(() => bob.snap().guest.host?.blind?.phase === "playing");
    host.act("reveal");
    await until(() => bob.snap().guest.host?.blind?.claim && bob.snap().guest.host.blind.phase === "revealed");
    bob.act("guestClaim", true);
    await until(() => host.snap().room.players[0].score === 11);
    check("chacun se juge : Bob se donne son point", host.snap().room.players[0].score === 11);
    host.act("claim", true);
    await until(() => host.snap().room.hostScore === 1);
    check("et l'hôte qui joue aussi", host.snap().room.hostScore === 1);

    // --- Exclure, bannir ---
    const carol = makeEngine("carol", { settings: { nickname: "Carol" } });
    await until(() => carol.snap()?.me.code, 5000);
    carol.act("joinRoom", "soiree");
    await until(() => host.snap().room.players.length === 2, 5000);
    await until(() => false, 1100);
    carol.act("guestChat", "message de Carol", false);
    await until(() => host.snap().room.chat.some((x) => x.text === "message de Carol"));
    const carolId = host.snap().room.players.find((p) => p.name === "Carol").id;
    host.act("ban", carolId);
    await until(() => carol.snap().guest?.status === "ended");
    check("Carol bannie : prévenue", carol.snap().guest.endKey === "errBanned");
    await until(() => host.snap().settings.banned[carolId] && !host.snap().room.chat.some((x) => x.text === "message de Carol"));
    const label = host.snap().settings.banned[carolId];
    check("liste des bannis au format « Nom · CODE »", label === `Carol · ${carol.snap().me.code}`, label);
    check("ses messages disparaissent chez l'hôte", !host.snap().room.chat.some((x) => x.text === "message de Carol"));
    await until(() => !bob.snap().guest.chat.some((x) => x.text === "message de Carol"));
    check("et chez les invités", !bob.snap().guest.chat.some((x) => x.text === "message de Carol"));
    carol.act("leaveRoom");
    carol.act("joinRoom", "soiree");
    await until(() => carol.snap().guest?.status === "ended", 5000);
    check("bannie : refusée en revenant", carol.snap().guest.endKey === "errBanned");

    // --- Bouton de la barre d'outils : messages arrivés barre latérale fermée ---
    host.closePanel();
    await until(() => false, 1100);
    bob.act("guestChat", "tu es là ?", false);
    await until(() => host.badge.text === "1");
    check("badge de la barre d'outils : 1 message", host.badge.text === "1" && host.badge.color === "#0090ff");
    const panel = host.sidebar();
    await until(() => host.badge.text === "");
    check("effacé à la réouverture du panneau", host.badge.text === "");

    // --- Sauvegarde et playlists toutes prêtes ---
    panel.act("restorePlaylists", { hello: 1 });
    await until(() => panel.snap().notice?.key === "noticeBadBackup");
    check("sauvegarde invalide refusée", panel.snap().notice.key === "noticeBadBackup");
    panel.act("restorePlaylists", { app: "sidetrack", playlists: [{ id: "x1", name: "Restaurée\u0007", items: [{ id: "kJQP7kiw5Fk", title: "Despacito" }, { id: "bad" }] }] });
    await until(() => panel.snap().state.playlists.some((p) => p.id === "x1"));
    check("restauration : seuls les éléments valables", panel.snap().state.playlists.find((p) => p.id === "x1").items.length === 1);
    panel.act("addPreset", "anime");
    await until(() => panel.snap().state.playlists.some((p) => p.preset === "anime"));
    check("playlist toute prête, nom traduit", panel.snap().state.playlists.find((p) => p.preset === "anime").name === "🌸 Génériques d'animes");

    const errs = [host, bob, carol].flatMap((e) => e.errors());
    check("aucune erreur au journal", !errs.length, errs.join(" / "));
  } catch (err) {
    check("exception", false, err.stack);
  }

  // --- Connexions fantômes : battement de cœur (accéléré pour le test) ---
  try {
    const host = makeEngine("hôte 2", { sidetrack: playlist }, { fastHeartbeat: true });
    const dan = makeEngine("dan", { settings: { nickname: "Dan" } }, { fastHeartbeat: true });
    await until(() => host.snap()?.me.code && dan.snap()?.me.code, 5000);
    host.act("openRoom", { name: "fantome" });
    await until(() => host.snap()?.room?.status === "open");
    dan.act("joinRoom", "fantome");
    await until(() => dan.snap()?.guest?.status === "joined", 5000);
    await until(() => false, 1000);
    check("battement de cœur : Dan reste dans le salon", dan.snap().guest.status === "joined" && host.snap().room.players.length === 1);
    // La connexion meurt sans le dire, dans les deux sens
    dan.eval("guest.conn").mute = true;
    host.eval("[...room.players.values()][0].conn").mute = true;
    await until(() => !host.snap().room.players.length, 5000);
    check("connexion muette : Dan retiré du salon", !host.snap().room.players.length && host.snap().room.chat.some((x) => x.key === "sysLeft"));
    await until(() => dan.snap().guest?.status === "ended", 5000);
    check("et Dan voit qu'il est déconnecté", dan.snap().guest.endKey === "errDisconnected");
  } catch (err) {
    check("exception (fantômes)", false, err.stack);
  }
  // --- Bloquer : choix personnel d'un invité ---
  try {
    const host = makeEngine("hôte 3", { sidetrack: playlist });
    const eve = makeEngine("eve", { settings: { nickname: "Eve" } });
    const finn = makeEngine("finn", { settings: { nickname: "Finn" } });
    await until(() => host.snap()?.me.code && eve.snap()?.me.code && finn.snap()?.me.code, 10000);
    host.act("openRoom", { name: "blocage" });
    await until(() => host.snap()?.room?.status === "open");
    eve.act("joinRoom", "blocage");
    finn.act("joinRoom", "blocage");
    await until(() => eve.snap()?.guest?.players.length === 2 && finn.snap()?.guest?.players.length === 2, 5000);
    eve.act("guestChat", "Eve dit bonjour", false);
    finn.act("guestChat", "Finn dit bonjour", false);
    await until(() => eve.snap().guest.chat.some((x) => x.text === "Finn dit bonjour") && finn.snap().guest.chat.some((x) => x.text === "Eve dit bonjour"));
    const finnId = finn.snap().guest.me;
    const eveId = eve.snap().guest.me;

    eve.act("block", finnId);
    await until(() => eve.snap().settings.blocked[finnId]);
    check("bloqué : retenu au format « Nom · CODE »", eve.snap().settings.blocked[finnId] === `Finn · ${finn.snap().me.code}`, eve.snap().settings.blocked[finnId]);
    check("Finn disparaît des pastilles et du chat d'Eve", !eve.snap().guest.players.some((p) => p.id === finnId) && !eve.snap().guest.chat.some((x) => x.from === finnId));
    await until(() => host.eval(`room.players.get("${eveId}").blocks.has("${finnId}")`));
    check("l'hôte ne connaît que cette identité présente", host.eval(`room.players.get("${eveId}").blocks.size`) === 1);
    await until(() => !finn.snap().guest.players.some((p) => p.id === eveId) && !finn.snap().guest.chat.some((x) => x.from === eveId), 3000);
    check("et Eve disparaît aussi chez Finn", !finn.snap().guest.players.some((p) => p.id === eveId) && !finn.snap().guest.chat.some((x) => x.from === eveId));
    await until(() => false, 1100);
    finn.act("guestChat", "Finn encore", false);
    eve.act("guestChat", "Eve encore", false);
    await until(() => host.snap().room.chat.some((x) => x.text === "Finn encore") && host.snap().room.chat.some((x) => x.text === "Eve encore"));
    await until(() => false, 300);
    check("plus rien ne passe entre eux, même pas relayé", !eve.eval("guest.chat").some((x) => x.from === finnId) && !finn.eval("guest.chat").some((x) => x.from === eveId));
    check("l'hôte voit toujours les deux", host.snap().room.players.length === 2);

    eve.act("unblock", finnId);
    await until(() => eve.snap().guest.players.some((p) => p.id === finnId), 3000);
    check("débloqué : Finn revient chez Eve", !eve.snap().settings.blocked[finnId]);

    // Bloquer l'hôte : on quitte son salon, et ses salons restent fermés
    const hostId = host.eval("identity.pubkey");
    eve.act("block", "host");
    await until(() => eve.snap().guest?.status === "ended");
    check("hôte bloqué : Eve quitte le salon", eve.snap().guest.endKey === "errHostBlocked" && eve.snap().settings.blocked[hostId] === `Hôte · ${host.snap().me.code}`);
    eve.act("leaveRoom");
    eve.act("joinRoom", "blocage");
    await until(() => eve.snap().guest?.status === "ended", 5000);
    check("et ne peut plus y revenir", eve.snap().guest.endKey === "errHostBlocked");
    eve.act("leaveRoom");
    // L'hôte annonce une autre identité : c'est sa signature qui compte, Eve reste dehors
    host.eval("var __send = safeSend; safeSend = (c, m) => __send(c, m && m.t === 'welcome' ? { ...m, hostId: 'b'.repeat(64) } : m)");
    eve.act("joinRoom", "blocage");
    await until(() => eve.snap().guest?.status === "ended", 5000);
    check("hôte bloqué sous une autre identité annoncée : toujours refusé", eve.snap().guest.endKey === "errHostBlocked");
    eve.act("leaveRoom");
    // Hôte sans preuve (ancienne version, ou hôte qui ment) : refusé
    host.eval("safeSend = (c, m) => __send(c, m && m.t === 'welcome' ? { ...m, hostEv: undefined } : m)");
    finn.act("leaveRoom");
    finn.act("joinRoom", "blocage");
    await until(() => finn.snap().guest?.status === "ended", 5000);
    check("hôte qui ne prouve pas son identité : refusé", finn.snap().guest?.endKey === "errHostUnverified", JSON.stringify(finn.snap().guest?.endKey));
    host.eval("safeSend = __send");
    finn.act("leaveRoom");

    // Une personne bloquée n'entre pas dans nos salons
    host.act("closeRoom");
    eve.act("openRoom", { name: "chez-eve" });
    await until(() => eve.snap()?.room?.status === "open");
    host.act("joinRoom", "chez-eve");
    await until(() => host.snap().guest?.status === "ended", 5000);
    check("bloqué : refusé dans les salons d'Eve", host.snap().guest.endKey === "errBanned" && !eve.snap().room.players.length);

    const errs = [host, eve, finn].flatMap((e) => e.errors());
    check("aucune erreur au journal (bloquer)", !errs.length, errs.join(" / "));
  } catch (err) {
    check("exception (bloquer)", false, err.stack);
  }
  done();
})();

// Playlists toutes prêtes. Uniquement des vidéos publiées par les ayants droit (chaînes des
// artistes, des compositeurs, des labels, des éditeurs, ou chaînes « Topic » qui diffusent
// les albums pour eux) : les écouter rémunère ceux qui les ont faites. Toutes acceptent
// d'être intégrées, donc lues par le lecteur de Sidetrack.
//
// Titres « Morceau · Artiste · Œuvre » : en blind test, chaque morceau du titre est une
// bonne réponse (le jeu découpe sur « · »).
const PRESETS = {
  games: {
    name: "presetGames", // clé de traduction (i18n.js)
    items: [
      ["IYMTzLxGv3M", "One-Winged Angel · Nobuo Uematsu · Final Fantasy VII"],
      ["QQq0zv_JXEk", "To Zanarkand · Nobuo Uematsu · Final Fantasy X"],
      ["IJiHDmyhE1A", "Baba Yetu · Christopher Tin · Civilization IV"],
      ["xIQrC4CerB8", "Sweden · C418 · Minecraft"],
      ["1rwAvUvvQzQ", "Resurrections · Lena Raine · Celeste"],
      ["KK3KXAECte4", "Megalovania · Toby Fox · Undertale"],
      ["ZNGqBDRJgvo", "Last Surprise · Shoji Meguro · Persona 5"],
      ["QHRuTYtSbJQ", "BFG Division · Mick Gordon · Doom"],
      ["g60bPpXEq9Q", "Setting Sail, Coming Home · Darren Korb · Bastion"],
      ["ojx8dyes__8", "In the Blood · Darren Korb · Hades"],
      ["2c_cOxx69H0", "Hollow Knight · Christopher Larkin · Hollow Knight"],
      ["GqRmqV6qDB4", "Simple and Clean · Hikaru Utada · Kingdom Hearts"],
      ["f1-eY31Bw7A", "Weight of the World · Keiichi Okabe · NieR Automata"],
      ["813-3iL5OsE", "Dragonborn · Jeremy Soule · Skyrim"],
      ["r6zIGXun57U", "Legends Never Die · Against The Current · League of Legends"],
      ["FSVHx23ByhM", "Ezio's Family · Jesper Kyd · Assassin's Creed II"],
      ["-JZLqTnZZlY", "Still Alive · Jonathan Coulton · Portal"],
    ],
  },
  epic: {
    name: "presetEpic", // clé de traduction (i18n.js)
    items: [
      ["lHZBBE4a02s", "TOMORROW · BiSH · Kingdom"],
      ["WbW8Z6TFW7o", "Ikite, Sansan · Ikimono-gakari · Kingdom"],
      ["jwu6YmLEBj8", "Forces · Susumu Hirasawa · Berserk"],
      ["DrWiRdFajTQ", "Tell Me Why · Penpals · Berserk"],
      ["8DizBlRFMD4", "Inferno · 9mm Parabellum Bullet · Berserk"],
      ["3bqLGebDRIY", "Gwyn, Lord of Cinder · Motoi Sakuraba · Dark Souls"],
      ["BeJ-Kscdp4w", "Majula · Motoi Sakuraba · Dark Souls II"],
      ["x0euNw-4YOo", "Soul of Cinder · Yuka Kitamura · Dark Souls III"],
      ["KBP1zYwBzOE", "Elden Ring · Tsukasa Saitoh · Elden Ring"],
      ["oGiEST4kERk", "Bloodborne · Ryan Amon · Bloodborne"],
      ["z34enKCqRGk", "Travelers · Andrew Prahlow · Outer Wilds"],
      ["Xpkc-NU1KA0", "Outer Wilds · Andrew Prahlow · Outer Wilds"],
      ["H76_uW1Fnso", "Vogel im Käfig · Hiroyuki Sawano · Attack on Titan"],
      ["289H9XqmmpM", "Ashes on the Fire · Kohta Yamamoto · Attack on Titan"],
      ["5DjFpPSuGR0", "MUKANJYO · Survive Said The Prophet · Vinland Saga"],
      ["U9Tnppi4bZ0", "Creation and Beyond · Andreas Waldetoft · Stellaris"],
      ["sPIcscQRMVM", "The Celestial City · Andreas Waldetoft · Stellaris"],
      ["Ea1eWarxdxQ", "Vigil · Jack Wall · Mass Effect"],
      ["1fd5P98Apzg", "Nascence · Austin Wintory · Journey"],
      ["PwT2Ceiyt0Q", "Ori and the Blind Forest · Gareth Coker"],
      ["jpyVfd8TyoI", "God of War · Bear McCreary"],
      ["Gz0yO-5zDLU", "Rift Apart · Mark Mothersbaugh · Ratchet & Clank"],
      ["J7uLGRume5A", "Spyro the Dragon · Stewart Copeland"],
      ["QzG5QWcKTSc", "Crash Bandicoot · Vicarious Visions"],
    ],
  },
  // Les mixes de dedeco (DJ de musique de jeux vidéo) ont un chapitre par morceau, nommé avec
  // le jeu et le compositeur : en blind test par chapitres, chaque morceau devient une manche.
  dedeco: {
    name: "presetDedeco", // clé de traduction (i18n.js)
    items: [
      ["2DOFYQlkFzE", "The PlayStation 1 Drum & Bass DJ Mix · dedeco"],
      ["Fp07SxPU6q8", "PlayStation 2 Drum & Bass DJ Mix · dedeco"],
      ["zMfoB9IPevs", "PlayStation 2 Drum & Bass DJ Mix Part 2 · dedeco"],
      ["ZS_Mb_2veWg", "PlayStation 1 & 2 House Music DJ Mix · dedeco"],
      ["cLDvT3cSeuI", "PS2 Techno & Trance DJ Mix · dedeco"],
      ["ZXkT0SeGOyY", "Strictly WipEout Mix · dedeco"],
      ["_x24TjkJIDE", "The Best Tekken Music DJ Mix · dedeco"],
      ["5s947AzWcYI", "Super Chill Video Game Music DJ Set · dedeco"],
      ["WclPSwO555o", "Tropical Video Game Music · dedeco"],
      ["sVYTN1DN8R4", "The Smoothest Video Game Jams · dedeco"],
      ["jt-EVBR9U8Q", "Video Game Music DJ Set #01 · dedeco"],
      ["kLRjtoxEOoI", "Video Game Music DJ Set #02 · dedeco"],
      ["BBiJ7zkldCo", "Deep House VGM Mix · dedeco"],
      ["FQ13OFmRF-4", "Dust · dedeco"],
    ],
  },
  anime: {
    name: "presetAnime", // clé de traduction (i18n.js)
    items: [
      ["x1FV6IrjZCY", "Gurenge · LiSA · Demon Slayer"],
      ["M2cckDmNLMI", "KICK BACK · Kenshi Yonezu · Chainsaw Man"],
      ["ZRtdQ81jPUQ", "Idol · YOASOBI · Oshi no Ko"],
      ["KpsJWFuVTdI", "Blue Bird · Ikimono-gakari · Naruto Shippuden"],
      ["dlFA0Zq1k2A", "Silhouette · KANA-BOON · Naruto Shippuden"],
      ["2B6nj38AdD0", "Guren no Yumiya · Linked Horizon · Attack on Titan"],
      ["1tk1pqwrOys", "Kaikai Kitan · Eve · Jujutsu Kaisen"],
      ["CbH2F0kXgTY", "Mixed Nuts · Official HIGE DANdism · Spy x Family"],
      ["mLW35YMzELE", "Bling-Bang-Bang-Born · Creepy Nuts · Mashle"],
      ["fhzKLBZJC3w", "SPECIALZ · King Gnu · Jujutsu Kaisen"],
      ["wfCcs0vLysk", "Inferno · Mrs. GREEN APPLE · Fire Force"],
      ["PDSkFeMVNFs", "Zenzenzense · RADWIMPS · Your Name"],
      ["Fve_lHIPa-I", "unravel · TK from Ling tosite sigure · Tokyo Ghoul"],
      ["S2IOrt-n2fc", "again · YUI · Fullmetal Alchemist Brotherhood"],
      ["OBqw818mQ1E", "The Rumbling · SiM · Attack on Titan"],
      ["o6wtDPVkKqI", "A Cruel Angel's Thesis · Yoko Takahashi · Neon Genesis Evangelion"],
      ["d75ov4HvRrM", "Tank! · Yoko Kanno & Seatbelts · Cowboy Bebop"],
      ["tLQLa6lM3Us", "Zankyosanka · Aimer · Demon Slayer"],
      ["AE4b9jO1uB4", "GO!!! · FLOW · Naruto"],
      ["1FliVTcX8bQ", "New Genesis · Ado · One Piece Film Red"],
      ["r7n-L5B0bBw", "We Are! · Hiroshi Kitadani · One Piece"],
    ],
  },
};

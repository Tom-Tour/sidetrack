// Playlists toutes prêtes. Uniquement des vidéos publiées par les ayants droit (chaînes des
// artistes, des compositeurs, des labels, des éditeurs, ou chaînes « Topic » qui diffusent
// les albums pour eux) : les écouter rémunère ceux qui les ont faites. Toutes acceptent
// d'être intégrées, donc lues par le lecteur de Sidetrack.
//
// Titres « Morceau · Artiste · Œuvre » : en blind test, chaque morceau du titre est une
// bonne réponse (le jeu découpe sur « · »).
const PRESETS = {
  games: {
    name: { fr: "🎮 Musiques de jeux vidéo", en: "🎮 Video game music" },
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
  anime: {
    name: { fr: "🌸 Génériques d'animes", en: "🌸 Anime openings" },
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

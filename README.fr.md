# <img src="icons/icon.svg" width="40" align="top" alt=""> Sidetrack

[English](README.md) · **Français**

[![Installer depuis Firefox Add-ons](https://img.shields.io/badge/Firefox-Installer%20le%20module-FF7139?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/fr/firefox/addon/sidetrack/) [![Soutenir sur Ko-fi](https://img.shields.io/badge/Ko--fi-Soutenir-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

Une extension Firefox pour écouter des playlists YouTube locales dans la barre latérale pendant que tu navigues, jouer au blind test seul ou à plusieurs, et écouter ensemble dans des salons.

## Fonctionnalités

- **Playlists locales** : créer, renommer, supprimer, changer ; ajouter une vidéo YouTube ou toute une playlist publique en collant son lien ; réordonner par glisser-déposer ; déplier les chapitres d'une vidéo et partir de n'importe lequel ; enchaînement et lecture aléatoire
- **Lecture dans un onglet masqué** : la musique continue barre latérale fermée ; la barre latérale est une télécommande, 📺 affiche la vidéo
- **Blind test** : ordre aléatoire sans répétition, vidéo cachée, départ au début, à un moment aléatoire ou à un chapitre aléatoire (chaque chapitre d'une compilation devient une manche), extraits minutés. La partie s'enchaîne toute seule : temps écoulé, réponse, puis manche suivante après la pause choisie (ou à la main). Des indices façon pendu dévoilent des lettres du titre au fil du temps, et chaque lettre baisse les points qu'une réponse peut encore rapporter
- **Points** : réponses écrites notées sur 10 (tous les points pour une réponse reconnue comme juste, des points partiels dès 4 lettres consécutives en commun avec le titre, seule la meilleure réponse de chacun compte), ou chacun se juge (Trouvé / Raté)
- **Salons** (🌐) : un seul champ pour créer ou rejoindre un salon par son nom, les salons publics juste en dessous. Les amis rejoignent avec un lien (rien à installer) ou depuis leur propre Sidetrack. Lecture synchronisée avec un chat ; les invités proposent des vidéos, des chapitres ou des moments, et un lien YouTube posté dans le chat s'ajoute à la playlist de l'hôte d'un clic
- **Blind test en salon**, de deux façons : **❓ Blind test**, où l'hôte joue aussi et ne voit rien à l'avance, ou **🎤 Animateur**, où l'hôte voit tout (titres, vidéo, réponses) et donne les points à la main ou les laisse compter. Les réponses restent cachées jusqu'à la révélation, sauf si un joueur passe de 🔒 à 💬 pour discuter en clair
- **Codes d'identité** : 4 caractères à côté de chaque nom (joueurs, chat, listes des bloqués et des bannis), liés à l'identité de chacun ; exclure, bannir ou bloquer passe par une fiche qui écrit les conséquences
- **Bloquer** quelqu'un dans le salon d'un autre (clic sur son nom, puis Bloquer… et confirmer) : ses messages et sa pastille disparaissent chez toi, les tiens chez lui, dans tous les salons, et il ne peut plus entrer dans ceux que tu crées. Bloquer l'hôte fait quitter le salon et te ferme ses salons
- **Playlists toutes prêtes** (📚) : musiques de jeux vidéo, bandes-son épiques de dark fantasy et d'espace, génériques d'animes (uniquement des vidéos officielles : artistes, compositeurs, labels, éditeurs, les écouter rémunère ceux qui les ont faites), et les mixes de musique de jeux vidéo de dedeco, un morceau par manche en mode chapitres
- **Sauvegarde** des playlists dans un fichier, et restauration
- Bouton dans la barre d'outils : il ouvre ou ferme la barre latérale, avec un badge pour les messages du salon arrivés pendant qu'elle était fermée
- Export d'une playlist vers YouTube (sans connexion ni clé d'API, 50 vidéos par lien)
- Français et anglais (automatique, ou au choix dans les réglages)

## Vie privée

Sidetrack n'a ni serveur ni statistiques : rien n'est envoyé au développeur. Ce qui sort de ton navigateur, et vers qui :

- **YouTube** : les identifiants des vidéos que tu ajoutes (pour lire leurs titres et leurs chapitres) et les vidéos que tu écoutes, par le lecteur intégré de YouTube, comme sur n'importe quel site qui intègre une vidéo.
- **GitHub Pages** (`tom-tour.github.io`) : la page du lecteur et la page invité y sont chargées, GitHub voit donc ton adresse IP à ce moment-là.
- **Salons** (seulement si tu en ouvres ou en rejoins un) :
  - le serveur public de [PeerJS](https://peerjs.com) met les navigateurs en relation : il voit ton adresse IP et le nom du salon (il fait partie de l'identifiant de connexion), jamais les messages ;
  - ensuite tout le monde est connecté **directement** (pair-à-pair, chiffré par WebRTC) : l'hôte et les invités voient l'**adresse IP** les uns des autres ;
  - les membres du salon reçoivent ton pseudo, ton code d'identité, tes messages, tes réponses (cachées jusqu'à la révélation, sauf pour l'animateur) et, de la part de l'hôte, la playlist et la position de lecture.
- **Les salons publics** sont annoncés sur des relais [Nostr](https://nostr.com) publics : nom du salon, nombre de joueurs, mode et partie en cours, signés avec une clé jetable par salon. N'importe qui peut lire ces annonces. Les salons privés ne sont jamais annoncés.

Les limites, honnêtement :
- **Un salon privé n'est privé que par son nom** : qui connaît ou devine le nom peut essayer d'entrer. Choisis un nom difficile à deviner.
- **L'hôte a la main** : un animateur voit les réponses avant la révélation, et l'hôte peut exclure ou bannir. Tout passe par l'hôte : quand tu bloques quelqu'un dans un salon, son hôte sait qui (seulement les personnes présentes dans ce salon, jamais ta liste entière), et c'est lui qui arrête de faire passer les messages entre vous.
- **Un bannissement vise une identité, pas une adresse IP** (une IP change avec un VPN, et WebRTC la rend peu fiable). Une nouvelle identité coûte une preuve de travail d'une vingtaine de secondes dans Firefox, une seule fois : ça empêche de revenir des milliers de fois, pas de se créer quelques nouvelles identités.
- Déclaration sur addons.mozilla.org : `personalCommunications` (le chat des salons).

## Installation

Installe-le depuis **[addons.mozilla.org](https://addons.mozilla.org/fr/firefox/addon/sidetrack/)** (Firefox 140 ou plus récent).

À la première ouverture dans une session Firefox, un onglet Sidetrack apparaît : clique sur **Lancer Sidetrack** (Firefox n'autorise le son qu'après un clic dans la page). L'onglet se range ensuite tout seul et reste prêt jusqu'à la fermeture de Firefox. Pour ne plus jamais avoir cette étape, autorise la lecture automatique pour `tom-tour.github.io` (Paramètres → Vie privée et sécurité → Permissions → Lecture automatique → Paramètres…).

Pour essayer la version de développement, en module temporaire :

1. Ouvre `about:debugging#/runtime/this-firefox`
2. Clique sur **Charger un module complémentaire temporaire…** et choisis `manifest.json`
3. Ouvre la barre latérale avec `Alt+Maj+Y` ou le bouton de la barre d'outils

Un module temporaire est retiré à la fermeture de Firefox, et ses données avec lui : sauvegarde tes playlists (⚙ → Sauvegarde) avant de fermer, ou installe-le depuis addons.mozilla.org.

## Fonctionnement

YouTube refuse de lire une vidéo intégrée dans une page d'extension : le lecteur vit donc sur une petite page statique servie par GitHub Pages (`player/`). Il joue dans un onglet masqué, piloté par l'extension à travers un script de contenu et `postMessage`. En blind test, la page cache elle-même la vidéo : rien n'est dévoilé même si l'onglet s'affiche. Tes playlists ne quittent jamais ton navigateur.

Le moteur (`background.js`, `room.js`, `guest.js`) possède tout l'état ; la barre latérale est une télécommande qui reçoit des instantanés et envoie des commandes. Les invités sans l'extension rejoignent par `join/`, servie aussi par GitHub Pages, avec le même protocole.

Les salons passent par [PeerJS](https://peerjs.com) : chaque invité signe un défi aléatoire de l'hôte avec une clé d'identité gardée dans son navigateur (personne ne peut se faire passer pour un autre ni rejouer une connexion), et apporte une preuve de travail (`scrypt`, 7 bits à zéro) qui donne aussi son code d'identité. Limites fixes pour tous : 2 messages par seconde à l'envoi, 3 acceptés ; qui insiste est mis en sourdine une minute ; une connexion muette depuis 30 secondes est fermée ; tout ce qui vient des autres est nettoyé avant usage ; 24 joueurs par salon.

Le dossier `common/` est la base commune de mes extensions Firefox (addon-kit) : thème, vocabulaire commun, outils des salons (limites, poignée de main signée, battement de cœur), preuve de travail. Il n'est jamais modifié ici, seulement recopié depuis le kit.

Librairies, non modifiées : [PeerJS](https://peerjs.com) 1.5.4, [nostr-tools](https://github.com/nbd-wtf/nostr-tools) 2.7.2, [scrypt-js](https://github.com/ricmoo/scrypt-js) 3.0.1, chacune avec son fichier de licence à côté d'elle (MIT ; Unlicense pour nostr-tools).

## Tests

```
cd tests
npm install
npm test
```

- `engine.test.cjs` : plusieurs moteurs dans des contextes `vm` séparés, avec un faux réseau PeerJS, de faux relais Nostr et un faux `Worker` qui fait tourner la vraie preuve de travail (difficulté réduite) : identités et codes, salons, limites, points du blind test, exclusion, bannissement et blocage, battement de cœur, sauvegarde
- `sidebar.test.cjs` et `join.test.cjs` : la vraie barre latérale et la vraie page invité dans jsdom, reliées à de vrais moteurs
- `e2e/run.py` : deux Firefox invisibles et séparés, sur le vrai réseau (`pip install -r tests/e2e/requirements.txt`, puis `python tests/e2e/run.py`)

## Soutenir

Si Sidetrack t'est utile, tu peux soutenir son développement sur [Ko-fi](https://ko-fi.com/tom_t).

## Licence

Copyright (C) 2026 tom.tourbez

Sidetrack est un logiciel libre : tu peux le redistribuer et le modifier selon les termes de la licence publique générale GNU (GPL) publiée par la Free Software Foundation, version 3 ou (à ton choix) toute version ultérieure. Il est fourni SANS AUCUNE GARANTIE. Texte complet dans [LICENSE](LICENSE) (GPL-3.0-or-later).

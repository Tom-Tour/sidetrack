# Sidetrack

A Firefox extension to build local playlists from YouTube links and play them in the sidebar while you browse any page.

*Extension Firefox : crée des playlists locales à partir de liens YouTube et écoute-les dans la barre latérale pendant que tu navigues.*

> Early version.

## Features

- Named local playlists: create, rename, delete, switch
- Add a YouTube video or a whole playlist by pasting its link
- Plays in the Firefox sidebar, keeps playing while you switch tabs
- Auto-advance and shuffle
- **Blind-test mode**: random order without repeats, hidden video, start at the beginning, a random point or a random chapter, timed clips (10–30 s or the chapter length), reveal and score. With chapters, every chapter of a compilation becomes a round
- Reorder the queue by drag and drop, unfold a video's chapters and start from any of them
- **Rooms** (🌐 button): one field to create or join a room by name, public rooms listed right below. Invite friends with a link (no install needed, peer-to-peer). Watch together in sync with a chat; guests suggest videos, chapters or moments, the host plays them for everyone. In blind test, guesses stay private until the reveal and the host awards the points
- Chat: guests' names are unique and colored; in blind test the host sees a “✓ likely” mark on guesses that look like the title (the host still decides); unread badge on 🌐 and optional sound
- Export a playlist to YouTube (no login or API key needed, 50 videos per link)
- Settings page (⚙): language, hide multiplayer if you only play solo, log
- English and French (automatic, or chosen in the settings); guests pick their own language
- Everything is stored locally in Firefox

## Try it

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json`
3. Toggle the sidebar with `Alt+Shift+Y`

## How it works

YouTube refuses to play embedded videos inside extension pages, so the player lives on a tiny static page served by GitHub Pages (`player/`). The sidebar shows that page in an iframe and drives it with `postMessage`. Your playlists never leave your browser.

Rooms use [PeerJS](https://peerjs.com) (bundled in `vendor/`): its public server only introduces the browsers to each other, then everything goes peer-to-peer. Guests join through `join/`, also served by GitHub Pages.

Public rooms are announced on public [Nostr](https://nostr.com) relays with [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (bundled in `vendor/`), signed with a throwaway key per room. Announcements are refreshed every minute and expire on their own after 3 minutes. Private rooms are never announced: they are only reachable with their code.

## Room security

- **Signed identities**: every guest has a key kept in their browser and signs a random challenge from the host on each connection, so nobody can pose as someone else or replay a connection. Kicking (until the room closes) and banning (for good, list in the settings) target that identity
- **Proof of work in public rooms**: a new identity must first find a number such that `scrypt(identity + number)` starts with 8 zero bits (about 30 seconds, once per browser). Checking it takes a fraction of a second. scrypt needs 16 MB per try, so graphics cards gain almost nothing: a banned player can't come back with thousands of new identities. Private rooms skip it
- **Flood control**, the same fixed rule for everyone: guests send at most 2 messages per second, the host accepts 3; someone who keeps pushing (a modified client) is muted for a minute
- 24 players per room at most; everything coming from guests is validated and cleaned
- **IP addresses**: as in any peer-to-peer connection, the host and guests can see each other's IP address. Bans don't rely on IPs (unreliable with WebRTC, and a VPN changes them): the proof of work does that job

Libraries: [PeerJS](https://peerjs.com), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), [scrypt-js](https://github.com/ricmoo/scrypt-js) (MIT), bundled in `vendor/`.

## Support

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

## License

Copyright (C) 2026 tom.tourbez

Sidetrack is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text (GPL-3.0-or-later).

# <img src="icons/icon.svg" width="40" align="top" alt=""> Sidetrack

**English** · [Français](README.fr.md)

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

A Firefox extension to play local YouTube playlists in the sidebar while you browse, play blind test alone or with friends, and listen together in rooms.

## Features

- **Local playlists**: create, rename, delete, switch; add a YouTube video or a whole public playlist by pasting its link; reorder by drag and drop; unfold a video's chapters and start from any of them; auto-advance and shuffle
- **Plays in a hidden tab**, so the music keeps going with the sidebar closed; the sidebar is a remote control, 📺 shows the video
- **Blind test**: random order without repeats, hidden video, start at the beginning, a random point or a random chapter (every chapter of a compilation becomes a round), timed clips. The game moves on by itself: time's up, answer, then the next round after a pause you choose (or by hand). Hangman-style hints reveal letters of the title as time goes on, and each letter lowers the most a guess can still earn
- **Points**: written guesses scored out of 10 (full points for a guess recognized as right, partial points from 4 letters in a row in common with the title, only each player's best guess counts), or everyone judges themselves (Got it / Missed)
- **Rooms** (🌐): one field to create or join a room by name, public rooms listed right below. Friends join with a link (no install needed) or from their own Sidetrack. Watch in sync with a chat; guests suggest videos, chapters or moments, and a YouTube link posted in the chat can be added to the host's playlist with one click
- **Blind test in a room**, two ways: **❓ Blind test**, where the host plays along and sees nothing in advance, or **🎤 Quizmaster**, where the host sees everything (titles, video, guesses) and gives the points by hand or lets them be counted. Guesses stay hidden until the reveal, unless a player switches 🔒 → 💬 to chat in the open
- **Identity codes**: 4 characters next to every name (players, chat, banned list), tied to each person's identity; kicking or banning goes through a person card that spells out the consequences
- **Ready-made playlists** (📚): video game music, epic dark fantasy and space soundtracks, anime openings (official uploads only: artists, composers, labels, publishers, so listening pays the people who made them), and the video game music DJ mixes of dedeco, one round per track in chapter mode
- **Backup** of your playlists to a file, and restore
- Toolbar button: opens or closes the sidebar, with a badge for room messages that arrived while it was closed
- Export a playlist to YouTube (no login or API key, 50 videos per link)
- English and French (automatic, or chosen in the settings)

## Privacy

Sidetrack has no server and no analytics: nothing is sent to the developer. What leaves your browser, and to whom:

- **YouTube**: the IDs of the videos you add (to fetch titles and chapters) and the videos you play, through YouTube's embedded player, as on any site that embeds a video.
- **GitHub Pages** (`tom-tour.github.io`): the player page and the guest page are loaded from there, so GitHub sees your IP address when they load.
- **Rooms** (only if you open or join one):
  - the public [PeerJS](https://peerjs.com) server introduces the browsers to each other: it sees your IP address and the room name (it is part of the connection ID), never the messages;
  - then everyone is connected **directly** (peer-to-peer, encrypted by WebRTC): the host and the guests can see each other's **IP address**;
  - room members receive your nickname, your identity code, your chat messages, your guesses (hidden until the reveal, except from the quizmaster) and, from the host, the playlist and the playback position.
- **Public rooms** are announced on public [Nostr](https://nostr.com) relays: room name, number of players, mode and whether a game is in progress, signed with a throwaway key per room. Anyone can read these announcements. Private rooms are never announced.

Limits, honestly:
- **A private room is only as private as its name**: whoever knows or guesses the name can try to join. Use a name that is hard to guess.
- **The host is in charge**: a quizmaster sees guesses before the reveal, and the host can kick or ban.
- **Bans target an identity, not an IP address** (IPs change with a VPN, and WebRTC makes them unreliable). A new identity costs a proof of work of about twenty seconds in Firefox, once: this stops someone from coming back thousands of times, not from making a few new identities.
- Data declaration on addons.mozilla.org: `personalCommunications` (the room chat).

## Installation

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json`
3. Toggle the sidebar with `Alt+Shift+Y` or the toolbar button
4. The first time you open it in a Firefox session, a Sidetrack tab shows up: click **Launch Sidetrack** (Firefox only allows sound after a click in the page). The tab then hides itself and stays ready until Firefox closes. To skip this step for good, allow autoplay for `tom-tour.github.io` (Settings → Privacy & Security → Permissions → Autoplay → Settings…)

A temporary add-on is removed when Firefox closes, and its data with it: save your playlists (⚙ → Backup) before closing, or install a signed version.

## How it works

YouTube refuses to play embedded videos inside extension pages, so the player lives on a small static page served by GitHub Pages (`player/`). It plays in a hidden tab, driven by the extension through a content script and `postMessage`. In blind test the page covers the video itself, so nothing is revealed even if the tab shows up. Your playlists never leave your browser.

The engine (`background.js`, `room.js`, `guest.js`) owns all the state; the sidebar is a remote control that receives snapshots and sends commands. Guests without the extension join through `join/`, also served by GitHub Pages, with the same protocol.

Rooms use [PeerJS](https://peerjs.com): each guest signs a random challenge from the host with an identity key kept in their browser (nobody can pose as someone else or replay a connection), and brings a proof of work (`scrypt`, 7 zero bits) that also gives their identity code. Fixed limits for everyone: 2 messages per second sent, 3 accepted; someone who keeps pushing is muted for a minute; a connection silent for 30 seconds is closed; everything coming from others is cleaned before use; 24 players per room.

The `common/` folder is the shared base of my Firefox extensions (addon-kit): theme, shared vocabulary, room tools (limits, signed handshake, heartbeat), proof of work. It is never edited here, only copied from the kit.

Libraries, unmodified: [PeerJS](https://peerjs.com) 1.5.4, [nostr-tools](https://github.com/nbd-wtf/nostr-tools), [scrypt-js](https://github.com/ricmoo/scrypt-js) 3.0.1 (MIT).

## Tests

```
cd tests
npm install
npm test
```

- `engine.test.cjs`: several engines in separate `vm` contexts with a fake PeerJS network, fake Nostr relays and a fake `Worker` running the real proof of work (lower difficulty): identities and codes, rooms, limits, blind test points, kick and ban, heartbeat, backup
- `sidebar.test.cjs` and `join.test.cjs`: the real sidebar and guest page in jsdom, wired to real engines
- `e2e/run.py`: two separate headless Firefox instances on the real network (`pip install -r tests/e2e/requirements.txt`, then `python tests/e2e/run.py`)

## Support

If Sidetrack is useful to you, you can support its development on [Ko-fi](https://ko-fi.com/tom_t).

## License

Copyright (C) 2026 tom.tourbez

Sidetrack is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text (GPL-3.0-or-later).

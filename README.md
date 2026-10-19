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
- **Rooms**: invite friends with a link (no install needed, peer-to-peer). Watch together in sync with a chat; guests suggest videos, chapters or moments, the host plays them for everyone. In blind test, guesses stay private until the reveal and the host awards the points
- Export a playlist to YouTube (no login or API key needed, 50 videos per link)
- Everything is stored locally in Firefox

## Try it

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json`
3. Toggle the sidebar with `Alt+Shift+Y`

## How it works

YouTube refuses to play embedded videos inside extension pages, so the player lives on a tiny static page served by GitHub Pages (`player/`). The sidebar shows that page in an iframe and drives it with `postMessage`. Your playlists never leave your browser.

Rooms use [PeerJS](https://peerjs.com) (bundled in `vendor/`): its public server only introduces the browsers to each other, then everything goes peer-to-peer. Guests join through `join/`, also served by GitHub Pages.

## Support

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

## License

Copyright (C) 2026 tom.tourbez

Sidetrack is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text (GPL-3.0-or-later).

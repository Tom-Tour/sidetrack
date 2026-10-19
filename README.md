# Sidetrack

A Firefox extension to build local playlists from YouTube links and play them in the sidebar while you browse any page.

*Extension Firefox : crée des playlists locales à partir de liens YouTube et écoute-les dans la barre latérale pendant que tu navigues.*

> Early prototype. Planned: named playlists, blind-test mode, export to YouTube, multiplayer rooms.

## Features

- Add a YouTube video or a whole playlist by pasting its link
- Plays in the Firefox sidebar, keeps playing while you switch tabs
- Auto-advance and shuffle
- Your queue is stored locally in Firefox

## Try it

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json`
3. Toggle the sidebar with `Alt+Shift+Y`

## How it works

YouTube refuses to play embedded videos inside extension pages, so the player lives on a tiny static page served by GitHub Pages (`player/`). The sidebar shows that page in an iframe and drives it with `postMessage`. Your playlists never leave your browser.

## Support

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

## License

Copyright (C) 2026 tom.tourbez

Sidetrack is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text (GPL-3.0-or-later).

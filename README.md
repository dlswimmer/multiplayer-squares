# Squares

A dots-and-boxes style game for 2 to 8 players. Take turns drawing one line between two dots. Close a box to claim it (it gets your animal) and take another turn. Whoever has the most boxes at the end wins.

Play at **https://dlswimmer.github.io/multiplayer-squares/** once GitHub Pages is turned on (see below).

## Ways to play

- **Start a game (each on your own device).** One person taps *Start a game* and gets a 4-letter room code, a link and a QR code. Everyone else scans the QR code, opens the link, or types the code and taps *Join*. The host picks the board size and taps *Start*.
- **Play on this one device.** Pass a phone or tablet around. Set up 2 to 8 players and a board size.

Board size can be anything from 2×2 to 20×20 boxes (rows and columns are set separately).

## Phones, tablets and computers

- Pinch to zoom and drag to move around the board. On a computer, use the mouse wheel. The ＋ / － / ⤢ buttons work everywhere (⤢ shows the whole board).
- On touch screens you tap a line twice to draw it: the first tap shows it dashed, the second tap draws it. That stops accidental lines when zooming and scrolling. It can be turned off in the ☰ menu.
- The screen is kept awake during a game so phones don't drop off.

## How online play works

There is no server of ours and no accounts. The host's device holds the game. Other devices connect straight to it over WebRTC using [PeerJS](https://peerjs.com/). The free public PeerJS server is only used to introduce the devices to each other.

- If a player's device drops off (or they reload), they reconnect automatically and keep their place. While they're gone, the host can tap *Skip their turn*.
- If the host reloads, the home screen offers *Go back to your game*, and the other players reconnect on their own.
- Some strict networks (some school or work Wi-Fi) block direct connections between devices. Home Wi-Fi and phone data normally work.

## Turning on GitHub Pages

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
3. Pick the **main** branch and the **/ (root)** folder, then **Save**.
4. After a minute or two the game is live at https://dlswimmer.github.io/multiplayer-squares/.

## Developing

It's plain HTML, CSS and JavaScript with no build step.

```sh
npm start          # serves the folder at http://localhost:8000
npm test           # runs the game-rules tests (Node 18+)
```

To try online play in one browser without WebRTC, open `http://localhost:8000/?net=local` in several tabs. Each tab acts as a separate player.

Files:

- `js/game.js` — the rules (no browser code, tested in `tests/`)
- `js/board.js` — drawing the board, tapping, pinch-zoom and panning
- `js/net.js` — connections between devices
- `js/app.js` — screens, lobby and turns
- `vendor/` — PeerJS 1.5.4 and qrcode-generator 1.4.4 (both MIT licensed), kept in the repo so the game doesn't depend on a CDN

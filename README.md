# Syncify

Share one mouse and keyboard across your **Mac** and **PC**, both ways — plus clipboard copy/paste between them.

Designed to stay small: one compact window, tray background, no cloud, LAN only.

## Features

- **Bidirectional control** — move the cursor off a screen edge to drive the other machine; do the same from the other side
- **Clipboard sync** — text copied on one computer is available on the other
- **Return hotkey** — `Ctrl+Alt+Backspace` (Mac: `Control+Option+Backspace`) brings control back
- **Host or Join** — one machine hosts, the other connects by IP
- **Auto-reconnect** — stays linked after sleep/reboot until you hit Disconnect

## Install (both computers)

You need [Node.js 18+](https://nodejs.org/) on each machine.

```bash
cd Syncify
npm install
npm run rebuild
npm start
```

Copy this whole folder to the other computer (or clone the same project) and run the same commands there.

> Native modules (`uiohook-napi`, nut.js) must be rebuilt for Electron on **each** OS. Always run `npm run rebuild` after `npm install` on that machine.

## Setup

1. Put both computers on the **same Wi‑Fi / LAN**.
2. On computer **A**, open Syncify → pick the **monitor + edge** that leads to the other machine → **Host** → note the IP shown.
3. Allow port **24892** through the firewall when Windows/macOS asks (or add a rule).
4. On computer **B**, pick its exit monitor/edge (usually the opposite side) → **Join** → enter A’s IP → Connect.
5. Drag the mouse off the configured edge to control the other machine. Press `Ctrl+Alt+Backspace` to return.

Once linked, Syncify **keeps reconnecting automatically** if a machine sleeps, reboots, or drops off Wi‑Fi. Only **Disconnect** in the app turns that off.

### Multi-monitor example (your setup)

PC has two screens (Left + Middle), Mac sits under the left one:

- **On the PC:** select monitor **Left**, edge **↓**
- **On the Mac:** select its screen, edge **↑**

Only the bottom of the left PC monitor switches to the Mac — the middle monitor’s bottom edge stays normal.

### Theme

Dark mode is the default. Use the sun/moon button next to the Syncify title to switch light ↔ dark (choice is remembered).

### Example (single screens)

```
[ Mac ]  ←left edge / right edge→  [ Windows PC ]
```

- On the Mac: layout = **right** (PC is to the right)
- On the PC: layout = **left** (Mac is to the left)

## Permissions

### macOS

Grant Syncify (or Electron) these in **System Settings → Privacy & Security**:

- **Accessibility** — inject mouse/keyboard
- **Input Monitoring** — capture input while controlling the other machine

Then quit and reopen Syncify.

### Windows

- Allow Syncify through **Windows Defender Firewall** for private networks when prompted
- Run normally (admin usually not required)

## Tips for low resource use

- Close the window (it stays in the tray) — Syncify keeps running
- Prefer a wired LAN or solid 5 GHz Wi‑Fi for snappier mouse movement
- Only text clipboard is synced in this version (not files/images)

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Yellow warning about input modules | `npm run rebuild` then restart |
| Cannot connect | Same network? Correct IP? Firewall allows 24892? |
| Cursor hops but no clicks/keys on Mac | Enable Accessibility + Input Monitoring |
| Immediately jumps back after returning | Wait a second (cooldown) or nudge mouse inward |
| Clipboard only | Input rebuild failed — clipboard still works without native modules |

## How it works

1. Host opens a local WebSocket on port 24892.
2. Join connects to that host.
3. Edge detection hands control to the peer; input events are streamed and injected with nut.js.
4. Clipboard is polled every ~400 ms and pushed when it changes.

No accounts, no internet required — only your LAN.

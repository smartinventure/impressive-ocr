# Impressive OCR — brand assets

Anchor green `#14532D`. Mark geometry unchanged from the original lockup: 100x100, rx 22,
bars at y 28 / 45 / 62, fourth line broken 34 + 14 — that break is the brand idea.

| File | Use |
|---|---|
| logo-horizontal-light.svg | app header, README, docs (light) |
| logo-horizontal-dark.svg | dark backgrounds — mark lightens to #1E7A42, wordmark white |
| app-icon.svg | desktop shortcut, main app |
| app-icon-server.svg | headless server shortcut — outlined, darker ground, green bars |
| app-icon-mono.svg | print / single-colour contexts |
| favicon.svg | browser tab (32px; bars thickened to survive rounding) |
| tray-idle / running / paused / error .svg | system tray, 16px grid, thicker bars |
| tray-template.svg | macOS template image — black + alpha only, OS tints it |

Wordmark is Space Grotesk (400 "Impressive" + 700 "OCR"), letter-spacing -1.6 at 52px.
The lockup SVGs reference the font by name; convert text to outlines before shipping
anywhere the font may be absent.

Status colours (never colour alone — always icon + label):
queued #4C5663 · running #1D4ED8 · paused #B45309 · succeeded #0F766E · failed #B91C1C · quarantined #6D28D9

# Oh My Pi — images stay blank after hidden tmux rendering

OMP marks a Kitty image as transmitted even when tmux drops the transmission because the image was rendered in a hidden window.

## Reproduction

Prerequisites: Bun, Python 3, and tmux 3.3 or newer.

```bash
bun install
bun run repro
```

The script creates an isolated tmux server and checks these cases:

1. A visible window forwards a Kitty image transmission and its Unicode placeholder.
2. A hidden window retains the placeholder but does not forward the transmission.
3. Selecting the hidden window replays the placeholder without replaying the transmission.
4. OMP's `ImageBudget` still reports that the dropped image does not need transmission.

The script does not connect to or modify existing tmux servers.

## Expected

When a tmux window becomes visible, OMP retransmits image data that may have been emitted while the window was hidden. The placeholder then resolves to the image.

## Actual

The selected window contains the Unicode placeholder, but the terminal never received the image data. OMP considers the image transmitted and does not resend it, so the reserved image area stays blank.

```text
PASS: visible tmux window forwarded the Kitty transmit and placeholder
PASS: hidden tmux window retained the placeholder but did not forward the Kitty transmit
PASS: selecting the hidden window replayed the placeholder but not the Kitty transmit
PASS: OMP ImageBudget still considers the dropped transmit resident

BUG REPRODUCED: the selected window has an unresolved image placeholder and OMP will not retransmit its data
```

## Versions

- `@oh-my-pi/pi-tui`: 18.2.6
- Bun: 1.4.2
- tmux: 3.7c
- OS: macOS, Darwin 25.6.0 arm64

## Related issues

- [#5381](https://github.com/can1357/oh-my-pi/issues/5381) added Kitty passthrough and Unicode placeholders for tmux.
- [#10353](https://github.com/can1357/oh-my-pi/issues/10353) separately notes that a dropped initial transmission leaves an image ID permanently blank.

## Upstream issue

Pending.

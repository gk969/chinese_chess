# Xiangqi · You vs Computer

[中文](README_CN.md) · English

A purely static web game: no build step, no dependencies, no audio asset files (every
sound is synthesized at runtime).

## Running it

Double-click `index.html` and play. No server, nothing to install.

The scripts are plain `<script>` tags rather than ES modules, because browsers refuse to
load module scripts and module workers over `file://` — that would force you to stand up a
local server. As it is, the whole folder can be copied anywhere and opened in any browser.
Serving it works exactly the same.

The engine travels the same way: its `.wasm` is inlined as base64 in `engine/wasm64.js`
(707,854 B, 255,173 B gzipped), because `fetch` and XHR are blocked under `file://` too. The
price is parsing 700 KB of extra text on first load; the gain is one folder and nothing to
download.

## How to play

- Click one of your pieces and the board marks every square it can legally reach right now
  (a filled dot is an empty square, a ring around a piece is a capture). Click a target to
  move there. Hovering shows a translucent preview.
- Clicking a different one of your pieces just reselects it, with no error; clicking
  somewhere unreachable clears the selection and says so.
- The right-hand panel switches difficulty (levels 1-5, 1 being the weakest) and whether you
  play Red (first move) or Black (second).
- Undo takes back one of your moves and one of the opponent's. Restart is always available,
  and you can undo after a win or a loss to carry on playing.
- Changing sides starts a new game. Difficulty can be changed mid-game; if the computer is
  thinking, it immediately restarts its search at the new level.
- The move list uses Chinese notation (炮二平五 / 砲2进7) and highlights the latest move. Below it,
  four buttons export the game to a txt file, import one back, or copy the record to the system
  clipboard and restore it from there.

## The five difficulty levels

The computer is the single-threaded WASM build of Pikafish-HCE in `engine/`. The five levels
move only two knobs: the engine's own Skill Level (its strength-limiters) and the time budget
per move.

The table below is measured with **the scheme the shipped code uses** (layer-by-layer `go depth`,
see the next section): opponent ElephantEye 3.31 on the same 200 ms limit, 20 games, eight fixed
openings with colours alternated, zero illegal moves, zero timeouts.

| Level | Skill Level | Budget | Measured per move | Avg ply | Score |
|---|---|---|---|---|---|
| 1 | 5 | 200 ms | 276 ms | 18.0 | 13% (0-5-15) |
| 2 | 8 | 200 ms | 278 ms | 15.9 | 30% (0-12-8) |
| 3 | 20 | 200 ms | 316 ms | 24.1 | 73% (9-11-0) |
| 4 | 20 | 600 ms | 729 ms | 34.4 | 83% (13-7-0) |
| 5 | 20 | 1000 ms | 1000 ms | 36.3 | 80% (12-8-0) |

Measured time always exceeds the budget, because the last layer always finishes — it can't be cut
mid-layer. The budget is the deadline for *starting* another layer, not a cap on the move.

The standard error at 20 games is about ±11%, so what holds is "level 1 is clearly the weakest,
level 2 next, and everything from 3 up is strong" — not a precise ranking of neighbours.
**Levels 4 and 5 are indistinguishable against this opponent** (83% vs 80%, inside the noise): the
opponent only gets 200 ms, so levels 3/4/5 already sit at the ceiling it allows, and going deeper
wins nothing more. The only lever that would separate 4 from 5 is more time (say 600 / 1500 ms).

The same parameters were measured before the WASM engine, using `go movetime`, against ElephantEye
and against Fairy-Stockfish 1.1 (also 200 ms each): 0/10/65/70/80% and 0/8/63/78/85%. Two
unrelated engines giving a monotonic ladder is the reason to believe the ladder rather than one
opponent. Switching to layer-by-layer widened the gap at the bottom instead (13/30 rather than
0/10), because each move now really does spend seventy-odd extra milliseconds.

Skill Level is the engine's internal strength-limiter, not "search fewer plies": it is active
whenever `level < 20`, and it picks a noisy move out of the MultiPV list at ply `1 + level`
(S5 picks at ply 6, S8 at ply 9) — and if the search never got that deep, noise is still injected
unconditionally when the search wraps up. So levels 1 and 2 calculate just as fast as level 3;
they simply **pick a deliberately worse move**. That is where the blunders come from. Levels
3/4/5 have no randomness at all and differ only in how deep they get.

## How the engine is wired in

Three constraints decide the shape of this code; the build chain and how to recompile are in
[engine/README.md](engine/README.md).

1. **The `.wasm` is inlined as base64.** The game has to run from a double-clicked
   `index.html`, and under `file://` Chrome/Edge block `fetch` and XHR, so the `.wasm` cannot be
   fetched by URL. `engine/wasm64.js` is `pikafish-hce.wasm` as base64 (530,804 B → 707,854 B of
   text, 255,173 B gzipped), injected through emscripten's `instantiateWasm`. That is the only
   size cost of this change.
2. **One think is issued layer by layer.** This build yields only where it reads a command, so a
   single `go` holds the main thread from start to `bestmove` — `go movetime 1000` freezes the
   page for a full second and the live readout never ticks once. So `js/engine.js` sends
   `go depth 1`, `2`, `3`…, yielding one macrotask (`setTimeout(0)`) between layers so the
   browser can paint a frame and clicks aren't swallowed. It stops when the accumulated wall
   clock passes the level's budget; each layer also has a hard 400,000-node cap as a bound on
   "how long the main thread blocks at once" — layer costs are wildly uneven, most layers
   1-3 ms while the deep ones run to a few hundred (measured distribution in the table below).
   Don't replace this with repeated
   `go nodes N`: measured, each slice is an independent search, depth bounces between 13 and 17
   and bestmove changes every slice, which would reduce levels 4 and 5 to 0.1-second strength.
3. **Positions travel as FEN.** `rules.js`'s `fen()` writes standard xiangqi FEN (rows in board
   order, file 0 → `a`, uppercase for Red), and the ICCS move the engine returns is mapped back
   with `r = 9 - digit`. That seam was checked against the engine's own `go perft`: js and engine
   agree exactly on perft1 and perft2 node counts, both in the start position and in asymmetric
   ones from a 12-ply random game.

If the engine fails to come up, the status line says so (`引擎异常:…`) instead of hanging
silently.

## Keeping the interface responsive

The engine runs on the main thread, but issuing one layer at a time leaves a yield between every
layer (see above). Per-layer cost is measured — the shipped issuing scheme, the same fixed openings
against ElephantEye, run under Node so the browser yield is not included:

| Budget | Plies per move | median layer | p90 | p99 | longest layer | whole move |
|---|---|---|---|---|---|---|
| 200 ms | 24.7 (median 19) | 1 ms | 20 ms | 299 ms | 510 ms | 335 ms |
| 600 ms | 39.8 (median 24) | 2 ms | 33 ms | 340 ms | 443 ms | 695 ms |
| 1000 ms | 55.4 (median 24) | 3 ms | 26 ms | 416 ms | 470 ms | 1036 ms |

Most layers cost 1-3 ms and nearly all the time goes into the last few: the final layer is 62% of
the move at the 200 ms level and 29% at 1000 ms. The 400,000-node cap keeps the longest layer under
about 0.5 s in practice, but it is soft — the engine only re-checks the node count every 390 root
moves, so it overshoots. In the browser each layer also pays one `setTimeout(0)`, and nested timers
are clamped to at least 4 ms. Measured in the page: a 1.20-second level-5 think refreshed the
readout three times (262 / 514 / 1203 ms), and that half second is the longest single block, so
animation and clicks go dull for it and behave normally outside it.

Undo, restart and changing the level mark the current think as dead: the layer already running
finishes and then it stops, and it **never sends another `go`** — otherwise it would fight the
brand-new search for the same output queue. The callback re-checks a token before being applied,
so restarting mid-think doesn't leave a ghost piece on the board.

While the computer thinks, the two lines under the status message refresh every 200 ms: the upper
one shows completed plies and elapsed time, the lower one the number of positions searched, e.g.
`电脑 · 6 层 · 0.4 秒` / `1,234,567 个局面`. Once the move lands, the same two lines are replaced
by its result. Both report the largest `info depth` seen — `info` is printed only for iterations
that **finished**. That number can reach 245, and that is not a bogus readout: 245 is the
iterative-deepening `MAX_PLY` ceiling, and once a mate is proven every ply past the mate distance
costs 1-4 ms, so a 200 ms budget burns through 200+ plies. A readout one ply behind the result is
just the 200 ms timer lagging.

Both lines have a fixed height and hold their space even when empty, and they never wrap (they
truncate). "Thinking" and "settled" therefore occupy the same height, so the readout appearing or
disappearing doesn't shove the rest of the panel up and down. The refresh is a `setTimeout` chain
rather than `requestAnimationFrame` — rAF is frozen in background tabs.

## Rules

- Blocked horse legs, stuffed elephant eyes, elephants and soldiers not crossing the river,
  advisors and generals confined to the palace, and the cannon jumping a screen to capture are
  all handled during move generation.
- **Facing generals** (both generals on the same file with nothing between them) needs no special
  case: it is equivalent to "after my move, the opponent's general captures mine", and the
  general's long-range file attack is written into `attacked()`, so the legality filter catches
  it automatically.
- **Stalemate is a loss, same as checkmate** — in xiangqi having no move is losing, not a draw.
- **Threefold repetition is a draw.** This is a simplified implementation: the full Asian rules
  on perpetual check and perpetual chase are out of scope, so in principle a position where one
  side checks forever can be scored a draw.
- No 60-move draw rule, no touch-move, no chess clock.

## Notation

The move list uses Chinese notation. Files are counted from **each player's own** right-hand side,
so Red's file 1 is at the far right of the screen and Black's file 1 at the far left. Red writes
files as `一二三四五六七八九`, Black as `1…9`.

The shape is `piece + origin file + action + destination`:

- `炮二平五` — the cannon on file 2 moves sideways to file 5.
- `马八进七` — the horse on file 8 jumps forward to file 7. Horses, elephants and advisors move
  diagonally, so a step count is always 2 and carries no information: for them the destination is
  written as a file, not as a number of steps.
- `兵七进一` — the soldier on file 7 advances one step; here the tail is a step count.

Ambiguity is resolved **positionally**, as the competition rules do: when two or more pieces of
the same kind sit on one file, the file number cannot tell them apart, so they switch to
`前` / `后` (or `前` / `中` / `后` for three), and once 前/后 is used the file number is dropped —
`前马进七`, `中兵进一`. Two same-kind pieces on different files are already unambiguous, because
the file number is part of the notation.

Notation has to be computed **before** the move is made: it reads the board as it was beforehand,
and once the move is made the other piece on that file may be counted wrong. So it is computed
once and stored in the history, which undo shortens and restart clears.

## Importing and exporting the record

Four buttons under the move list: import, export, copy, paste.

Export writes one line per move, `1. 炮二平五 馬2进3`, into a file named
`xq_YYYY-MM-DD_HH-MM-SS.txt`. The file starts with a UTF-8 BOM — without it Windows Notepad guesses
a local encoding and the Chinese notation turns into mojibake.

Import **does not parse the notation**. Each token is matched against the notation generated for
every legal move in the position reached so far, and an equal one is that move. Notation is already
unique for a given position (same-file ambiguity is resolved by 前/中/后), so a match has to be that
move and a mismatch means the game does not reach this far. That also means the separator never had
to be pinned down: newlines, spaces, Chinese or Latin commas and semicolons all split tokens, and a
leading `1.`-style number is stripped, so a hand-typed line or something pasted from elsewhere reads
back fine.

The whole record is replayed into a temporary board first, and the current game is only swapped out
once every move replayed — an error halfway through never leaves the board in a half-replayed state.
After a successful import, if it is the computer's turn it starts thinking immediately, and if the
imported position is already finished it is scored immediately. Importing over a game in progress
asks for confirmation first (both the file and the paste path are gated).

Copy and paste use `navigator.clipboard`. The async clipboard API needs a secure context, which
`file://` does not always count as, and browsers often refuse reads, so each direction has a
fallback: writing falls back to `execCommand('copy')`, and when reading is refused the game focuses an
invisible input box, asks you to press `Ctrl+V`, and takes the text from the `paste` event.

## Scaling

The board has a minimum size of 314 × 348 pixels — the cell pitch bottoms out at 34 px, below
which the characters on the pieces go blurry. In narrower windows the board area gets scrollbars
rather than the board getting squashed.

The board is **not square**: 9 files × 10 ranks, plus the frame margins, comes to 9.24 ×
10.24 cell pitches, so `layout()` has to solve for cell pitch in each direction and take the
smaller. Treating it as square makes the board overflow sideways in a narrow window and leaves a
band of empty space above and below in a wide one. As the available space grows, the board takes
94% of the smaller side of the board area and scales up proportionally; piece radius, font size,
line width, selection ring, target dots and glows are all derived from that one cell pitch, so
board and pieces always scale together.

The `ResizeObserver` callback is debounced through one `requestAnimationFrame`, so dragging the
window relayouts once per frame. The canvas backing resolution follows `devicePixelRatio` (capped
at 2.5), so lines and text stay crisp on high-DPI screens.

## Theme

The sun/moon button at the right of the title bar switches between dark and light; the icon shows
what clicking will *turn into*.

Both palettes are just data: the interface uses CSS custom properties (`html[data-theme="light"]`
overrides a whole set of tokens), the board uses `PALETTES` at the top of `js/render.js`. Changing
theme re-bakes the cached layer and the piece sprites (`Renderer.setTheme`) — no re-measuring, no
change to canvas size. Colours involved in animation are stored in the palette as `r,g,b`
triples with alpha supplied by the animation curve, so switching theme does not touch a single
animation formula.

In light mode the board itself becomes pale maple, and three things follow: the dark rim on the
piece edges gets stronger (a drop shadow alone does not read as depth on a pale ground), the
river text flips to dark, and the win/lose light band's composite mode changes
from `lighter` to `source-over` — `lighter` blows out to pure white on a pale ground and the band
and particles become invisible. So the composite mode is itself a token.

If you have never picked a theme, it follows the system `prefers-color-scheme`; once picked it
stays put. The first frame does not flash dark: an inline script in `<head>` sets `data-theme`
before the stylesheet loads.

## Sound

There are no audio files. Every cue is built from oscillators and noise at the moment it needs to
sound, which is exactly what keeps the whole project a folder you can double-click — and it means
it sounds identical over `file://` and over http.

### One graph, built on the first click

Browsers refuse to start an `AudioContext` before a user gesture, so nothing exists until the
first `pointerdown` or `keydown` (both listeners sit on the capture phase, so by the time the
unlocking click reaches its own handler the context is already running). That one call builds the
whole permanent graph:

```
sources ─→ master gain ─→ destination
        └→ wet send ─→ convolver ─→ master gain
```

Two buffers are generated procedurally at that moment, because there is nothing to load:

- The **impulse response** is 1.4 seconds of stereo white noise multiplied by `(1 − t)^2.6`, with
  the right channel multiplied by 0.8. That is a decay curve, not a measurement of a real room —
  every cue gets a short soft tail without needing any reverb asset.
- The **noise buffer** is 0.25 seconds of white noise, reused by every move and capture.

Everything else is built per cue and disposed of after it plays.

### One primitive: `tone()`

Almost every cue has the same shape — an oscillator into a gain that ramps up in a few milliseconds
and falls back over the note's length, optionally sending a branch to the reverb. Exponential ramps
rather than linear ones, because loudness is perceived logarithmically; an exponential ramp cannot
reach 0, so the floor is `0.0001`. Scheduling always uses absolute `ctx.currentTime`, so the victory
arpeggio schedules a dozen oscillators in one call and returns immediately.

### The cues

| Cue | Recipe |
|---|---|
| Select | a light tap of bandpassed noise at 3200 Hz plus a 1180 Hz triangle, 50 ms |
| Move | noise through a bandpass, Red 1900 Hz / Black 1500 Hz, Q 1.1 — that is the "tock"; underneath, a 150 Hz sine thud and a 78 Hz triangle body — that is the piece landing on the board |
| Capture | a sharp 2600 Hz hit, then 45 ms later a duller 900 Hz one at Q 2.2; over that, a 210 Hz square and a 66 Hz triangle lasting 260 ms |
| Check | two rising square waves, 880 → 1320 Hz (0.12 s and 0.14 s), with a 196 Hz triangle underneath |
| Illegal | two square waves, 150 Hz then 112 Hz — square waves are the deliberately blunt, unpleasant timbre in this set |
| Undo | one triangle sliding from 700 Hz down to 280 Hz, 160 ms |
| Win | an ascent from D5 to D6 — 587–659–784–880–1047–1175 Hz, one step every 110 ms, each step a triangle plus a sine an octave up, with a 1.5 s held D4 underneath and an A4 entering after half a second |
| Lose | A4–G4–E♭4–A♭3, one step every 170 ms, sine waves, with a 110 Hz triangle underneath |
| Draw | two 392 Hz sine waves, 240 ms apart |

The "tock" of a move shifts frequency ±6% each time, and the thud ±5%, so ten moves in a row do
not sound like one sample looped ten times. Red and Black are tuned to different brightness, so
you can tell which side moved without looking at the board.

### Volume and muting

Master gain is `volume^1.6 × 0.9` rather than the slider's raw value: that exponent is a rough
perceptual curve, so the slider sitting in the middle is a sensible loudness rather than nearly
inaudible. Muting both sets master gain to 0 and makes every cue bail out at its `ready` check —
the context has to exist, be enabled, and actually be running — so no audio nodes are created at
all while muted. The same check covers "a cue fired before the first gesture": dropped silently,
no error.

## Files

```
index.html        layout and the right-hand panel; scripts load at the bottom in dependency order
css/style.css     theme tokens, responsive layout, stamp and banner animations
js/rules.js       the 9×10 position, move generation and legality, check / mate / stalemate / repetition, FEN for the engine
js/notation.js    Chinese notation (炮二平五 / 前马进七)
js/render.js      Canvas drawing and animation, including both PALETTES
js/sound.js       Web Audio synthesized sound
engine/           Pikafish-HCE compiled to single-threaded WASM, its base64 inline blob, and the build scripts
js/engine.js      engine adapter: instantiation, UCI handshake, layer-by-layer go, ICCS decoding
js/ai.js          engine host: one think at a time, cancellation and token checks
js/main.js        state machine and UI events
js/search.js      the JS search that was here before the WASM engine (iterative-deepening alpha-beta +
                  quiescence + transposition table + null move + pattern eval). Still in the repo, but
                  index.html no longer loads it
```

The scripts share global scope (there is no `import`/`export`), so the load order in `index.html`
matters: `rules → notation → render → sound → engine → ai → main`. Shared scope also means
top-level names must not collide across files — a collision is a SyntaxError, not a warning.

Only preferences (theme, difficulty, side, mute, volume) go into `localStorage`, under the key
`xiangqi.prefs`. Some browsers restrict `localStorage` on `file://`, so reads and writes are
wrapped in `try/catch`: if it cannot be stored, preferences just last for the session.

The interface is Chinese only — there is no localisation layer.

## License

GPL-3.0, see [LICENSE](LICENSE).

`engine/` bundles a compiled build of [Pikafish-HCE](https://github.com/skystarspython/Pikafish-HCE),
which is GPL-3.0-or-later, and a compiled build carries its source's license — so the whole
project is GPL rather than just that folder. Provenance and the rebuild steps are in
[engine/README.md](engine/README.md).

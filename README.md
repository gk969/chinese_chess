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

## How to play

- Click one of your pieces and the board marks every square it can legally reach right now
  (a filled dot is an empty square, a ring around a piece is a capture). Click a target to
  move there. Hovering shows a translucent preview.
- Clicking a different one of your pieces just reselects it, with no error; clicking
  somewhere unreachable clears the selection and says so.
- The right-hand panel switches difficulty (Low / Medium / High) and whether you play Red
  (first move) or Black (second).
- Undo takes back one of your moves and one of the opponent's. Restart is always available,
  and you can undo after a win or a loss to carry on playing.
- Changing sides starts a new game. Difficulty can be changed mid-game; if the computer is
  thinking, it immediately restarts its search at the new level.
- The move list uses Chinese notation (炮二平五 / 砲2进7) and highlights the latest move. Below it,
  four buttons export the game to a txt file, import one back, or copy the record to the system
  clipboard and restore it from there.

## The three difficulty levels

| Level | Search | Root candidates | Inner candidates | Quiescence | Behaviour |
|---|---|---|---|---|---|
| Low | 2 ply | 10 | 12 | off | 35% of the time ignores the search entirely and plays a random legal move |
| Medium | iterative deepening to 7 ply | 24 | 24 | 4 ply | picks at random among moves within 25 points of the best |
| High | iterative deepening to 12 ply | 40 | 32 | 6 ply | no randomness, at most about 2.5 s per move |

All three levels run the same pipeline; the profile only changes how deep it goes, how much
of the machinery is switched on, and how much randomness is mixed in at the end.

### Scoring a position

Material plus a piece-square table, and nothing else — no mobility term, no king-safety term:

| Piece | Value |
|---|---|
| Chariot (車) | 900 |
| Cannon (炮) | 470 |
| Horse (馬) | 420 |
| Elephant (相) | 220 |
| Advisor (仕) | 200 |
| Soldier (兵 / 卒) | 100 |
| General (將 / 帥) | not scored |

Leaving the generals unscored is deliberate: they are always on the board, so scoring them
would only add a constant to both sides. King safety is handled by the search instead —
hanging the general is blocked at the root by the legal-move filter, and deeper in the tree
by the "capture the general and you win" score.

The piece-square tables are written from Red's point of view as 10 rows × 9 columns, and
flipped vertically when looked up for Black. Bonuses sit on top of the material value, so a
soldier's worth changes continuously with where it is: barely anything before it crosses the
river, rising as it pushes toward the centre afterwards, worth over a hundred points more at
its best square than at its worst. That is what makes the engine willing to advance soldiers.

### The search

Negamax with alpha-beta pruning, iterating by depth: 1 ply, 2 ply, 3 ply … up to the
profile's depth cap or until the time budget runs out. When a depth does not finish, the
previous depth's conclusion is kept as-is, so the depth reported is always one that actually
**completed**.

The search runs on **pseudo-legal moves** and returns a win when it captures the opponent's
general. That saves the "make the move, then check whether my own general is attacked" pass at
every node, and self-destructive moves knock themselves out on score alone. Only the root
uses the full legal move list — the score sheet and the interface must never show an
illegal move.

Four things make the depth affordable:

- **Transposition table** — 262,144 direct-mapped slots keyed by a Zobrist hash split into
  two 32-bit integers. A slot only counts if both halves match, and a collision just
  overwrites it. Score, depth and "exact or bound" are packed into one `Int32Array`; the best
  move goes in another. The table is not cleared between games — a generation counter is
  incremented instead, so stale entries expire on generation mismatch.
- **Move ordering** — every node searches the move recorded in the table first, then captures
  (ordered by victim value minus attacker value), then two killer moves, then the history
  table. Most of alpha-beta's pruning comes from that order.
- **Null move** — when not in check, at depth 3 or more, and the static score already clears
  beta, the engine lets the opponent move once and searches again. If it still clears beta,
  the position was good enough that it did not need a careful count. Null move saves far more
  depth than the errors it costs.
- **Late-move reductions** — when not in check, moves that sorted badly and are neither captures
  nor the move recorded in the table get searched one or two plies shallower first, and only get a
  full-depth re-search if they beat alpha. Once the ordering is trustworthy this costs almost no
  strength.

Wins are scored `30000 − ply`, so mate in three beats mate in seven and the engine will not
shuffle around in a position it has already won. Before a win score is stored in the table it
is shifted back by the depth, otherwise the same position reached along two paths would carry
two different scores because the ply differs.

### Quiescence and being in check

Xiangqi is dense with capture tactics, and scoring at the leaves outright would let the engine
"see the capture but not the recapture", so leaves enter a quiescence search: only captures,
ordered by victim value, until nothing obviously profitable is left. A delta prune sits on top
— if the static score plus the victim's value plus 150 still does not reach alpha, that move
is skipped.

**Positions in check have to be handled separately**, and this is where a xiangqi engine most
easily runs away: when in check, "only search captures" is wrong — every evasion has to be
searched, and there are routinely twenty or thirty of them. Give them the same depth and a
single ply explodes to fifty million nodes. Measured at depth 4: of 50 million nodes in that
ply, 41.6 million were inside check evasions, while the main search itself visited 541 nodes.

The fix is a budget of just 2 for *consecutive* check evasions: past that the search falls back
to the static score and stops counting. Node count for the same ply drops from 50 million to
56,807. This is safe because the main search has its own depth and will not genuinely miss that
check; the budget only caps the endless "evade, then trade captures" branch. Evasion moves are
ordered with the table move first as well.

### What each level actually runs

| | Low | Medium | High |
|---|---|---|---|
| Depth cap (ply) | 2 | 7 | 12 |
| Root candidates | 10 | 24 | 40 |
| Candidates per inner node | 12 | 24 | 32 |
| Quiescence depth | 0 | 4 | 6 |
| Time budget | 120 ms | 700 ms | 2500 ms |
| Transposition table | off | on | on |
| Null move / late reductions | unreachable | on | on |
| Blunder probability | 35% | — | — |
| Random range | 80 points | 25 points | off |

Null move and late-move reductions are not in the profile table — they only apply at depth 3
or more, so the 2-ply Low level simply never reaches them and needs no separate switch.

What actually makes Low *low* is the last two rows. After the search finishes the engine rolls
the 35% first: if it lands, the search result is discarded entirely and a move is picked
uniformly from the legal moves — which is why Low hands pieces over. Otherwise it keeps every
root move within `random range` points of the best and picks one of those at random. High's
range is 0, so the pool holds only the best move and High is deterministic. Medium's 25 points
means it plays moves that are "just as good" rather than the same move every game.

The depth cap is a cap, not a guarantee. Measured from the opening: Low 2 ply / 72 nodes;
Medium 7 ply / 150k nodes / 0.14 s; High 7 ply / 2.76M nodes / 2.5 s / roughly 1.1M nodes per
second. High's 12-ply cap is out of reach in the opening and only gets touched in endgames with
few pieces — its job is to not put a ceiling on those.

### Keeping the interface responsive

The search runs on the main thread but yields to the event loop roughly every 40 ms (through a
MessageChannel, to dodge `setTimeout`'s 4 ms floor), so the interface stays responsive and
animations keep running while the computer thinks.

When interrupted, it throws a sentinel out and rewinds the position to the root. **The root's
move loop has to be resumable**: one ply often spans several slices, and if every slice restarted
from the root's first move, alpha would never accumulate and the whole 2.5 seconds would go into
re-searching the same ply. So the root is split into begin / step / commit, and each slice picks
up at the move it stopped on. Pending null moves have to be unwound cleanly on the way back too —
they never enter the history, so a separate counter keeps track of them.

Undo, restart and a difficulty change increment a token and set a cancel flag: a running search
exits at its next yield point, and the callback is only accepted if the token is unchanged — so
starting a new game while the computer is thinking does not drop a ghost piece.

While the computer thinks, the two lines under the status message refresh every 200 ms: the upper
one carries the completed depth and the elapsed time, the lower one the positions searched, e.g.
`电脑 · 6 层 · 1.4 秒` / `1,234,567 个局面`. Once the move lands the same two lines become the
verdict for it, e.g. `电脑 · 7 层 · 2.50 秒` / `2,809,856 个局面`. Both report the last depth that
**completed**, so a readout stuck at 6 ply next to a result of 7 ply is normal.

Both lines have a fixed height and hold their space even when empty, and neither wraps (an
overflowing line is truncated). Thinking and finished therefore occupy exactly the same height, so
the readout appearing or vanishing never shoves the rest of the rail up and down. The refresh runs
on a `setTimeout` chain rather than `requestAnimationFrame` — rAF is frozen in background tabs, and
the search is holding the main thread anyway, so rAF would not get scheduled.

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
js/rules.js       the 9×10 position, move generation and legality, check / mate / stalemate / repetition
js/notation.js    Chinese notation (炮二平五 / 前马进七)
js/render.js      Canvas drawing and animation, including both PALETTES
js/sound.js       Web Audio synthesized sound
js/search.js      search: iterative-deepening alpha-beta + quiescence + transposition table + null move
js/ai.js          search host: queueing and cancellation
js/main.js        state machine and UI events
```

The scripts share global scope (there is no `import`/`export`), so the load order in `index.html`
matters: `rules → notation → render → sound → search → ai → main`. Shared scope also means
top-level names must not collide across files — a collision is a SyntaxError, not a warning.

Only preferences (theme, difficulty, side, mute, volume) go into `localStorage`, under the key
`xiangqi.prefs`. Some browsers restrict `localStorage` on `file://`, so reads and writes are
wrapped in `try/catch`: if it cannot be stored, preferences just last for the session.

The interface is Chinese only — there is no localisation layer.

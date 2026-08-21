# Hexlands

A turn-based hex strategy web game inspired by [Antiyoy](https://github.com/yiotro/Antiyoy).
Pure HTML/CSS/JavaScript — no build step, no dependencies.

## Run it

Open `index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## How to play

You are **blue**. Win by destroying every enemy province or by **domination**
— controlling 65% of the island (60% in duel mode). Duels additionally end
after round 60, with the larger realm taking the match (equal tiles is a
draw).

Two modes:

- **Free-for-all** — you against 1–5 AIs with random playstyles on a random
  map.
- **Duel** — the competitive format: you against a single Balanced AI on a
  fixed, mirror-symmetric map (both starts are exact 180° twins) with zero
  randomness. Tree growth and every AI decision run off a seeded generator
  stored in the game state, so identical play always produces an identical
  game — openings and strategies can be developed like chess lines. Undo
  preserves the random stream, so it can't be used to reroll outcomes.
  At the exact centre of the map stands **the Throne**: +4 income while
  held, and holding it for 20 consecutive rounds wins the duel outright.
  It has no defence of its own, so the crown clock (shown in the top bar)
  forces both sides to fight for the middle.

- **Provinces** are connected groups of 2+ tiles of one colour. Each province has
  its own treasury, shown above its capital — a small walled town flying
  the owner's banner.
- **Terrain**: plains earn 1 coin per round, meadows earn 2, hills earn 0 —
  but towers built on hills defend one level higher (a hill fort defends
  at 4). Farms cannot be built on hills. Starting provinces are always
  plains.
- **Income**: a farm adds 4 per farm level on top of terrain income — 6 per
  level on meadows, so a level-3 meadow farm earns 20 a round (2 base + 18).
  Tiles covered by trees or gravestones earn nothing.
- **Farms and towers change hands**: capturing a farm or tower tile takes
  the building over intact, level and all. Units may stand on farms and
  towers as garrisons — the tile defends at whichever is higher, building
  or unit, and a unit on its own tower gets the tower's +1 boost — but if
  the tile is captured, the garrison dies with it. Capitals are still
  razed on capture.
- **Landmarks** (map objectives; nothing can be built on them, trees avoid
  them, and duel maps mirror them): **mines** pay +3 income to whoever holds
  them and prefer hills; **villages** yield a one-time +12 plunder to their
  first captor, then burn; **ancient forts** defend their tile and
  neighbours at level 2 while held — permanent strongpoints that survive
  capture.
- **Units** (levels 1–4) cost 10 coins and upkeep of 2 / 6 / 18 / 36 per round.
  If a province's treasury goes negative, all of its units starve.
- **Movement**: a unit moves up to its level in tiles per turn (peasant 1,
  spearman 2, knight 3, baron 4), walking through friendly territory only;
  a capture spends the final step. Occupied tiles can be passed through but
  not landed on. Freshly bought units may be placed anywhere in the
  province (or capture a tile adjacent to it).
- **Combat**: a unit captures an adjacent tile only if its effective level is
  *strictly higher* than the tile's defence — equal defence always blocks,
  even for level 4. Units, towers (def 2), forts (def 3) and capitals (def 1)
  defend their own tile *and* all six neighbours.
- **Tower ladder**: towers upgrade through four tiers, each with its own look:

  | Tier | Upgrade cost | Total | Defence | Aura range |
  |---|---|---|---|---|
  | Watchtower | 15 | 15 | 2 | 1 |
  | Fort | +30 | 45 | 3 | 1 |
  | Castle | +45 | 90 | 4 | 2 |
  | Citadel | +60 | 150 | 4 | 3 |

  Hills add +1 defence, but structure defence is hard-capped at 4 so that a
  tower-boosted baron (effective 5) can always break any fortification.
- **Tower aura**: friendly units inside a tower's aura fight at +1 effective
  level (gold ring and +1 badge). The boost is positional — it applies to
  attacks launched from that spot and to defence while standing there.
  Selecting a province shows its aura tiles in gold.
- **Upgrades**: with the Tower or Farm button armed, click an existing
  building (gold outline) to upgrade it. Farms level up to 3 (+4 income per
  level, +6 on meadows, costing 20 then 30).
- **Selling**: the Sell button sells a unit, tower or farm for 75% of its
  invested cost (orange outline marks sellable assets). Capitals cannot be
  sold. The AI also downsizes its army rather than letting a province go
  bankrupt.
- **Doctrines**: on rounds 5, 15 and 25 each player adopts one permanent
  empire edict from a shared pool of eight — Agriculture (farms +1/level),
  Prospecting (mines +2, hills +1), Banking (+1 per 25 banked, max +4),
  Conscription (units cost 8), Field Discipline (+1 movement), Siegecraft
  (enemy structure defence −1), Masonry (towers −25%), Militia (capitals
  defend at 2 and grant the +1 aura). Picks are free choices from the full
  list (no card luck), public, and shown beside each player's name; AI
  playstyles follow fixed priorities, so duel opponents are bookable.
- **Merging**: move a unit onto a friendly unit to combine their levels
  (max 4). Buying a unit onto an existing one upgrades it by one level.
- **Trees** spread every round and block income. Moving a unit onto a tree
  chops it for 1 coin (and ends that unit's turn).
- **Difficulty** (Easy / Normal / Hard / Hexed) controls how competently the
  AI plays — how often its units act, how well it picks targets, whether it
  merges units, and how freely it spends. It never cheats on resources.
  **Hexed** adds planning on top of Hard's perfect execution — frontier-aware
  expansion (tuned by AI-vs-AI tournament), captures aimed at articulation
  tiles that split your provinces, garrisons on the tiles you could actually
  capture, and army escalation: once the war front dominates its border —
  or the moment you field a level-2 unit — it merges and upgrades units
  into spearmen, knights and barons instead of spamming peasants, and
  walls its threatened frontier with towers, so defensive lines only buy
  you time. Like every
  difficulty, it never cheats on resources: beating it is purely a matter of
  outplaying it.
- **Playstyles**: each AI is dealt a personality, shown beside its name —
  ⚔️ Warlord (attacks relentlessly), 🌾 Builder (farms and expands),
  🛡️ Turtle (fortifies), ⚖️ Balanced.
- **Splitting**: capturing tiles can split an enemy province — the fragment
  that keeps the capital keeps the money; capturing a capital destroys its
  treasury outright.

Controls: click to select, drag to pan, scroll/pinch to zoom,
right-click or `Esc` to cancel, `Enter` to end the turn. Undo works for your
whole turn.

**Watching the enemy phase**: with *Watch AI moves* ticked on the start
screen (on by default, remembered across visits), ending your turn replays
the AI phase move by move — the camera glides to each action, a banner names
whoever is moving, and when the phase ends the view returns to exactly where
you left it. Click anywhere (or press `Esc`) to skip straight to the result.
The replay is purely visual: the turn is computed instantly up front and the
authoritative result is swapped in at the end, so skipping never changes the
outcome and duel-mode determinism is untouched.

Reading the board: hover any tile for its terrain, defence and contents; your
tiles the enemy could capture next turn always carry a dashed red outline;
tiles captured during the enemy phase pulse (red if they were yours); and a
red `!` beside a capital's treasury warns that the province goes bankrupt
next round.
Games auto-save to the browser after every action — the start screen offers
**Continue** when a saved game exists.

**Export / import**: the Export button (top bar) downloads the whole game as
a JSON file — complete board state plus a chronological log of every action
by every player (`history`: moves with capture/merge flags, purchases,
upgrades, sells, doctrine picks, each tagged with round and player). The
format is compact — tiles only list fields that differ from an empty tile,
and province tile lists are recomputed on load — so even late-game files
stay small enough to attach to a chat or bug report (older, verbose
version-1 files still import). Import
(top bar or start screen) restores such a file exactly, including duel-mode
determinism. The format is deliberately analysis-friendly: share a game for
review, or attach it to a bug/balance report. The game-over panel offers
Export too, and its *Review the Final Board* button dismisses the panel so
you can study the end position — the Results button in the top bar brings
the panel back.

## Code layout

| File | Responsibility |
|---|---|
| `js/hex.js` | Axial hex-grid math |
| `js/map.js` | Island generation and starting positions |
| `js/rules.js` | Game state, provinces, economy, combat, actions |
| `js/ai.js` | AI opponents |
| `js/render.js` | Canvas rendering and camera |
| `js/ui.js` | Input handling, selection state, HUD |
| `js/main.js` | Bootstrap and turn sequencing |

All rules go through the action functions in `rules.js` (`moveUnit`, `buyUnit`,
`buyTower`, `buyFarm`), which validate and return `{ ok, reason }` — the AI and
the UI use the exact same API, so new mechanics added there work for both.

### Deliberate simplifications vs. Antiyoy

- Only level-1 units can be bought; higher tiers come from merging.
- Diplomacy, colour-blind mode, map editor, and multiplayer are not implemented.

## Ideas for your own features

The engine is deliberately small to make extending easy. Some natural hooks:

- New structures or unit types: add a case in `rules.js` (cost/upkeep/defence),
  a draw function in `render.js`, and a button in `index.html`.
- Fog of war: filter what `render.js` draws by distance to friendly tiles.
- Map editor / seeds: `map.js` is self-contained.
- Save/load: `snapshotState` / `restoreState` in `rules.js` already serialise
  the full game to JSON.
- Smarter or harder AI: everything lives in `js/ai.js` — difficulties and
  playstyles are plain parameter tables (`AI_DIFFICULTIES`, `AI_STYLES`) at the
  top of the file, so tuning or adding a new personality is a few lines.

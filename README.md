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

You are **blue**. Destroy every enemy province to win.

- **Provinces** are connected groups of 2+ tiles of one colour. Each province has
  its own treasury, shown on its capital (★).
- **Income**: every tile earns 1 coin per round; a farm adds 4. Tiles covered by
  trees or gravestones earn nothing.
- **Units** (levels 1–4) cost 10 coins and upkeep of 2 / 6 / 18 / 36 per round.
  If a province's treasury goes negative, all of its units starve.
- **Combat**: a unit captures an adjacent tile if its level is higher than the
  tile's defence. Units, towers (def 2), forts (def 3) and capitals (def 1)
  defend their own tile *and* all six neighbours. Level 4 beats everything.
- **Merging**: move a unit onto a friendly unit to combine their levels
  (max 4). Buying a unit onto an existing one upgrades it by one level.
- **Trees** spread every round and block income. Moving a unit onto a tree
  chops it for 3 coins (and ends that unit's turn).
- **Difficulty** (Easy / Normal / Hard) controls how competently the AI plays —
  how often its units act, how well it picks targets, whether it merges units,
  and how freely it spends. It never cheats on resources.
- **Playstyles**: each AI is dealt a personality, shown beside its name —
  ⚔️ Warlord (attacks relentlessly), 🌾 Builder (farms and expands),
  🛡️ Turtle (fortifies), ⚖️ Balanced.
- **Splitting**: capturing tiles can split an enemy province — the fragment
  that keeps the capital keeps the money; capturing a capital destroys its
  treasury outright.

Controls: click to select, drag to pan, scroll/pinch to zoom,
right-click or `Esc` to cancel, `Enter` to end the turn. Undo works for your
whole turn.

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

- Units may reposition anywhere inside their own province in a single move
  (Antiyoy limits movement to 4 tiles).
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

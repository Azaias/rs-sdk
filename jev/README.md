# Jev harness

Lets [Jev](https://openrouter.ai/docs/guides/community/jev) (TypeSafe's System One
decision model, called through OpenRouter) play a bot.

```bash
bun jev/play.ts <bot> --goal "Train Woodcutting" --minutes 2
bun jev/play.ts <bot>                 # Jev picks its own activity, and a new one when done
bun jev/play.ts <bot> --dry-run       # one decision, prints the state + options, no actions
bun jev/play.ts <bot> --steps 10      # stop after N decisions
```

Needs `OPENROUTER_API_KEY` in the project-root `.env` (bun loads it automatically), and
the bot's game client open, as with any script. Optional: `JEV_MODEL` (default
`jev-1.13`, pinned; `jev-latest` follows new releases) and `JEV_BASE_URL`.

## How it works

Jev is not a chat model: it never writes text or code. It reads a `state` plus typed
questions and returns probabilities over answers *you* define. So the harness splits the
work:

| Code (`world.ts`, `play.ts`) | Jev (one request per step) |
| --- | --- |
| Lists every concrete action possible right now: NPC/loc/inventory options, ground items, bank/shop/dialog buttons, known places | **Choice**: which action best serves `goal`, given the state and `recent_actions` |
| Converts numbers into words (health, distance, how strong a monster is compared to you, how full the inventory is) | **Noul** (asked in the same request): is `goal` already met? Stops the run, or picks a new goal in auto mode |
| Runs the chosen action with `bot.*` and records what actually happened (XP, inventory change, failures) | **Choice** (auto mode only): which activity to do next |
| Hard rules: eat below 40% HP, even mid-action; bench an action that failed twice in a row for 5 steps; step aside and retry when a fire can't be lit | |

Each step costs ~1–2k input tokens (≈ $0.00005 on `jev-1.13`; output is free) and takes
~250 ms. Every step goes to `bots/<bot>/jev_runs/<timestamp>.jsonl` with the exact state,
options, answers, and outcome, so you can see why a decision went wrong.

Other players' chat is left out of the state on purpose: Jev treats all state as
trusted, so chat could steer it.

## Extending

- **New activity**: when `bot.*` already handles it, `locCandidates` / `npcCandidates`
  usually pick it up from the entity's option text. For multi-step skills (smithing,
  crafting), add a candidate in `inventoryCandidates` that only appears when you have
  what it needs, as the fire, fletch, and cook candidates do.
- **New place**: add it to `PLACES`, with an `about` saying what it's for and any danger.
- **New judgment**: add another question to the `jev.ask(...)` call in `play.ts`. Questions
  in one request are answered independently and cost almost nothing extra. Write the
  full question in `instructions` (question keys are never sent to the model), and keep
  arithmetic, counting, and level comparisons in code.
- **Tuning**: the thresholds (0.85 for "goal done", 40% HP) are first guesses. Tune them
  from the traces.

## Known limits (jev-1.13)

- Takes instructions literally, and is poor at numbers. "Reach level 35" relies on it
  comparing numbers, so prefer goals like "Train Woodcutting" with `--minutes`.
- Low confidence spread across "Walk to …" options usually means nothing useful is
  nearby. Check the trace and add a missing candidate or place.
- It sees only what `describe()` sends it. If a decision looks dumb, check whether the
  fact it needed was in the state.

Docs: [TypeSafe](https://docs.typesafe.ai/llms.txt) ·
[Jev on OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk) ·
[jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)

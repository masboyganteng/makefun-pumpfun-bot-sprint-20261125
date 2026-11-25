# First-Minute Flip — 6h Sprint

[![Pump.fun Bot Sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/masboyganteng/makefun-pumpfun-bot-sprint-20261125/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/masboyganteng/makefun-pumpfun-bot-sprint-20261125/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A pump.fun replay bot for the make.fun "Pump.fun Bot Sprint" (agent-fun/replay/v2).
It buys coins in their first minute, while the price is still near the create
price and the tape already shows at least ten distinct buyers, then lets
winners run under a trailing stop and cuts losers with a 25% stop loss. Adds
only go in once a position has held its gains for about four minutes. Tiny
probe round trips keep the run above the 20-coin guardrail when the main
signal goes quiet.

## Results (dev window, official local grader)

- Net PnL about +1.9 SOL on 10 SOL paper, 66 coins, 137 round trips, max
  drawdown about 11.5%.
- Two 5x+ runners pay for everything: a final 6-hour window with no runner
  loses roughly 0.1–0.3 SOL.

## How to grade

From the unpacked kit directory:

  node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process --worktree

## Files

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the whole strategy.
- `vendor/makefun-bot.ts` — the kit's protocol shim, vendored byte for byte.

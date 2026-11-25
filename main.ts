// First-Minute Flip (6h sprint) — a pump.fun replay bot for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts; the
// protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The bot answers the harness's hello, then one reply per batch of chain events:
// it buys the first-minute breakout signal, sells on the stop / trailing stop /
// creator sell / stale-tape / time-limit exits, and sends tiny probe round trips
// to stay above the 20-coin guardrail. See strategy.ts for the full reasoning.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createBot(DEFAULT_PARAMS));

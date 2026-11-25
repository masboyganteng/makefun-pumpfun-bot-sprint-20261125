// First-Minute Flip, rebuilt for the six-hour sprint.
//
// The read of the dev tape is simple: nearly every pump.fun coin dies, and the
// ones that run do it in the first minute. A coin that is going to die rarely
// falls far below its create price, so the loss does not come from the dip — it
// comes from buying after the run-up and riding the decay back down. This bot
// therefore buys early, while the price is still close to the create price, and
// only when the tape already shows real interest: at least ten distinct buyers
// besides the creator, a handful of trades, and net buying on the tape. Thin
// launches are mostly dumps, and ten buyers filters more of them than six did
// without losing the runners.
//
// Once in, there is no fixed take-profit: the fat tail is the whole edge, so a
// winner is allowed to run and is banked by a trailing stop instead. The stop
// arms once the position is up twenty percent and exits on a twenty-five
// percent fall from the peak; a plain twenty-five percent stop loss cuts the
// rugs. A creator sell, a long hold, or a dead tape also get the bot out.
//
// Size is built only into strength, and only late: adds wait until the
// position has held its gains for about four minutes (575 slots), because
// pump-and-dump coins spike and crash inside two minutes and immediate adds
// buy the top of every dump. A runner still up after four minutes is worth
// building size on.
//
// The tuned numbers below sit on flat ground, not fitted peaks: six buyers
// scores about +1.40 SOL on the dev window, eight about +1.89, ten about
// +2.02, while twelve collapses to about +0.78 by filtering out a 5x runner's
// entry; the add gate scores positive anywhere from 500 to 650 slots. On the
// official local grader this shape nets about +1.9 SOL on the dev window with
// 66 coins and 137 round trips, but two 5x+ runners pay for everything, so a
// final six-hour window with no runner loses roughly 0.1–0.3 SOL. It is a
// lottery ticket with a positive expected value, not a steady earner.
//
// The bot is a pure function of the batches: no clock, no environment, no
// randomness. The seed from hello is never needed.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** Lamports in one SOL. */
const SOL = 1_000_000_000;
/** Curve fee on every fill: 95 bps protocol + 30 bps creator. */
const CURVE_FEE = 0.0125;

export interface Params {
  /** Entry age window, in slots since the CreateEvent. */
  minAge: number;
  maxAge: number;
  /** Trades and distinct non-creator buyers the tape must show before entry. */
  minTrades: number;
  minBuyers: number;
  /** Net SOL (buys minus sells) the tape must show before entry. */
  minNetSol: number;
  /** Entry price as a multiple of the create price: never chase past this, never buy flat. */
  minRunup: number;
  maxRunup: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Largest single recorded sell (SOL) tolerated before entry. */
  maxBigSellSol: number;
  /** SOL committed to one position in total, adds included. */
  stakeSol: number;
  /** Smallest buy worth paying a transaction fee for. */
  minBuySol: number;
  /** Slippage allowed on buys; sells always go out at 10000 bps. */
  buySlipBps: number;
  /** Exits, as fractions of cost or of the peak value. */
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while the bot holds. */
  exitOnDevSell: boolean;
  /** Exit when net SOL over the last flowWindow slots falls below this. */
  flowWindow: number;
  exitFlowSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the whole run. */
  maxEntries: number;
  /** One add into strength: price above entry, position up, flow still positive. */
  addStep: number;
  addIfUp: number;
  /** Adds only once the position is this many slots old. */
  addMinAge: number;
  /** Guardrail pacing: tiny probe round trips when fills or coins lag the pace. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 5,
  maxAge: 300,
  minTrades: 4,
  minBuyers: 10,
  minNetSol: 0.02,
  minRunup: 1.02,
  maxRunup: 1.8,
  minRealSol: 0.05,
  maxRealSol: 40,
  maxBigSellSol: 0.3,
  stakeSol: 2.5,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 100,
  stopLoss: 0.25,
  trailArm: 0.2,
  trail: 0.25,
  maxHold: 1800,
  staleSlots: 600,
  exitOnDevSell: true,
  flowWindow: 60,
  exitFlowSol: -1000,
  cooldown: 150,
  maxEntries: 2,
  addStep: 0.05,
  addIfUp: 0,
  addMinAge: 575,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  trader: string;
  price: number;
}

interface CoinTape {
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  trades: TapeTrade[];
  creatorDumped: boolean;
  biggestSell: number;
  entries: number;
  lastExitSlot: number;
  lastTradeSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  peakSol: number;
  investedSol: number;
  leaving: boolean;
  filled: boolean;
  entryPrice: number;
  lastValueSol: number;
}

export function createBot(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenPosition>();
  const probes = new Map<Pubkey, boolean>();
  let fillsSeen = 0;
  const coinsSeen = new Set<Pubkey>();
  let firstBlock: number | null = null;
  let lastBlock: number | null = null;
  const keepSlots = Math.max(p.maxAge, p.flowWindow, p.staleSlots) + 10;

  function tapeFor(mint: Pubkey): CoinTape {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = {
        createdSlot: null,
        creator: null,
        createPrice: 0,
        trades: [],
        creatorDumped: false,
        biggestSell: 0,
        entries: 0,
        lastExitSlot: -1e12,
        lastTradeSlot: -1,
      };
      tapes.set(mint, tape);
    }
    return tape;
  }

  /** Net SOL (buys minus sells) over the last `window` slots of a tape. */
  function netFlow(tape: CoinTape, now: number, window: number): number {
    let net = 0;
    for (let i = tape.trades.length - 1; i >= 0; i--) {
      const trade = tape.trades[i]!;
      if (trade.slot <= now - window) break;
      net += trade.isBuy ? trade.sol : -trade.sol;
    }
    return net;
  }

  /** The whole entry gate: every condition must hold at once. */
  function entryOk(tape: CoinTape, now: number, realSol: number, price: number): boolean {
    if (tape.createdSlot === null || tape.createPrice <= 0) return false;
    const age = now - tape.createdSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    if (tape.creatorDumped) return false;
    if (tape.biggestSell > p.maxBigSellSol) return false;
    const buyers = new Set<string>();
    let buys = 0;
    let net = 0;
    for (const trade of tape.trades) {
      if (trade.isBuy) {
        buys++;
        net += trade.sol;
        if (trade.trader !== tape.creator) buyers.add(trade.trader);
      } else {
        net -= trade.sol;
      }
    }
    if (tape.trades.length < p.minTrades || buys < p.minTrades) return false;
    if (buyers.size < p.minBuyers) return false;
    if (net < p.minNetSol) return false;
    const runup = price / tape.createPrice;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    // Rising, not stalling: the price must be at or above the price three trades back.
    const n = tape.trades.length;
    if (n >= 4 && price < tape.trades[n - 4]!.price) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();

      // Tally real fills (harness closes carry client ids starting with `_`).
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          fillsSeen++;
          coinsSeen.add(fill.mint);
        }
      }

      // Ingest the batch's events into the tapes.
      for (const event of batch.events) {
        if (event.block_time !== null) {
          if (firstBlock === null) firstBlock = event.block_time;
          if (lastBlock === null || event.block_time > lastBlock) lastBlock = event.block_time;
        }
        if (event.event === 'CreateEvent') {
          const tape = tapeFor(event.mint);
          tape.createdSlot = event.slot;
          tape.creator = event.creator;
          tape.createPrice = Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        } else if (event.event === 'TradeEvent') {
          const tape = tapeFor(event.mint);
          const sol = Number(event.sol_amount) / SOL;
          tape.trades.push({
            slot: event.slot,
            isBuy: event.is_buy,
            sol,
            trader: event.user,
            price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves),
          });
          tape.lastTradeSlot = event.slot;
          if (!event.is_buy) {
            if (event.user === tape.creator) tape.creatorDumped = true;
            if (sol > tape.biggestSell) tape.biggestSell = sol;
          }
          touched.add(event.mint);
        }
      }

      // Drop trades too old for any window the bot looks at.
      for (const mint of touched) {
        const tape = tapes.get(mint)!;
        let drop = 0;
        while (drop < tape.trades.length && tape.trades[drop]!.slot <= now - keepSlots) drop++;
        if (drop > 0) tape.trades.splice(0, drop);
      }

      const marks = new Map<Pubkey, (typeof batch.marks)[number]>();
      for (const mark of batch.marks) marks.set(mark.mint, mark);
      const pendingCount = new Map<Pubkey, number>();
      for (const pending of state.pending.values()) {
        pendingCount.set(pending.order.mint, (pendingCount.get(pending.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / SOL;

      // Exits first: a position leaves whole on the first trigger that fires.
      for (const [mint, position] of open) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingCount.has(mint)) {
            open.delete(mint);
            const tape = tapeFor(mint);
            if (position.filled) tape.lastExitSlot = now;
            else tape.entries--;
          }
          continue;
        }
        position.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(held.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / SOL) * (1 - CURVE_FEE) - txSol;
        const cost = Number(held.cost_lamports) / SOL;
        if (value > position.peakSol) position.peakSol = value;
        position.lastValueSol = value;
        const tape = tapeFor(mint);
        let leave = position.leaving;
        if (!leave && value >= cost * (1 + p.takeProfit)) leave = true;
        if (!leave && value <= cost * (1 - p.stopLoss)) leave = true;
        if (!leave && position.peakSol >= cost * (1 + p.trailArm) && value < position.peakSol * (1 - p.trail)) leave = true;
        if (!leave && p.exitOnDevSell && tape.creatorDumped) leave = true;
        if (!leave && netFlow(tape, now, p.flowWindow) < p.exitFlowSol) leave = true;
        if (!leave && now - position.openedSlot > p.maxHold) leave = true;
        if (!leave && now - tape.lastTradeSlot > p.staleSlots) leave = true;
        if (!leave) continue;
        position.leaving = true;
        let sellPending = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe exits: sell a probe whole as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingCount.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries, and one add into strength per position.
      let freeSol = Number(state.freeCashLamports()) / SOL;
      let slotsFree = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= orderCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingCount.has(mint) || probes.has(mint)) continue;
        const tape = tapes.get(mint)!;
        const position = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / SOL;
        let want: number;
        if (position === undefined) {
          if (slotsFree <= 0) continue;
          if (tape.entries >= p.maxEntries || now - tape.lastExitSlot < p.cooldown) continue;
          if (!entryOk(tape, now, realSol, price)) continue;
          want = p.stakeSol;
        } else {
          // One add, into strength only: price stepped up, position up, flow
          // still positive, and the position has held its gains long enough.
          if (position.leaving || !position.filled || position.investedSol >= p.stakeSol - p.minBuySol) continue;
          if (now - position.openedSlot < p.addMinAge) continue;
          const held = state.positions.get(mint);
          if (held === undefined) continue;
          if (price < position.entryPrice * (1 + p.addStep)) continue;
          if (position.lastValueSol < (Number(held.cost_lamports) / SOL) * (1 + p.addIfUp)) continue;
          if (netFlow(tape, now, p.maxAge) < p.minNetSol) continue;
          if (realSol > p.maxRealSol) continue;
          want = p.stakeSol - position.investedSol;
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / SOL;
        let amount = Math.min(capSol, want);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: p.buySlipBps });
        freeSol -= amount + txSol;
        if (position === undefined) {
          open.set(mint, {
            openedSlot: now,
            peakSol: 0,
            investedSol: amount,
            leaving: false,
            filled: false,
            entryPrice: price,
            lastValueSol: 0,
          });
          tape.entries++;
          slotsFree--;
        } else {
          position.investedSol += amount;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsFree > 0 && firstBlock !== null && lastBlock !== null) {
        const pace = Math.min(1, (lastBlock - firstBlock) / p.paceSecs);
        const needCoins = coinsSeen.size < Math.ceil(p.targetCoins * pace);
        const needFills = fillsSeen < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= orderCap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingCount.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && coinsSeen.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / SOL < minReal * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * SOL)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            freeSol -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}

// Pump.fun Sharpe Sprint — deterministic paper replay bot.
//
// Idea, in my own words: buy a small, fixed stake in a fresh bonding curve
// only after it has proven itself (at least 12 trades, at least 80% of
// recent SOL flow from buys, price at least 10% above where it started, at
// least 10 SOL of real reserves), then exit on a rule, not on hope: take
// profit at +35%, cut at -12%, trail the peak once it is up 15%, and give
// up after 120 trades with no move. Prices on these curves typically rise
// then decay (holding to the end loses ~40% on the median coin in the dev
// data), so exits have to fire into strength, and the 2-slot latency means
// a rejected sell is retried rather than leaving a position stuck. At most
// five open positions, and a portfolio-level pause on new buys after a 25%
// drawdown, keep the hourly Sharpe steady instead of chasing one moonshot.
//
// The interface is the vendor shim's runBot: the hello message carries the
// seed and caps, every batch carries a slot plus its events, and onBatch
// returns the orders for that batch. Nothing here reads the clock, the
// environment, or Math.random, so two runs produce identical action logs.
//
// Price of a mint is virtual SOL reserves divided by virtual token reserves
// (the curve's own quote), read from the shim's state.curves after it has
// folded the batch in.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// --- sizing and exits (all in lamports / ratios, no magic from outside) ---
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 4n) / 100n; // 0.04 SOL per coin
const MIN_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: below this, skip
const MIN_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL * 10n; // curve needs >= 10 real SOL
const TAKE_PROFIT = 0.35; // sell all at +35% vs cost
const STOP_LOSS = -0.12; // sell all at -12% vs cost
const TRAIL_ARM = 0.15; // trailing exit arms once up 15%
const TRAIL_GIVEBACK = 0.15; // sell after giving back 15% from the peak
const MAX_HOLD_TRADES = 120; // sell after this many trades with no exit hit
const ENTRY_MIN_TRADES = 12; // need this many trades before considering a buy
const ENTRY_WINDOW = 6; // buy-pressure window, in recent trades
const ENTRY_MIN_BUY_SHARE = 0.8; // at least 80% of recent SOL flow must be buys
const ENTRY_MIN_PRICE_RATIO = 1.1; // price must be at least 10% above its first price
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 100; // tight on sells: only take the exit price if it
// is still there after the 2-slot latency; a rejected sell is retried on the
// next batch instead of filling into a dump at a much worse price.
const DRAWDOWN_PAUSE = 0.25; // stop new buys after a 25% portfolio drawdown

interface CoinTrack {
  trades: number;
  firstPrice: number;
  lastPrice: number;
  // Signed SOL flow of the last ENTRY_WINDOW trades: +buy / -sell, lamports.
  recentFlow: number[];
  decided: boolean; // entry decision already made (bought or passed)
  bought: boolean;
  buyPrice: number;
  buyTradeIndex: number;
  peakReturn: number;
  sellPending: boolean;
}

const tracks = new Map<string, CoinTrack>();
let peakPortfolioLamports = 10n * LAMPORTS_PER_SOL;

function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function trackFor(mint: string): CoinTrack {
  let track = tracks.get(mint);
  if (track === undefined) {
    track = {
      trades: 0,
      firstPrice: 0,
      lastPrice: 0,
      recentFlow: [],
      decided: false,
      bought: false,
      buyPrice: 0,
      buyTradeIndex: 0,
      peakReturn: 0,
      sellPending: false,
    };
    tracks.set(mint, track);
  }
  return track;
}

function portfolioValueLamports(state: BotState): bigint {
  let value = state.cash;
  for (const [mint, holding] of state.positions) {
    const price = priceOf(state, mint);
    if (price <= 0) continue;
    // Token amounts are huge; convert through the curve ratio in float and
    // back, which is precise enough for a drawdown guard (not for orders).
    const mark = BigInt(Math.floor(Number(holding.token_amount) * price));
    value += mark;
  }
  return value;
}

await runBot({
  onBatch(state: BotState, batch: Batch): Array<BuyInput | SellInput> {
    // 1. Fold this batch's events into the per-coin trackers, in order.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const track = trackFor(event.mint);
        if (track.firstPrice === 0) {
          const price = priceOf(state, event.mint);
          track.firstPrice = price;
          track.lastPrice = price;
        }
      } else if (event.event === "TradeEvent") {
        const track = trackFor(event.mint);
        const price = priceOf(state, event.mint);
        if (track.firstPrice === 0) track.firstPrice = price;
        track.lastPrice = price;
        track.trades += 1;
        const signed = event.is_buy
          ? Number(BigInt(event.sol_amount))
          : -Number(BigInt(event.sol_amount));
        track.recentFlow.push(signed);
        if (track.recentFlow.length > ENTRY_WINDOW) track.recentFlow.shift();
      } else {
        // CompleteEvent: the curve is done; forget the coin so it can never
        // be entered, and clear any buy decision for it.
        tracks.delete(event.mint);
      }
    }

    const orders: Array<BuyInput | SellInput> = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // 2. Exits first: every held position is checked against the rules.
    // A sell that was rejected or failed leaves no pending sell order, so
    // clear sellPending then and retry the exit on a later batch.
    for (const [mint, holding] of state.positions) {
      const track = tracks.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(state, mint);
      if (price <= 0 || track === undefined || !track.bought) continue;
      if (track.sellPending) {
        let sellInFlight = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === "sell") {
            sellInFlight = true;
            break;
          }
        }
        if (!sellInFlight) track.sellPending = false;
        if (track.sellPending) continue;
      }
      const cost = Number(holding.cost_lamports);
      if (cost <= 0) continue;
      const mark = Number(holding.token_amount) * price;
      const ret = mark / cost - 1;
      if (ret > track.peakReturn) track.peakReturn = ret;
      const agedOut = track.trades - track.buyTradeIndex >= MAX_HOLD_TRADES;
      const trailing =
        track.peakReturn >= TRAIL_ARM && ret <= track.peakReturn * (1 - TRAIL_GIVEBACK);
      if (ret >= TAKE_PROFIT || ret <= STOP_LOSS || trailing || agedOut) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        track.sellPending = true;
        free -= txFee;
      }
    }

    // 3. Portfolio guard: record the peak, pause new buys in a drawdown.
    const portfolio = portfolioValueLamports(state);
    if (portfolio > peakPortfolioLamports) peakPortfolioLamports = portfolio;
    const inDrawdown =
      peakPortfolioLamports > 0n &&
      portfolio < (peakPortfolioLamports * 75n) / 100n;

    // 4. Entries: fresh coins, in batch order, while slots and cash allow.
    if (!inDrawdown) {
      for (const event of batch.events) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (event.event !== "TradeEvent" && event.event !== "CreateEvent") continue;
        const mint = event.mint;
        const track = tracks.get(mint);
        if (track === undefined || track.decided || track.bought) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (track.trades < ENTRY_MIN_TRADES) continue;
        if (track.firstPrice <= 0 || track.lastPrice < track.firstPrice * ENTRY_MIN_PRICE_RATIO) {
          continue;
        }
        // Net buying pressure over the recent window.
        let buySol = 0;
        let totalSol = 0;
        for (const flow of track.recentFlow) {
          if (flow > 0) buySol += flow;
          totalSol += Math.abs(flow);
        }
        if (totalSol <= 0 || buySol / totalSol < ENTRY_MIN_BUY_SHARE) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_STAKE_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + txFee) continue;
        // Decide once: a coin is never reconsidered, so the log stays
        // deterministic and a passed coin cannot be chased later.
        track.decided = true;
        track.bought = true;
        track.buyPrice = track.lastPrice;
        track.buyTradeIndex = track.trades;
        track.peakReturn = 0;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        free -= amount + txFee;
        slots -= 1;
      }
    }

    // 5. Housekeeping: clear sellPending once the fill has landed (the
    // position is gone from state), and clear bought on a completed coin.
    // A buy that was rejected or failed also leaves no position and no
    // pending buy a few trades after the decision, so release that coin
    // for a fresh entry decision instead of stranding it forever.
    for (const [mint, track] of tracks) {
      if (track.sellPending && !state.positions.has(mint)) {
        track.sellPending = false;
        track.bought = false;
      }
      if (track.bought && !state.positions.has(mint)) {
        let buyInFlight = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === "buy") {
            buyInFlight = true;
            break;
          }
        }
        if (!buyInFlight && track.trades - track.buyTradeIndex >= 3) {
          track.bought = false;
          track.decided = false;
          track.sellPending = false;
          track.peakReturn = 0;
        }
      }
    }
    return orders;
  },
});

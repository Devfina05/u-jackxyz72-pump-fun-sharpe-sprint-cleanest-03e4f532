[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Devfina05/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Devfina05/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

A deterministic paper-trading bot for the make.fun bounty
[Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
It trades paper SOL on a 6-hour pump.fun forward replay and is ranked by
hourly Sharpe ratio — steady, controlled gains beat one lucky moonshot.

## Strategy

- **Early, filtered entry:** buy a fixed 0.04 SOL stake in a fresh bonding
  curve only after at least 6 trades, with at least half of recent SOL flow
  from buys, price still within 10% of its first price, and at least 3 SOL
  of real reserves (so the 1%-of-reserve size cap allows a real stake).
  Each coin is decided once, in batch order.
- **Rule-based exits:** take profit at +35%, stop loss at −12%, a trailing
  exit after giving back 15% from a peak of +15% or more, and a time exit
  after 120 trades with no move.
- **Risk limits:** at most 5 open positions, 10 SOL starting capital, and no
  new buys while the portfolio sits more than 25% below its peak.
- **Risk limits:** at most 5 open positions, 10 SOL starting capital, and no
  new buys while the portfolio sits more than 25% below its peak.
- **Deterministic:** no clock, environment, or `Math.random` — only the
  `hello` message (seed and caps) and each `batch` (slot and events) drive
  the `orders` returned, so two runs produce identical action logs.

## Layout

- `main.ts` — the whole strategy (Node 22, TypeScript run as-is).
- `vendor/makefun-bot.ts` — the kit's vendor SDK shim, copied unchanged.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

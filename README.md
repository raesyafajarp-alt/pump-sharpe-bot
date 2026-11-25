# pump-sharpe-bot

[![Pump.fun Sharpe Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/raesyafajarp-alt/pump-sharpe-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/raesyafajarp-alt/pump-sharpe-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition. It trades a 6-hour pump.fun replay on Node 22, ranked by hourly Sharpe ratio. Paper trading only — no real funds.

## Strategy

Two tiers, both momentum with a fixed take-profit / stop-loss against the all-in cost basis (blended across fills). Every parameter below was validated on the kit's full 24-hour dev dataset, not assumed.

- **Tier B — runners (the edge):** first touch of **8.0x** the creation price, **0.60 SOL**, TP **+40%** / SL **−30%**. A runner may also top up a mint already holding Tier A; the position upgrades to Tier B and its cost basis blends. On the dev window, resolved entries touch +40% before −30% about 89% of the time. Entering at 6x or 7x instead loses badly — the 8x trigger is where the edge lives.
- **Tier A — breadth (guardrail only):** first touch of **1.2x**, **0.01 SOL**, TP **+20%** / SL **−10%**, capped at **30 buys per run**. At 0.01 SOL the round-trip fees are ~4.6% and the 2-slot fill latency buys the top of a spike, so every trigger/TP/SL combination loses on its own (best −0.04 SOL over 24h). It exists only to clear the 20-distinct-mints bar at minimum cost.

At most 5 open positions, one slot kept free for Tier B, never a chase: Tier A fires only below 2.5x, Tier B only below 12x. Exits are full sells, never duplicated while one is already in flight. Fully deterministic — no clock, no environment, no randomness.

## Offline backtest (dev dataset, all 3 parts, 24h)

Run through a local port of the kit's replay engine (the pilot's `tools/sim.ts`):

| Metric | Result |
| --- | --- |
| Net PnL | **+2.017 SOL** (+20.2% on 10 SOL) |
| Hourly Sharpe | **0.276** |
| Max drawdown | 8.6% (limit 50%) |
| Round trips | 49 on 49 distinct mints (bar: 20) |
| Wins | 23 of 49 |
| PnL without top-3 coins | +1.163 SOL (edge is not 3 coins) |
| First 12h / second 12h | +1.317 / +0.700 SOL |
| Per-6h-block PnL | +0.20 / −0.00 / +0.22 / +0.90 SOL |
| Rejections / failed tx | 1 / 2 |

## Layout

- `main.ts` — entrypoint: `node /bot/main.ts`
- `strategy.ts` — the strategy (`createStrategy`, `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte

## License

MIT — see `LICENSE`.

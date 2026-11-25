// pump-sharpe-bot: two-tier momentum paper trader for the pump.fun replay (agent-fun/replay/v2).
//
// What the dev window actually says (validated on the kit's full 24h dev dataset):
//   - Tier B (runners) is the edge: first touch of 8.0x the creation price, 0.60 SOL.
//     Resolved entries touch +40% before -30% about 89% of the time, and the tier
//     alone is positive in 3 of the 4 six-hour blocks (+0.80 SOL over 24h on 19 trips).
//     A runner may also top up a mint already holding Tier A; the position upgrades
//     to Tier B and its cost basis blends.
//   - Tier A (breadth) has NO edge after fees: at 0.01 SOL the round-trip fees are
//     ~4.6% and the 2-slot fill latency buys the top of a spike, so every trigger /
//     TP / SL combination loses over 24h (best -0.04 SOL on 101 trips). It exists
//     only to clear the 20-distinct-mints guardrail, capped at 30 buys per run.
// At most 5 open positions, one slot kept free for Tier B, never a chase: Tier A only
// fires while the multiple is still below 2.5x, Tier B only below 12x. Exits are full
// sells, never duplicated while one is already in flight.
//
// Deterministic: no clock, no environment, no randomness; every decision comes from
// the batch the harness just delivered.

import { LAMPORTS_PER_SOL, type Bot, type BotState } from './vendor/makefun-bot.ts';

export interface StrategyParams {
  tierAMult: number;
  tierAMaxMult: number;
  tierASizeLamports: bigint;
  tierATp: number;
  tierASl: number;
  tierBMult: number;
  tierBMaxMult: number;
  tierBSizeLamports: bigint;
  tierBTp: number;
  tierBSl: number;
  /** Open-position slots Tier A may not use: kept free so a runner can always enter. */
  tierAReserveSlots: number;
  /** Tier A has no edge after fees on this data (win rate ~30%): it exists only
      to clear the 20-distinct-mints bar, so stop buying it after this many buys. */
  maxABuys: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  tierAMult: 1.2,
  tierAMaxMult: 2.5,
  tierASizeLamports: LAMPORTS_PER_SOL / 100n, // 0.01 SOL: the minimum counted round trip
  tierATp: 1.2,
  tierASl: 0.9,
  tierBMult: 8.0,
  tierBMaxMult: 12.0,
  tierBSizeLamports: (LAMPORTS_PER_SOL * 60n) / 100n, // 0.60 SOL
  tierBTp: 1.4,
  tierBSl: 0.7,
  tierAReserveSlots: 1,
  maxABuys: 30,
};

type Tier = 'A' | 'B';

interface Coin {
  /** Creation price (virtual SOL per virtual token) as a float. */
  p0: number;
  /** A Tier A buy was sent for this mint. */
  boughtA: boolean;
  /** A Tier B buy was sent for this mint. */
  boughtB: boolean;
  /** True once the multiple ran past the Tier A band without a buy. */
  aMissed: boolean;
  /** True once the multiple ran past the Tier B band without a buy. */
  bMissed: boolean;
  tier: Tier | null;
  /** Tokens held by our own ledger (buy fills minus sell fills). */
  tokens: bigint;
  /** Blended all-in SOL per token paid; null until the first buy fill lands. */
  costPerToken: number | null;
}

const priceOf = (state: BotState, mint: string): number | null => {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
};

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS): Bot {
  const coins = new Map<string, Coin>();
  let aBuys = 0;

  return {
    onBatch(state, batch) {
      const { caps } = state.hello;
      const tx = state.txFeeLamports();

      // 1. Fold in fills: blend the cost basis on buy fills, clear on full sells.
      for (const f of batch.fills) {
        const coin = coins.get(f.mint);
        if (coin === undefined) continue;
        const tokens = BigInt(f.token_amount);
        if (f.side === 'buy' && f.status === 'filled' && tokens > 0n) {
          const paid = Number(BigInt(f.quote_lamports));
          const unit = paid / Number(tokens);
          if (coin.costPerToken === null || coin.tokens === 0n) coin.costPerToken = unit;
          else {
            const oldTokens = Number(coin.tokens);
            coin.costPerToken = (oldTokens * coin.costPerToken + Number(tokens) * unit) / (oldTokens + Number(tokens));
          }
          coin.tokens += tokens;
        } else if (f.side === 'sell' && f.status === 'filled' && tokens > 0n) {
          coin.tokens -= tokens;
          if (coin.tokens <= 0n) {
            coin.tokens = 0n;
            coin.costPerToken = null;
            coin.tier = null;
          }
        }
      }

      // 2. Exits first: take-profit / stop-loss on every held position, full sell,
      //    never while a sell for that mint is already in flight.
      const sellPending = new Set<string>();
      for (const p of state.pending.values()) if (p.order.side === 'sell') sellPending.add(p.order.mint);
      const orders: { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number }[] = [];
      let free = state.freeCashLamports();
      for (const [mint, pos] of state.positions) {
        const coin = coins.get(mint);
        if (coin === undefined || coin.tier === null || sellPending.has(mint)) continue;
        const mark = priceOf(state, mint);
        if (mark === null) continue;
        if (coin.costPerToken === null) {
          // Fill not seen yet (should not happen): anchor the basis at the mark so
          // the next batch can judge the trade instead of holding it blind.
          coin.costPerToken = mark;
          continue;
        }
        const tp = coin.tier === 'A' ? params.tierATp : params.tierBTp;
        const sl = coin.tier === 'A' ? params.tierASl : params.tierBSl;
        if (mark >= tp * coin.costPerToken || mark <= sl * coin.costPerToken) {
          if (free < tx) continue;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          free -= tx;
        }
      }

      // 3. Entries: Tier B (runners) before Tier A (breadth), in batch event order.
      const buyPending = new Set<string>();
      for (const p of state.pending.values()) if (p.order.side === 'buy') buyPending.add(p.order.mint);
      const buys: { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }[] = [];
      const tryBuy = (mint: string, tier: Tier) => {
        const coin = coins.get(mint);
        if (coin === undefined || coin.p0 <= 0 || buyPending.has(mint)) return;
        if (tier === 'A' && (coin.boughtA || coin.aMissed)) return;
        if (tier === 'A' && aBuys >= params.maxABuys) return;
        if (tier === 'B' && (coin.boughtB || coin.bMissed)) return;
        const mark = priceOf(state, mint);
        if (mark === null) return;
        const mult = mark / coin.p0;
        const lo = tier === 'A' ? params.tierAMult : params.tierBMult;
        const hi = tier === 'A' ? params.tierAMaxMult : params.tierBMaxMult;
        if (mult >= hi) {
          if (tier === 'A') coin.aMissed = true;
          else coin.bMissed = true;
          return;
        }
        if (mult < lo) return;
        const want = tier === 'A' ? params.tierASizeLamports : params.tierBSizeLamports;
        const cap = state.maxBuyLamports(mint);
        const size = want < cap ? want : cap;
        if (size < params.tierASizeLamports) return; // below the counted round-trip minimum
        if (orders.length + buys.length >= caps.max_orders_per_batch) return;
        const committed = state.committedPositionCount() + buys.length;
        const limit = tier === 'A' ? caps.max_open_positions - params.tierAReserveSlots : caps.max_open_positions;
        if (committed >= limit) return;
        if (free < size + tx) return;
        buys.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: 10_000 });
        if (tier === 'A') {
          coin.boughtA = true;
          aBuys += 1;
        } else coin.boughtB = true;
        coin.tier = tier;
        free -= size + tx;
      };

      // Register creations, then scan the batch's mints: runners first.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const p0 = Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
          if (p0 > 0 && !coins.has(e.mint)) {
            coins.set(e.mint, { p0, boughtA: false, boughtB: false, aMissed: false, bMissed: false, tier: null, tokens: 0n, costPerToken: null });
          }
        }
      }
      const mints = [...new Set(batch.events.map((e) => e.mint))];
      for (const mint of mints) tryBuy(mint, 'B');
      for (const mint of mints) tryBuy(mint, 'A');

      return [...orders, ...buys];
    },
  };
}

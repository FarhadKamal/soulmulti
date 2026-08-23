export function flipCoin() {
  return Math.random() < 0.5 ? 'heads' : 'tails';
}

// Boingo's Chaos Gamble: a pure probability roll, no RPS interaction needed.
// 50% -> 'draw' (1 hit, -1 heart), 30% -> 'win' (3 hit, -3 hearts),
// 20% -> 'lose' (miss, 0 damage). Originally an even ~33/33/34 split -
// first rebalanced to 50/25/25 (dropped the miss rate from 34% to 25% at
// nearly the same 1.25 avg damage/turn, targeting "too many wasted turns"
// specifically), then tuned again here to 50/30/20 after his win rate
// still hadn't meaningfully recovered even with that first fix (see
// soulclash_boingo_balance-style tracking in the multiplayer win-rate
// reports) - this version both raises the average (1.4 dmg/turn) AND
// drops the miss rate further to 20%, a real combined buff rather than
// just a miss-rate-only adjustment.
export function rollChaosGamble() {
  const r = Math.random();
  if (r < 0.50) return 'draw';
  if (r < 0.80) return 'win';
  return 'lose';
}

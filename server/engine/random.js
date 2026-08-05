export function flipCoin() {
  return Math.random() < 0.5 ? 'heads' : 'tails';
}

// Boingo's Chaos Gamble: a pure probability roll, no RPS interaction needed.
// 33% -> 'draw' (1 hit, -1 heart), 33% -> 'win' (3 hit, -3 hearts),
// 34% -> 'lose' (miss, 0 damage).
export function rollChaosGamble() {
  const r = Math.random();
  if (r < 0.33) return 'draw';
  if (r < 0.66) return 'win';
  return 'lose';
}

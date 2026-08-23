export function flipCoin() {
  return Math.random() < 0.5 ? 'heads' : 'tails';
}

// Boingo's Chaos Gamble: a pure probability roll, no RPS interaction needed.
// 33% -> 'draw' (1 hit, -1 heart), 33% -> 'win' (3 hit, -3 hearts),
// 34% -> 'lose' (miss, 0 damage).
export function rollChaosGamble() {
  const r = Math.random();
  // Rebalanced from an even ~33/33/34 split - the 'lose' (0 damage) tier
  // was too frequent, leaving Boingo whiffing a full turn roughly a third
  // of the time with nothing to show for it. Tuned to 50% draw (1 dmg) /
  // 25% win (3 dmg) / 25% lose (0 dmg): expected damage per turn stays
  // nearly identical (1.25 vs the old 1.32), but the miss rate drops from
  // 34% to 25% - a deliberately targeted fix for "too many wasted turns,"
  // not a blanket damage buff.
  if (r < 0.50) return 'draw';
  if (r < 0.75) return 'win';
  return 'lose';
}

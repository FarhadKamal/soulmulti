// Records each finished match's winning character(s) and full participant
// list to MongoDB Atlas, purely so character win rates can be computed
// later (e.g. "does Marin actually win more than everyone else"). Entirely
// best-effort/fire-and-forget - a write failure here must never affect
// actual gameplay, so every call is wrapped defensively and logs to the
// console rather than throwing.
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
let client = null;
let collection = null;

// Connects once, lazily, on first use - not at server boot, so a missing/
// invalid MONGODB_URI (e.g. running locally without it configured) doesn't
// crash the whole server on startup. Reused across every subsequent write.
async function getCollection() {
  if (collection) return collection;
  if (!uri) {
    console.error('recordMatchResult: MONGODB_URI not set - stats logging disabled');
    return null;
  }
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  collection = client.db('soulclash').collection('matchResults');
  return collection;
}

// Per-hero win rates for 4-player matches, for the hidden main-menu stats
// panel (Ctrl+Shift+X, 2026-10-20). Draws aren't recorded, so the fair
// baseline is 25%. Cached briefly so repeated toggling doesn't hammer Atlas.
const WIN_RATE_CACHE_MS = 60 * 1000;
let winRateCache = null;

function tallyWinRates(docs) {
  const byHero = {};
  for (const d of docs) {
    for (const id of d.participantCharacterIds || []) {
      byHero[id] ??= { games: 0, wins: 0 };
      byHero[id].games += 1;
    }
    for (const id of d.winningCharacterIds || []) {
      byHero[id] ??= { games: 0, wins: 0 };
      byHero[id].wins += 1;
    }
  }
  return Object.entries(byHero).map(([id, s]) => ({ id, ...s }));
}

export async function getWinRates() {
  if (winRateCache && Date.now() - winRateCache.at < WIN_RATE_CACHE_MS) return winRateCache.data;
  const col = await getCollection();
  if (!col) return null;
  const docs = await col.find(
    { playerCount: 4 },
    { projection: { winningCharacterIds: 1, participantCharacterIds: 1, recordedAt: 1 } },
  ).toArray();
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const times = docs.map((d) => new Date(d.recordedAt).getTime()).filter(Number.isFinite);
  const recent = docs.filter((d) => new Date(d.recordedAt).getTime() >= since);
  const data = {
    matches: docs.length,
    last7DaysMatches: recent.length,
    from: times.length ? new Date(Math.min(...times)).toISOString() : null,
    to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    allTime: tallyWinRates(docs),
    last7Days: tallyWinRates(recent),
  };
  winRateCache = { at: Date.now(), data };
  return data;
}

// Called once per finished match (see broadcastGameState's game-over
// branch in index.js, guarded so this only fires on the actual phase
// transition, not on every subsequent broadcast while already finished).
// Skips draws entirely (winnerPlayerId null) - a draw has no winning
// character, so it's useless for the "which character wins most" question
// this data exists to answer.
export async function recordMatchResult(game, roomType) {
  if (!game.winnerPlayerId) {
    console.log('recordMatchResult: draw, skipping (winnerPlayerId is null)');
    return;
  }
  const winner = game.players.find((p) => p.id === game.winnerPlayerId);
  if (!winner) {
    console.error('recordMatchResult: winnerPlayerId set but no matching player found:', game.winnerPlayerId);
    return;
  }
  const participants = game.players.flatMap((p) => p.characterIds);
  try {
    const col = await getCollection();
    if (!col) return;
    const result = await col.insertOne({
      roomType,
      winningCharacterIds: winner.characterIds,
      participantCharacterIds: participants,
      playerCount: game.players.length,
      round: game.round,
      recordedAt: new Date(),
    });
    console.log('recordMatchResult: wrote match result, insertedId:', result.insertedId.toString(), 'winner:', winner.characterIds);
  } catch (err) {
    // Never let a stats-write failure affect the actual match/broadcast -
    // this is purely observational logging, not gameplay-critical.
    console.error('recordMatchResult failed (non-fatal):', err.message);
  }
}

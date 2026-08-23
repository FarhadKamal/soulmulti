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
  if (!uri) return null; // stats logging silently disabled if unconfigured
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  collection = client.db('soulclash').collection('matchResults');
  return collection;
}

// Called once per finished match (see broadcastGameState's game-over
// branch in index.js, guarded so this only fires on the actual phase
// transition, not on every subsequent broadcast while already finished).
// Skips draws entirely (winnerPlayerId null) - a draw has no winning
// character, so it's useless for the "which character wins most" question
// this data exists to answer.
export async function recordMatchResult(game, roomType) {
  if (!game.winnerPlayerId) return;
  const winner = game.players.find((p) => p.id === game.winnerPlayerId);
  if (!winner) return;
  const participants = game.players.flatMap((p) => p.characterIds);
  try {
    const col = await getCollection();
    if (!col) return;
    await col.insertOne({
      roomType,
      winningCharacterIds: winner.characterIds,
      participantCharacterIds: participants,
      playerCount: game.players.length,
      round: game.round,
      recordedAt: new Date(),
    });
  } catch (err) {
    // Never let a stats-write failure affect the actual match/broadcast -
    // this is purely observational logging, not gameplay-critical.
    console.error('recordMatchResult failed (non-fatal):', err.message);
  }
}

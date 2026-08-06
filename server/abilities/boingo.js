import { applyDamage, applyHeal } from '../engine/damagePipeline.js';
import { rollChaosGamble } from '../engine/random.js';

export const actions = {
  chaosGamble: {
    label: 'Chaos Gamble',
    needsTarget: true,
    isLegal: () => true,
    // Pure probability roll, same as cyclonePunch's flipCoin - rolled here
    // server-side rather than accepted as a client-supplied outcome (a
    // client "reporting" its own roll would be an exploit vector, and the
    // server is the sole authority on random outcomes). Previously this
    // expected an `outcome` argument nobody ever passed - executeAction()
    // is always called with 4 args from index.js (both the human action
    // handler and the paced bot-turn stepper), so outcome was always
    // undefined, amount was always 0, and Chaos Gamble silently always
    // missed for everyone, human or bot.
    execute(character, targetId, game, log, extra) {
      // Tutorial mode forces a deterministic outcome (the bot always deals
      // flat 1; the human's own scripted sequence forces a specific
      // win/draw/lose result per step) instead of the real roll - see
      // server/data/tutorialSequences.js's forcedAmount field. Every
      // non-tutorial call passes no `extra`, leaving the normal random
      // roll completely untouched.
      let outcome;
      let amount;
      if (game.mode === 'tutorial' && extra?.forcedAmount != null) {
        amount = extra.forcedAmount;
        outcome = amount === 3 ? 'win' : amount === 1 ? 'draw' : 'lose';
      } else {
        outcome = rollChaosGamble();
        amount = 0;
        if (outcome === 'win') amount = 3;
        else if (outcome === 'draw') amount = 1;
      }
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
        // Tutorial-forced hits ignore shield in both directions (whichever
        // side - human or bot - is playing Chronox has Chrono Guard
        // resetting to 1 shield every one of ITS OWN turns, which would
        // otherwise silently discount the forced amount and break the
        // tutorial's exact heart math). Non-tutorial calls are unaffected.
        ignoresShield: game.mode === 'tutorial' && extra?.forcedAmount != null,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'chaosGamble', targetId, outcome, ...result });
      return result;
    },
  },
  jesterBall: {
    label: 'Jester Ball',
    needsTarget: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      game.jesterBall = {
        thrownByCharacterId: character.id,
        holderCharacterId: targetId,
        canPass: true,
      };
      log.push({ type: 'special', characterId: character.id, actionId: 'jesterBall', targetId });
      return {};
    },
  },
};

// Resolved on the holder's own turn, not via the normal action list.
export const jesterBallResolution = {
  return_: {
    label: 'Return to Boingo',
    execute(game, log) {
      const { thrownByCharacterId } = game.jesterBall;
      // applyHeal no-ops (returns 0) if Boingo is already KO'd or already
      // at full hearts - report what actually happened (and why) rather
      // than always claiming the full +4, which would be misleading.
      const wasKO = game.characters[thrownByCharacterId]?.isKO ?? false;
      const healed = applyHeal(game, thrownByCharacterId, 4);
      log.push({ type: 'jester-ball-return', boingoId: thrownByCharacterId, healed, wasKO });
      game.jesterBall = null;
    },
  },
  pass: {
    label: 'Pass to another player',
    isLegal: (game) => game.jesterBall.canPass,
    execute(game, log, newHolderCharacterId) {
      const fromCharacterId = game.jesterBall.holderCharacterId;
      game.jesterBall.holderCharacterId = newHolderCharacterId;
      game.jesterBall.canPass = false;
      log.push({ type: 'jester-ball-pass', fromCharacterId, toCharacterId: newHolderCharacterId });
    },
  },
  take: {
    label: 'Take it',
    execute(game, log, extra) {
      const holderId = game.jesterBall.holderCharacterId;
      // Tutorial mode can force a flat amount with shield ignored (so a
      // Chronox-bot holder's persistent Chrono Guard shield can't
      // unpredictably discount the demo hit) - see
      // server/data/tutorialSequences.js's boingo sequence. Every
      // non-tutorial call passes no `extra`, leaving the normal flat-4,
      // shield-absorbing Take completely untouched.
      const forced = game.mode === 'tutorial' ? extra : null;
      const result = applyDamage(game, log, {
        sourceCharacterId: game.jesterBall.thrownByCharacterId,
        targetCharacterId: holderId,
        amount: forced?.forcedAmount ?? 4,
        ignoresShield: forced?.ignoresShield ?? false,
      });
      log.push({ type: 'jester-ball-take', targetCharacterId: holderId, ...result });
      game.jesterBall = null;
      return result;
    },
  },
};

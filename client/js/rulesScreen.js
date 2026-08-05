import { CHARACTERS } from './characters.js';
import { playUiClick } from './sound.js';

// Adapted from the main game's rulesScreen.js OVERVIEW - the mechanics
// differ where multiplayer's actual implementation differs from the main
// game's pass-and-play/single-shared-screen assumptions: everyone's on
// their own device (no pass-and-play), Hidden Mark is kept fully hidden
// server-side (no moderator call needed - see sanitizeGameForBroadcast in
// server/index.js), and the turn timer is 30s here, not 20s.
const OVERVIEW = [
  'Everyone plays from their own device - no pass-and-play, no shared screen. Hearts, shields, marks/curses, charges, and streaks are all tracked and shown live for everyone in the room.',
  'All randomness (coin flips, Chaos Gamble\'s roll) resolves instantly server-side - no moderator or dice needed, including Akyros\'s Hidden Mark, which the server keeps fully hidden from everyone except Akyros\'s own owner until it\'s revealed.',
  'A "round" = every player has taken one full turn, in seat order. On their turn, a player acts with ALL of their non-KO\'d characters, freely choosing an available action for each.',
  'Every character has 7 hearts. Shields absorb damage before hearts are touched. 0 hearts = KO\'d. A player is eliminated once ALL of their characters are KO\'d - last player standing wins.',
  'Each player has 30 seconds to choose an action/target before it is auto-picked, to keep the match moving. If a player disconnects or times out, a bot takes over their character(s) for the rest of the match.',
];

const CHARACTER_RULES = {
  chronox: [
    { h: 'Chrono Guard (passive)', b: 'Starts the match with 1 shield. Resets to exactly 1 at the start of each of his own turns - does not stack. Within a round it depletes hit-by-hit as a normal pool.' },
    { h: 'Cyclone Punch (normal, any target)', b: 'Coin flip: Heads -2 hearts, Tails -1 heart, resolved instantly.' },
    { h: 'Time Freeze (special, 1x, targets one enemy)', b: 'Flat 2-round duration, no randomness. Target skips their next turn, then skips once more on Chronox\'s following turn, then unfreezes automatically. If Chronox is KO\'d while active, the freeze ends immediately.' },
  ],
  tharox: [
    { h: 'Smash (normal, any target)', b: 'Flat -1 heart.' },
    { h: 'Titan Toss (normal, no target)', b: 'Grants a Titan Smash charge. Only usable without a charge already banked.' },
    { h: 'Titan Smash (normal, follow-up, any target)', b: '-3 hearts. Requires a charge; consumes it.' },
    { h: 'Glory Smash (special, 1x, follow-up, any target)', b: '-2 hearts to target, +2 hearts and +2 decaying shield (1 round) to Tharox. Consumes the current charge but grants a brand-new one.' },
    { h: 'Mandatory cash-in', b: 'After Titan Toss (or a fresh charge from Glory Smash), Tharox\'s next actionable turn MUST be Titan Smash or Glory Smash - he can\'t Smash or Toss again while charged. Being frozen just delays the obligation.' },
  ],
  zerathys: [
    { h: 'Charge Up (normal, no target)', b: '+1 charge (caps at 2). Persists indefinitely until spent, survives skipped turns.' },
    { h: 'Thunder Wrath (normal, any target)', b: 'Damage scales with current charge: 0 = -1, 1 = -2, 2 = -3 hearts. Resets charge to 0 after use.' },
    { h: 'Soul Swap (special, 1x, any target)', b: 'Swaps current hearts totals with the target, then immediately fires a free Thunder Wrath at any target using whatever charge is banked.' },
  ],
  akyros: [
    { h: 'Hidden Mark (normal, no damage)', b: 'Secretly marks a target - stays fully hidden (only Akyros\'s own owner can see it) until revealed. Marks never expire. Each enemy can only ever be marked ONCE per match - no re-marking, even after that mark is revealed or used. Akyros\'s marks are cleared entirely if he\'s KO\'d.' },
    { h: 'Fatal Slash (normal, any target)', b: 'Marked target: -2 hearts, and this reveals the mark. Unmarked target: -1 heart.' },
    { h: 'Dodge (passive)', b: 'Each enemy\'s very first attack on Akyros (ever, across the match) deals 0 damage. Independent per attacker. Athena\'s curse-mirror damage bypasses this.' },
    { h: 'Shadow Execution (special, 1x)', b: 'Requires an existing mark somewhere. -3 hearts to that marked target, ignoring shields, and reveals the mark. Does not consume the mark.' },
  ],
  velorya: [
    { h: 'Turn 1', b: 'Must open with Lunar Strike or Lunar Eclipse - Moonstep isn\'t available yet.' },
    { h: 'Lunar Strike (normal, any target)', b: 'Flat -1 heart, ignoring shields.' },
    { h: 'Moonstep (normal, any target, from her 2nd attack on)', b: 'Different target than her last attack: -2 hearts. Same target: -1 heart. Both ignore shields. Her first real attack never gets the bonus even if it\'s Moonstep.' },
    { h: 'Lunar Eclipse (special, 1x, no target)', b: 'Becomes untargetable by direct attacks. Flat 3-attack duration, no randomness - covers her next 3 attacks, then ends automatically. Does NOT block Athena\'s curse-mirror damage (not a direct targeted attack).' },
  ],
  boingo: [
    { h: 'Chaos Gamble (normal, every turn, any target)', b: 'Instant server-side roll: 33% chance -3 hearts (win), 33% chance -1 heart (draw), 34% chance miss (0 damage).' },
    { h: 'Jester Ball (special, 1x, thrown at one target)', b: 'Doesn\'t resolve immediately - sits with the holder until their own next turn, when handling it becomes their action: Return to Boingo (heals him +4), Pass to another player (only allowed once total, never back to Boingo), or Take it (-4 hearts to the holder, but doesn\'t use up their turn). A 30s safety timer auto-resolves as Take if ignored.' },
  ],
  blade: [
    { h: 'Blood Hunt (normal, every turn, any target)', b: 'Tracks a streak vs. whichever target he\'s attacking: 1st hit -1, then +1 per consecutive hit on the SAME target (-1, -2, -3...), no cap. Switching targets resets to -1. Being frozen pauses the streak rather than resetting it.' },
    { h: 'Rebirth (special, 1x, automatic)', b: 'Fires the instant Blade would be KO\'d - revives with 2 hearts, no turn cost. Also clears any frozen status, resets his Blood Hunt streak, and lifts any curse on him. One-time only.' },
  ],
  athena: [
    { h: 'Curse Strike (normal, every turn, VISIBLE to all)', b: 'Curses one player (only one curse active at a time; re-picking the same target is a valid pass). While active, any damage Athena takes is also mirrored onto the cursed player at the same amount - bypasses Akyros\'s Dodge and Velorya\'s untargetable, but still passes through the cursed player\'s own shield normally.' },
    { h: 'Divine Restore (special, 1x)', b: '+3 hearts and +2 decaying shield (1 round) for Athena.' },
    { h: 'No separate attack', b: 'Curse Strike is Athena\'s entire normal action each turn - she has no other direct-damage normal move.' },
  ],
};

export function renderRulesModal(container, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay rules-overlay';
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = document.createElement('div');
  modal.className = 'modal rules-modal';

  const h2 = document.createElement('h2');
  h2.textContent = 'How to Play — Soul Clash Online';
  modal.appendChild(h2);

  const body = document.createElement('div');
  body.className = 'rules-body';

  const overviewSection = document.createElement('div');
  overviewSection.className = 'rules-section';
  const overviewTitle = document.createElement('h3');
  overviewTitle.textContent = 'Overview';
  overviewSection.appendChild(overviewTitle);
  OVERVIEW.forEach((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    overviewSection.appendChild(p);
  });
  body.appendChild(overviewSection);

  Object.entries(CHARACTER_RULES).forEach(([id, entries]) => {
    const def = CHARACTERS[id];
    const section = document.createElement('div');
    section.className = 'rules-section';

    const heading = document.createElement('h3');
    heading.className = 'rules-char-heading';
    const portrait = document.createElement('img');
    portrait.className = 'rules-char-portrait';
    portrait.src = `assets/portraits/${id}.jpg`;
    portrait.alt = def.name;
    heading.appendChild(portrait);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${def.name} — ${def.role}`;
    heading.appendChild(nameSpan);
    section.appendChild(heading);

    entries.forEach(({ h, b }) => {
      const ability = document.createElement('p');
      ability.className = 'rules-ability';
      const strong = document.createElement('strong');
      strong.textContent = h + ': ';
      ability.appendChild(strong);
      ability.appendChild(document.createTextNode(b));
      section.appendChild(ability);
    });

    body.appendChild(section);
  });

  modal.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => closeModal();
  actions.appendChild(closeBtn);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  container.appendChild(overlay);

  function closeModal() {
    playUiClick();
    overlay.remove();
    if (onClose) onClose();
  }
}

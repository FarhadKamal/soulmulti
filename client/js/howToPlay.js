// How to Play guide - per-hero ability reference shown on the main/entry
// screen, same toggle-panel pattern as lobbyScreen.js's own About button.
// Ability descriptions are the same code-verified text used in the
// Soul_Clash_Hero_Abilities.pdf reference doc, kept in sync with it -
// update both together whenever a hero's kit changes.
import { CHARACTERS, CHARACTER_IDS } from './characters.js';

const HERO_ABILITIES = {
  akyros: [
    ['Hidden Mark', 'Secretly marks a target (no public reveal). Once marked, they can never be marked again all match.'],
    ['Fatal Slash', 'Basic attack: 1 damage, or 2 if the target is currently marked (reveals the mark).'],
    ['Shadow Execution', 'One-time special: 3 shield-ignoring damage to a marked enemy, reveals the mark.'],
    ['Shadow Toll', "Repeatable: converts one of his own hearts into a 'converted' heart, shifting his own effective hearts down to bring Shadow Seal's threshold within reach faster."],
    ['Shadow Seal', 'One-time special at hearts ≤ 3 (based on effective hearts): splits every other living character’s hearts into a small active pool (max 2) and a locked remainder — only the active pool can be KO’d. Unlocks instantly, for everyone, the moment Akyros himself dies.'],
    ['Example', 'You Hidden Mark an enemy at 6 hearts (no one sees it land). Next turn you Fatal Slash them for 2 damage instead of 1, revealing the mark. Later, low on hearts, you cast Shadow Seal: everyone else is capped at 2 active hearts no matter how high their real total is — a 6-heart enemy can now be KO’d by just 2 more damage.'],
  ],
  athena: [
    ['Curse Strike', 'Marks one player with a visible curse. While cursed, any damage Athena takes is mirrored onto the cursed player too.'],
    ['Divine Restore', 'One-time special: heals 4 hearts and grants 3 permanent shield.'],
    ['Divine Sacrifice', 'Repeatable: deals 3 damage to an enemy, but costs Athena a random 1-3 of her own hearts every cast — genuine risk, no cooldown.'],
    ['Divine Judgment', 'One-time special at hearts ≤ 3: marks a target. The instant Athena is KO’d by anything, the marked victim is also instantly, unblockably KO’d (bypasses shield, dodge, immortality, everything).'],
    ['Example', 'You Curse Strike an enemy, then take a 3-damage hit yourself — that same 3 damage also lands on the cursed player. Later, desperate at 2 hearts, you cast Divine Judgment on your likely killer. When you finally get KO’d, they go down with you — even if they’re at full health and untargetable.'],
  ],
  blade: [
    ['Blood Hunt', 'Basic attack against a chosen target: damage climbs on a repeating 1→2→3 cycle per target, tracked independently for each enemy he’s hit.'],
    ['Blood Frenzy', 'One-time special at hearts ≤ 3: immediately unleashes a burst of random consecutive strikes (2–5, based on how many are alive) against living enemies, with each target’s own independent hit-streak climbing hit-by-hit during the burst, same as a normal Blood Hunt streak.'],
    ['Blood Drain (passive)', 'Always active from turn one, no threshold needed: whenever a Blood Hunt or Blood Frenzy strike lands as the 3rd hit of a target’s own 1-2-3 cycle and actually connects, Blade heals 1 heart.'],
    ['Example', 'You Blood Hunt the same enemy 3 turns in a row: 1 damage, then 2, then 3 — and that 3rd hit also heals you 1 heart. Switch to a different target and their own cycle starts fresh at 1, but the first enemy’s progress is still banked for whenever you come back to them.'],
  ],
  boingo: [
    ['Chaos Gamble', 'Basic attack: random outcome — win (3 damage), draw (1 damage), or miss (0).'],
    ['Jester Ball', 'One-time special: throws an explosive ball at a target. It can be passed player-to-player (up to 10 passes) before it auto-detonates; landing on Boingo himself grants him a growing heal/shield reward instead of damage.'],
    ['Fowl Play', 'One-time special at hearts ≤ 3: turns every other living character into a chicken (locked to a single weak Chicken Attack, no defenses) for 3 of Boingo’s own turns, then everyone reverts at once.'],
    ['Pass to another player / Take it', 'Ball-holder options: pass the live Jester Ball onward, or voluntarily detonate it immediately for 4 damage to yourself.'],
    ['Example', 'You throw Jester Ball at an enemy. They pass it to someone else rather than risk it, that player passes it back to you — landing on YOU grants a heal/shield reward instead of damage. Keep passing and the stakes climb each time, until someone finally eats the explosion.'],
  ],
  chronox: [
    ['Cyclone Punch', 'Basic attack: a coin flip decides 1 or 2 damage.'],
    ['Time Freeze', 'One-time special: freezes one target’s next 2 turns.'],
    ['World Stops', 'One-time special at hearts ≤ 3: freezes every other living opponent for 4 rounds at once — his last-stand move.'],
    ['Rewind', 'Usable twice per match: fully undoes the most recent action taken against Chronox, restoring both his and the attacker’s full state (health, statuses, resources) as if it never happened.'],
    ['Example', 'An enemy lands a 3-damage hit and burns their special ability doing it. You cast Rewind: your hearts go back up, and their special is un-spent as if they never cast it — you’ve effectively erased their whole turn.'],
  ],
  draxus: [
    ['Dying Blow', 'Basic attack: damage scales up as his own hearts get lower (1/2/3 tiers).'],
    ['Deathless Fury', 'One-time special: enters a temporary damage-proof state (can’t be KO’d) until his own next turn, which then grants 3 bonus consecutive strikes.'],
    ['Cheat Death (passive)', 'Whenever Draxus is KO’d, he still gets a turn to roll a revival chance (25%, rising 5% per failed attempt) instead of being eliminated. Success brings him back at 1 heart, briefly immortal, with every negative status cleared.'],
    ['Example', 'You get KO’d. Instead of being out, you roll Cheat Death: 25% chance to revive. It fails — next time you’re KO’d the odds are 30%, then 35%, climbing every time, until eventually the roll succeeds and you’re back at 1 heart and briefly unkillable.'],
  ],
  grimtal: [
    ['Grim Strike', 'Basic attack: damage grows with his own accumulated kill count (both kills he’s personally landed and kills he’s since ‘claimed’).'],
    ['Claim the Kill', 'Repeatable, costs his turn: converts a banked ‘unclaimed’ kill into a ‘claimed’ one, permanently boosting Grim Strike’s damage.'],
    ['Skull Crack', 'Usable 3 times per match: 2 shield-ignoring damage, plus a chance to inflict a delayed ‘headache’ that skips the target’s next turn.'],
    ['Beast Form', 'One-time special at hearts ≤ 3: transforms Grimtal into an untargetable, fully damage-immune beast whose only action is Beast Attack, until any character anywhere is KO’d (or a long safety-valve timeout). While transformed, heals passively every other turn if still low on hearts.'],
    ['Beast Attack', 'Only available while in Beast Form: a normal attack dealing 3 damage to whoever currently has the highest hearts, or 2 damage to anyone else.'],
    ['Example', 'At 3 hearts you transform into Beast Form — now untargetable and immune, with only Beast Attack available. You keep hitting the healthiest remaining enemy for 3 each turn until someone, anywhere on the board, finally gets KO’d — the instant that happens, you revert back to normal form automatically.'],
  ],
  illyra: [
    ['Mirage Mark', 'Basic attack: deals no direct damage, just stacks an illusion mark on a target.'],
    ['Mirage Burst', 'Repeatable, no target needed: detonates every currently-marked enemy at once, each taking damage based on their own stack count (bypasses dodge and untargetable).'],
    ['Mirage Overload', 'One-time special at hearts ≤ 3: scatters a large pool of mark-stacks randomly across every other living character in one shot, to be cashed in later with Mirage Burst.'],
    ['Illusion (passive)', 'A flat 50% chance to dodge any incoming attack or status effect entirely, checked automatically every hit.'],
    ['Example', 'You Mirage Mark the same enemy 3 turns running, building 3 stacks on them without dealing any direct damage. Then you cast Mirage Burst: that enemy takes a chunk of damage based on their 3 stacks, all at once, bypassing their dodge entirely.'],
  ],
  kaelis: [
    ['Grudge Strike', 'Basic attack: deals bonus damage equal to how many times that specific target has hit her since her last Grudge Strike against them.'],
    ['Call Ashka', 'One-time special: heals 2 hearts immediately, then heals 2 more on each of her next 2 turns.'],
    ['Ashka’s Vengeance (passive)', 'Activates permanently once her hearts first drop to ≤ 3: every one of her own turns from then on, her phoenix companion automatically strikes a random enemy for 1 true damage that bypasses shield, dodge, and untargetable — in addition to her normal action.'],
    ['Example', 'The same enemy hits you 3 times without you landing Grudge Strike back on them. Your next Grudge Strike against that specific enemy deals your normal damage PLUS 3 bonus — one for every hit you banked. Hit a different enemy first and that grudge count doesn’t apply.'],
  ],
  marin: [
    ['Wand Strike', 'Basic attack: 1 damage (2 once Wand Mastery is discovered; ignores shield once Piercing Wand is discovered).'],
    ['Arcane Study', 'Repeatable: reveals one random undiscovered spell from her kit on her next turn.'],
    ['Everbloom', 'Discoverable passive: heals 1 heart every other one of her own turns, permanently, once unlocked.'],
    ['Threefold Veil', 'Discoverable passive: grants a pool of 3 dodge charges against any incoming hit, with no recharge.'],
    ['Clean Slate', 'Discoverable reactive passive: the first time a covered negative status (curse, freeze, mark, silence) lands on her after this is discovered, it’s automatically cleansed and she gains 3 turns of immunity to new negative statuses.'],
    ['Piercing Wand / Wand Mastery', 'Discoverable passives: Wand Strike permanently ignores shield / deals 2 damage instead of 1 — both stack together.'],
    ['Lifebond', 'One-time special at hearts ≤ 3: sums every living character’s hearts, divides evenly, and sets everyone’s hearts to that shared average at once — bypasses every defense.'],
    ['Example (Kit)', 'Arcane Study reveals Everbloom on turn 1, then Threefold Veil on turn 3 — now you passively heal every other turn AND have 3 free dodge charges banked, with more spells still to discover.'],
    ['Example (Lifebond)', 'In a 4-player match, hearts are 3 (you), 7, 4, 2 — total 16, split 4 ways is 4. Cast Lifebond and everyone instantly becomes 4 hearts: you gain 1, the 7-heart player loses 3, the 2-heart player gains 2. A full heal-up for you disguised as ‘fairness.’'],
  ],
  melyssa: [
    ['Mind Control', 'Every turn: takes control of another living character and performs one of their real actions through them (their actual resources are spent for real). Normally has a 50% chance to succeed against a non-friend target.'],
    ['Self Choke', 'Offered against an enemy puppet: a guaranteed 2 shield-ignoring damage to them instead of risking their real action.'],
    ['Friendship', 'One-time special at hearts ≤ 3: forms a mutual no-attack bond with another character. Neither can attack the other, Mind Control on the friend becomes 100% guaranteed, and any damage/status aimed at Melyssa redirects to the friend instead (with overflow spilling back to her if the friend can’t fully absorb it).'],
    ['Reactive Shield (passive)', 'Whenever real damage reaches her hearts, she gains shield equal to the amount that got through, replacing any shield she had — cleared at the start of her own next turn.'],
    ['Example', 'You use Mind Control on an enemy and roll their Wand Strike against another player instead of them acting on their own. If it succeeds, that’s a real hit landed using their actual action. If you’d rather guarantee damage, Self Choke on them instead deals a certain 2 damage with no risk of the control failing.'],
  ],
  oraclus: [
    ['Rune Strike', 'Basic attack: 1 damage, permanently gaining +1 (max +2) for each correct Rune Vision prediction he’s ever made.'],
    ['Rune Vision', 'Repeatable special (only while 3-4 total characters remain): predicts who will attack whom next. A correct guess instantly grants +3 hearts, +3 permanent shield, and +1 permanent Rune Strike damage. Retires permanently after 2 correct predictions.'],
    ['Prophecy of Doom', 'One-time special at hearts ≤ 3: arms silently. The instant Oraclus is KO’d by anything, a meteor strike deals 3 damage to every other living character at once (shield still absorbs it, but dodge/untargetable don’t help).'],
    ['Example', 'You correctly predict with Rune Vision that Player A will attack Player B next turn — it happens, and you instantly gain +3 hearts, +3 shield, and +1 permanent Rune Strike damage. Later, at low hearts, you quietly cast Prophecy of Doom. No one notices until you’re finally KO’d — then everyone else takes 3 damage at once.'],
  ],
  rowan: [
    ['Wand Strike', 'Basic attack: 1 damage.'],
    ['Arcane Study', 'Repeatable: reveals one random undiscovered spell from his kit on his next turn.'],
    ['Poison Cloud', 'Discoverable, one-time: poisons a target, dealing damage on their own turns over time.'],
    ['Purify', 'Discoverable, one-time: fully heals Rowan and cleanses every negative status/effect currently on him from any source.'],
    ['Wild Lightning', 'Discoverable, one-time: a wild damage roll from 1 to 7.'],
    ['Mirror Reflect', 'Discoverable, one-time: arms a standing counter — the next real hit he takes and survives automatically reflects 3 damage back at the attacker, and stays armed indefinitely until it triggers.'],
    ['Silence Lock', 'Discoverable, one-time: silences a target for 3 turns — blocks their special/signature ability from being used, blocks every shield source, and strips any shield they currently have.'],
    ['Petrify', 'One-time bonus action at hearts ≤ 3: instantly reveals every remaining undiscovered spell at once, without costing his turn — he still gets a full normal action immediately after. Purely visual: every other character appears turned to stone during the moment.'],
    ['Frog Curse', 'One-time special at hearts ≤ 3: transforms a chosen enemy into a frog — their entire kit is hidden and every one of their own turns is fully skipped, but they get a passive 50% dodge against any incoming attack. The curse ends the instant a hit actually connects, even if fully absorbed by shield.'],
    ['Snake Strike', 'Repeatable follow-up, available whenever an enemy is currently frogged: a fixed 5 damage that bypasses both shield and dodge entirely — the frog cannot avoid it. Landing it ends the curse.'],
    ['Example', 'At 3 hearts you cast Frog Curse on an enemy — their whole kit vanishes and their turns are skipped. They get a 50% passive dodge each time someone attacks them, but the moment ANY hit connects (even one your shield fully blocks), they turn back. Rather than gamble on a normal attack, you can cast Snake Strike for a guaranteed 5 damage that ends the curse on the spot.'],
  ],
  tharox: [
    ['Smash', 'Basic attack: 1 damage (unavailable while a Titan Toss charge is banked).'],
    ['Titan Toss', 'Repeatable setup move: banks a charge, costing the turn, to power up his next Titan Smash.'],
    ['Titan Smash', 'Consumes a banked charge: 3 damage.'],
    ['Glory Smash', 'Requires a Titan Toss charge already banked. Usable twice per match: 2 damage to an enemy, plus heals himself 2 hearts and grants 2 decaying shield, while also refreshing the charge so it can be chained again after another Titan Toss.'],
    ['Earthshatter', 'One-time special at hearts ≤ 3: scatters 7 damage points, one at a time, randomly across every living opponent — bypasses dodge and untargetable.'],
    ['Example', 'You cast Titan Toss to bank a charge instead of attacking that turn. Next turn, Titan Smash consumes it for 3 damage — more than a plain Smash’s 1. Or, with a charge already banked, Glory Smash deals 2 damage while also healing you 2 and granting shield, and refreshes the charge for another combo.'],
  ],
  velorya: [
    ['Lunar Strike', 'Basic attack: 1 shield-ignoring damage.'],
    ['Moonstep', 'Basic attack: 1 shield-ignoring damage, or 2 if switching to a different target than her last hit.'],
    ['Lunar Eclipse', 'One-time special: becomes untargetable for her next 3 incoming attacks.'],
    ['Moonlit Theft', 'One-time special at hearts ≤ 3: drains every other living character’s current shield down to 0 and adds the entire stolen total to her own shield in one shot.'],
    ['Example', 'You hit the same enemy with Moonstep two turns straight (1 damage each), then switch to a different target — that switch itself deals 2 damage instead of 1. Later, low on hearts, Moonlit Theft strips every other player’s shield to 0 and hands the whole total straight to you.'],
  ],
  zerathys: [
    ['Charge Up', 'Repeatable setup move (unavailable while Overcharge Collapse is active): banks charge (up to 2 stacks) to power up his next Thunder Wrath.'],
    ['Thunder Wrath', 'Basic attack: damage scales with banked charge (1/2/3), always resets charge to 0 after use.'],
    ['Soul Swap', 'One-time special: swaps his current hearts with a target’s, then immediately gets one free follow-up Thunder Wrath.'],
    ['Overcharge Collapse (passive)', 'Automatically active whenever his hearts are ≤ 3: Charge Up is disabled, and every Thunder Wrath instead deals a flat 3 damage and grants +1 permanent shield, regardless of charge.'],
    ['Example', 'You Charge Up twice (banking 2 stacks), then Thunder Wrath for 3 damage, resetting to 0. Or cast Soul Swap on a nearly-dead enemy — you take their low hearts, they take your higher total, and you immediately get a free Thunder Wrath on top of it.'],
  ],
};

// Module state (not part of main.js's shared `state`) - same reasoning as
// lobbyScreen.js's own aboutOpen/choosingBotSeatIndex: this whole screen
// tears down and rebuilds on every server broadcast, so a plain local
// variable is what survives across rebuilds. Only ever shown on the entry
// screen. howToPlayOpenHeroId tracks which single hero's ability list (if
// any) is currently expanded within the open panel - collapsed accordion
// style rather than showing all 16 at once, so the panel stays scannable.
let howToPlayOpen = false;
let howToPlayOpenHeroId = null;

export function isHowToPlayOpen() {
  return howToPlayOpen;
}

// Icon button matching about/fullscreen's exact corner style - toggles
// howToPlayOpen and re-renders (no native dialog/popup, same "no popups"
// convention as every other inline panel in this app).
export function renderHowToPlayButton(rerender) {
  const btn = document.createElement('button');
  btn.className = 'how-to-play-icon-btn';
  btn.title = 'How to Play';
  btn.textContent = '📖';
  btn.onclick = () => {
    howToPlayOpen = !howToPlayOpen;
    if (!howToPlayOpen) howToPlayOpenHeroId = null;
    rerender();
  };
  return btn;
}

export function renderHowToPlayPanel(rerender) {
  const panel = document.createElement('div');
  panel.className = 'how-to-play-panel';

  const intro = document.createElement('p');
  intro.className = 'how-to-play-intro';
  intro.textContent = 'Soul Clash is a turn-based battle between 4 players, each controlling one hero. Take turns using your basic attack, special abilities, and passives to whittle down every other player’s hearts to zero. Most heroes unlock a powerful one-time special once their own hearts drop to 3 or below - the last stand that can turn a losing match around. Tap a hero below to see their full ability list.';
  panel.appendChild(intro);

  const grid = document.createElement('div');
  grid.className = 'how-to-play-hero-grid';

  CHARACTER_IDS.forEach((id) => {
    const hero = CHARACTERS[id];
    const card = document.createElement('div');
    card.className = 'how-to-play-hero-card';
    const isExpanded = howToPlayOpenHeroId === id;
    if (isExpanded) card.classList.add('how-to-play-hero-card--expanded');

    const header = document.createElement('button');
    header.className = 'how-to-play-hero-header';
    header.style.setProperty('--hero-color', hero.color);
    header.onclick = () => {
      howToPlayOpenHeroId = isExpanded ? null : id;
      rerender();
    };

    const portrait = document.createElement('img');
    portrait.className = 'how-to-play-hero-portrait';
    portrait.src = `assets/images/${id}/idle.jpg`;
    portrait.alt = hero.name;
    portrait.loading = 'lazy';
    header.appendChild(portrait);

    const nameBlock = document.createElement('div');
    nameBlock.className = 'how-to-play-hero-name-block';
    const nameEl = document.createElement('div');
    nameEl.className = 'how-to-play-hero-name';
    nameEl.textContent = hero.name;
    const roleEl = document.createElement('div');
    roleEl.className = 'how-to-play-hero-role';
    roleEl.textContent = hero.role;
    nameBlock.appendChild(nameEl);
    nameBlock.appendChild(roleEl);
    header.appendChild(nameBlock);

    const caret = document.createElement('span');
    caret.className = 'how-to-play-hero-caret';
    caret.textContent = isExpanded ? '▾' : '▸';
    header.appendChild(caret);

    card.appendChild(header);

    if (isExpanded) {
      const abilityList = document.createElement('div');
      abilityList.className = 'how-to-play-ability-list';
      (HERO_ABILITIES[id] || []).forEach(([label, desc]) => {
        const isExample = label.startsWith('Example');
        const item = document.createElement('div');
        item.className = isExample ? 'how-to-play-ability-item how-to-play-example-item' : 'how-to-play-ability-item';
        const labelEl = document.createElement('div');
        labelEl.className = isExample ? 'how-to-play-ability-label how-to-play-example-label' : 'how-to-play-ability-label';
        labelEl.textContent = isExample ? `💡 ${label}` : label;
        const descEl = document.createElement('div');
        descEl.className = 'how-to-play-ability-desc';
        descEl.textContent = desc;
        item.appendChild(labelEl);
        item.appendChild(descEl);
        abilityList.appendChild(item);
      });
      card.appendChild(abilityList);
    }

    grid.appendChild(card);
  });

  panel.appendChild(grid);
  return panel;
}

// Colors chosen so all 16 are easily distinguishable at a glance in the
// lobby character grid - confirmed live report that several were near-
// duplicates (chronox/melyssa/illyra all similar purples; draxus/rowan/
// grimtal all similar browns/ambers; kaelis close to blade's red; marin
// close to velorya's green). Full palette re-picked and verified via
// pairwise RGB distance (every pair >= ~64 units apart, most much further)
// - spread across the hue wheel with deliberately varied lightness/
// saturation on near-neighbors (e.g. grimtal is near-desaturated grey-
// brown rather than a vivid color, keeping it visually distinct from
// draxus/tharox despite sitting at a similar hue angle) so the palette
// stays separable even in the crowded warm (red/orange/brown) zone, which
// has more characters than any other hue region.
export const CHARACTERS = {
  chronox: { id: 'chronox', name: 'Chronox', role: 'Time Controller', color: '#9157f4' },
  tharox: { id: 'tharox', name: 'Tharox', role: 'Titan Warrior', color: '#f9761f' },
  zerathys: { id: 'zerathys', name: 'Zerathys', role: 'Storm Mage', color: '#f2db0d' },
  akyros: { id: 'akyros', name: 'Akyros', role: 'Shadow Assassin', color: '#346df4' },
  velorya: { id: 'velorya', name: 'Velorya', role: 'Moon Assassin', color: '#20b65f' },
  boingo: { id: 'boingo', name: 'Boingo', role: 'Chaos Trickster', color: '#eb479e' },
  blade: { id: 'blade', name: 'Blade', role: 'Blood Hunter', color: '#ee2b2b' },
  athena: { id: 'athena', name: 'Athena', role: 'Curse Guardian', color: '#cea009' },
  melyssa: { id: 'melyssa', name: 'Melyssa', role: 'Mind Controller', color: '#df45ed' },
  kaelis: { id: 'kaelis', name: 'Kaelis', role: 'Grudge Warrior', color: '#871d40' },
  draxus: { id: 'draxus', name: 'Draxus', role: 'Deathless Berserker', color: '#81440e' },
  rowan: { id: 'rowan', name: 'Rowan', role: 'Arcane Scholar', color: '#13abec' },
  marin: { id: 'marin', name: 'Marin', role: 'Wandering Bloom', color: '#64c91d' },
  grimtal: { id: 'grimtal', name: 'Grimtal', role: 'Bounty Hunter', color: '#7a726c' },
  illyra: { id: 'illyra', name: 'Illyra', role: 'Illusionist', color: '#4c39c6' },
  oraclus: { id: 'oraclus', name: 'Oraclus', role: 'Fate Seer', color: '#14b8a7' },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

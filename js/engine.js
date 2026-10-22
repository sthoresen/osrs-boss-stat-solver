// DPS engine for the fixed setups in data.js.
// The formulas are a port of the relevant parts of the OSRS wiki DPS calculator
// (github.com/weirdgloop/osrs-dps-calc, src/lib/PlayerVsNPCCalc.ts, GPL-3.0),
// reduced to closed-form expected damage so the solver can evaluate thousands of bosses per second.
// tools/verify.mjs checks this file against the real calculator.
import { ITEMS } from './items.js';
import { CONFIG } from './config.js';

const TICK = 0.6;
const PRAYERS = {
  PIETY: { acc: 120, str: 123, mdmg: 0 },
  RIGOUR: { acc: 120, str: 123, mdmg: 0 },
  AUGURY: { acc: 125, str: 100, mdmg: 40 },
};
const STYLES = {
  Accurate: { type: 'magic', stance: 'Accurate' },
  Autocast: { type: 'magic', stance: 'Autocast' },
  Pound: { type: 'crush', stance: 'Aggressive' },
  Pummel: { type: 'crush', stance: 'Aggressive' },
  Jab: { type: 'crush', stance: 'Aggressive' },
  Rapid: { type: 'ranged', stance: 'Rapid' },
};
const RANGED_TYPE = { Thrown: 'light', Bow: 'standard', Crossbow: 'heavy' };
const RUBY_CHANCE = 0.06 * 1.1; // kandarin hard diary
const TBOW_MAGIC_CAP = 250;

const trunc = Math.trunc;

function item(spec, setup) {
  const it = ITEMS.items[spec];
  if (!it) throw new Error(`Setup "${setup.id}" uses "${spec}", which is not in js/items.js. Run tools/build_data.py.`);
  return it;
}

/** Resolve a setup's items, spell and dart from data/setups.json specs. */
export function resolveGear(setup) {
  const items = {};
  for (const [slot, spec] of Object.entries(setup.items)) items[slot] = item(spec, setup);
  let spell = null;
  if (setup.spell) {
    const sp = ITEMS.spells[setup.spell];
    if (!sp) throw new Error(`Setup "${setup.id}" casts unknown spell "${setup.spell}".`);
    spell = { name: setup.spell, ...sp };
  }
  return { items, spell, dart: setup.dart ? item(setup.dart, setup) : null };
}

/** Player-side numbers that do not depend on the boss. */
export function buildLoadout(setup) {
  const { items, spell, dart } = resolveGear(setup);
  const style = STYLES[setup.style];
  if (!style) throw new Error(`Setup "${setup.id}" has unknown style "${setup.style}".`);
  const P = CONFIG.player;
  const weapon = items.weapon;
  const has = (name) => Object.values(items).some((i) => i.name === name);

  const off = { stab: 0, slash: 0, crush: 0, magic: 0, ranged: 0 };
  const bon = { str: 0, ranged_str: 0, magic_str: 0, prayer: 0 };
  const ammoUsed = !!items.ammo && (weapon.category === 'Bow' || weapon.category === 'Crossbow');
  for (const it of Object.values(items)) {
    const skipRanged = it.slot === 'ammo' && !ammoUsed;
    for (const k in off) if (!(skipRanged && k === 'ranged')) off[k] += it.off[k] || 0;
    for (const k in bon) if (!(skipRanged && k === 'ranged_str')) bon[k] += it.bon[k] || 0;
  }
  if (dart) bon.ranged_str += dart.bon.ranged_str;
  if (weapon.name === "Tumeken's shadow") {
    bon.magic_str = Math.min(1000, bon.magic_str * 3);
    off.magic *= 3;
  }
  if (items.cape && items.cape.name === "Dizana's quiver" && items.cape.version === 'Charged' && ammoUsed) {
    off.ranged += 10;
    bon.ranged_str += 1;
  }

  const L = {
    id: setup.id, setup, items, spell, dart, off, bon, type: style.type, stance: style.stance,
    kind: style.type === 'magic' ? 'magic' : style.type === 'ranged' ? 'ranged' : 'melee',
  };

  if (L.kind === 'melee') {
    const pr = PRAYERS[P.prayers.melee];
    const lvlA = P.levels.atk + P.boosts.atk;
    const lvlS = P.levels.str + P.boosts.str;
    const stA = 8 + (style.stance === 'Accurate' ? 3 : style.stance === 'Controlled' ? 1 : 0);
    const stS = 8 + (style.stance === 'Aggressive' ? 3 : style.stance === 'Controlled' ? 1 : 0);
    const effA = trunc(lvlA * pr.acc / 100) + stA;
    const effS = trunc(lvlS * pr.str / 100) + stS;
    let atk = effA * (off[style.type] + 64);
    let max = trunc((effS * (bon.str + 64) + 320) / 640);
    if (style.type === 'crush') {
      const inq = (has("Inquisitor's great helm") ? 1 : 0) + (has("Inquisitor's hauberk") ? 2 : 0) + (has("Inquisitor's plateskirt") ? 2 : 0);
      if (inq) {
        atk = trunc(atk * (200 + inq) / 200);
        max = trunc(max * (200 + inq) / 200);
      }
    }
    L.atk = atk;
    L.max = max;
    L.scythe = weapon.name.includes('of Vitur') || weapon.name.includes('of vitur');
    L.speed = weapon.speed;
  } else if (L.kind === 'ranged') {
    const pr = PRAYERS[P.prayers.ranged];
    const lvl = P.levels.ranged + P.boosts.ranged;
    const acc3 = style.stance === 'Accurate' ? 3 : 0;
    const effA = trunc(lvl * pr.acc / 100) + acc3 + 8;
    const effS = trunc(lvl * pr.str / 100) + acc3 + 8;
    let atk = effA * (off.ranged + 64);
    let max = trunc((effS * (bon.ranged_str + 64) + 320) / 640);
    if (weapon.name === 'Bow of Faerdhinen' || weapon.name === 'Crystal bow') {
      const pieces = (has('Crystal helm') ? 1 : 0) + (has('Crystal legs') ? 2 : 0) + (has('Crystal body') ? 3 : 0);
      atk = trunc(atk * (20 + pieces) / 20);
      max = trunc(max * (40 + pieces) / 40);
    }
    L.atk = atk;
    L.max = max;
    L.tbow = weapon.name === 'Twisted bow';
    L.ruby = weapon.category === 'Crossbow' && items.ammo && items.ammo.name.startsWith('Ruby') && items.ammo.name.endsWith('(e)');
    L.seeking = ammoUsed && items.ammo.name.startsWith('Seeking'); // accurate hits deal at least 3
    L.rangedType = RANGED_TYPE[weapon.category];
    L.speed = weapon.speed - (style.stance === 'Rapid' ? 1 : 0);
  } else {
    const pr = PRAYERS[P.prayers.magic];
    const lvl = P.levels.magic + P.boosts.magic;
    const eff = trunc(lvl * pr.acc / 100) + (style.stance === 'Accurate' ? 2 : 0) + 9;
    const baseRoll = eff * (off.magic + 64);
    let atk = baseRoll;
    const spellEl = spell ? spell.element : null;
    const smokeStaff = weapon.name === 'Twinflame staff' && !!spell; // counts as a smoke staff: +10% accuracy, +10% damage
    if (smokeStaff) atk = trunc(atk * 110 / 100);
    if (has('Tome of Water') && spellEl === 'water') atk = trunc(atk * 6 / 5);

    let max;
    if (spell) max = spellMaxHit(spell, lvl);
    else if (weapon.name === "Tumeken's shadow") max = Math.max(1, trunc(lvl / 3) + 1);
    else if (weapon.name === 'Eye of Ayak') max = Math.max(1, trunc(lvl / 3) - 6);
    else throw new Error(`no magic max hit for ${weapon.name}`);
    const baseMax = max;
    const mdmg = bon.magic_str + pr.mdmg + (smokeStaff ? 100 : 0);
    max += trunc(max * mdmg / 1000);

    L.baseRoll = baseRoll;
    L.atk = atk;
    L.baseMax = baseMax;
    L.max = max;
    L.spellEl = spellEl;
    L.tome = !!spellEl && ((has('Tome of Fire') && spellEl === 'fire') || (has('Tome of Water') && spellEl === 'water') || (has('Tome of Earth') && spellEl === 'earth'));
    L.confliction = has('Confliction gauntlets') && !weapon.twoHanded;
    L.twinflame = weapon.name === 'Twinflame staff' && !!spell;
    if (style.stance === 'Autocast') {
      if (weapon.name === 'Harmonised Nightmare staff') L.speed = 4;
      else if (weapon.name === 'Twinflame staff') L.speed = 6;
      else L.speed = 5;
    } else {
      L.speed = weapon.speed;
    }
  }
  return L;
}

// Since the elemental rework, every spell of a tier hits as hard as the highest one the player has unlocked.
const SPELL_TIERS = { Wave: [75, 70, 65], Surge: [95, 90, 85] };
function spellMaxHit(spell, magicLevel) {
  const tier = spell.name.split(' ')[1];
  const [fire, earth, water] = SPELL_TIERS[tier];
  const top = magicLevel >= fire ? 'Fire' : magicLevel >= earth ? 'Earth' : magicLevel >= water ? 'Water' : 'Wind';
  return ITEMS.spells[`${top} ${tier}`].max;
}

const cache = new Map();
/** Loadout for a setup (cached). */
export function loadout(setup) {
  let L = cache.get(setup);
  if (!L) {
    L = buildLoadout(setup);
    cache.set(setup, L);
  }
  return L;
}

function tbowScaling(current, magic, accuracyMode) {
  const factor = accuracyMode ? 10 : 14;
  const base = accuracyMode ? 140 : 250;
  const t2 = trunc((3 * magic - factor) / 100);
  const t3 = trunc((trunc(3 * magic / 10) - 10 * factor) ** 2 / 100);
  const bonus = Math.max(0, Math.min(base, base + t2 - t3));
  return trunc(current * bonus / 100);
}

function stdRoll(a, d) {
  return a > d ? 1 - (d + 2) / (2 * (a + 1)) : a / (2 * (d + 1));
}

export function hitChance(atk, def) {
  if (atk < 0) atk = Math.min(0, atk + 2);
  if (def < 0) def = Math.min(0, def + 2);
  if (atk >= 0 && def >= 0) return stdRoll(atk, def);
  if (atk >= 0 && def < 0) return 1 - 1 / (-def + 1) / (atk + 1);
  if (atk < 0 && def >= 0) return 0;
  return stdRoll(-def, -atk);
}

function fangRoll(atk, def) {
  const std = (a, d) => (a > def
    ? 1 - (d + 2) * (2 * d + 3) / (a + 1) / (a + 1) / 6
    : a * (4 * a + 5) / 6 / (a + 1) / (d + 1));
  const rv = (a, d) => (a < def
    ? a * (d * 6 - 2 * a + 5) / 6 / (d + 1) / (d + 1)
    : 1 - (d + 2) * (2 * d + 3) / 6 / (d + 1) / (a + 1));
  if (atk < 0) atk = Math.min(0, atk + 2);
  if (def < 0) def = Math.min(0, def + 2);
  if (atk >= 0 && def >= 0) return std(atk, def);
  if (atk >= 0 && def < 0) return 1 - 1 / (-def + 1) / (atk + 1);
  if (atk < 0 && def >= 0) return 0;
  return rv(-def, -atk);
}

function conflictionChance(atk, def) {
  const single = hitChance(atk, def);
  const double = fangRoll(atk, def);
  return double / (1 + double - single);
}

/**
 * Expected damage of a uniform 0..max roll with accuracy acc, where an accurate hit below `floor` is raised
 * to `floor` (1 normally: accurate 0s become 1; 3 with seeking arrows).
 */
function linearExpected(acc, max, floor = 1) {
  if (max <= 0) return 0;
  const raised = floor * Math.min(floor, max + 1);
  const rest = max >= floor ? max * (max + 1) / 2 - floor * (floor - 1) / 2 : 0;
  return acc * (raised + rest) / (max + 1);
}

/** Twinflame: each accurate hit d (0 raised to 1) adds a second splat of floor(0.4 d). */
function twinflameExpected(acc, max) {
  if (max <= 0) return 0;
  let sum = 1; // accurate 0 -> 1, second splat floor(0.4) = 0
  for (let d = 1; d <= max; d++) sum += d + trunc(d * 4 / 10);
  return acc * sum / (max + 1);
}

/**
 * DPS of a loadout against a boss. `b.def` and `b.mdef` are the values in effect (after any drain).
 * Returns details for display as well.
 */
export function dps(L, b) {
  let atk = L.atk;
  let max = L.max;
  let defRoll;
  if (L.kind === 'magic') {
    // elemental weakness is treated as type-less: it applies to every elemental spell
    if (L.spellEl && b.severity) {
      atk += trunc(L.baseRoll * b.severity / 100);
      max += trunc(L.baseMax * (b.severity / 100));
    }
    if (L.tome) max = trunc(max * 11 / 10);
    defRoll = (b.magic + 9) * (b.mdef + 64);
  } else if (L.kind === 'ranged') {
    if (L.tbow) {
      const m = Math.min(TBOW_MAGIC_CAP, Math.max(b.magic, 0));
      atk = tbowScaling(atk, m, true);
      max = tbowScaling(max, m, false);
    }
    defRoll = (b.def + 9) * (b[L.rangedType] + 64);
  } else {
    defRoll = (b.def + 9) * (b[L.type] + 64);
  }

  const acc = L.kind === 'magic' && L.confliction ? conflictionChance(atk, defRoll) : hitChance(atk, defRoll);
  let exp;
  if (L.scythe) {
    exp = 0;
    const hits = Math.min(Math.max(b.size, 1), 3);
    for (let i = 0; i < hits; i++) exp += linearExpected(acc, trunc(max / 2 ** i));
  } else if (L.twinflame) {
    exp = twinflameExpected(acc, max);
  } else if (L.ruby) {
    const ruby = Math.min(100, trunc(b.hp * 20 / 100));
    exp = RUBY_CHANCE * ruby + (1 - RUBY_CHANCE) * linearExpected(acc, max);
  } else {
    exp = linearExpected(acc, max, L.seeking ? 3 : 1);
  }
  return { dps: exp / L.speed / TICK, acc, atk, defRoll, max, speed: L.speed, exp };
}

/** Boss defence after the maximum allowed drain. */
export function drained(b, mode = 'cap') {
  let def = b.def - Math.floor(b.def * b.defCap / 100);
  if (mode === 'dwh1' || mode === 'dwh2') {
    let d = b.def;
    for (let i = 0; i < (mode === 'dwh1' ? 1 : 2); i++) d -= trunc(d * 3 / 10);
    def = Math.max(def, d);
  }
  const mdef = b.mdef > 0 ? b.mdef - Math.floor(b.mdef * b.mdefCap / 100) : b.mdef;
  return { ...b, def, mdef };
}

/** DPS of a setup before and after drain. */
export function evalSetup(setup, b, mode) {
  const L = loadout(setup);
  return { L, base: dps(L, b), red: dps(L, drained(b, mode)) };
}

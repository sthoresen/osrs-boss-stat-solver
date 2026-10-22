// Compare js/engine.js against DPS values produced by the real wiki calculator.
// Usage: node tools/verify.mjs oracle.json
// (oracle.json is produced by tools/oracle.test.ts run inside a checkout of weirdgloop/osrs-dps-calc; see README)
import fs from 'fs';
import { CONFIG } from '../js/config.js';
import { loadout, dps } from '../js/engine.js';

const oracle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let worst = 0; let n = 0; let bad = 0;
for (const { case: c, res } of oracle) {
  let def = c.def;
  for (let i = 0; i < (c.dwh || 0); i++) def -= Math.trunc(def * 3 / 10);
  const mdef = c.ayak > 0 && c.mdef > 0 ? Math.max(0, c.mdef - c.ayak) : c.mdef;
  const b = { ...c, def, mdef };
  for (const s of CONFIG.setups) {
    const r = dps(loadout(s), b);
    const o = res[s.id];
    const err = Math.abs(r.dps - o.dps) / Math.max(o.dps, 1e-9);
    n++;
    if (err > worst) worst = err;
    if (err > 1e-9) {
      bad++;
      if (bad <= 15) console.log(s.id, JSON.stringify(c), { mine: { dps: r.dps, acc: r.acc, atk: r.atk, def: r.defRoll, max: r.max, speed: r.speed }, wiki: o });
    }
  }
}
console.log(`${n} comparisons, ${bad} mismatches, worst relative error ${worst.toExponential(2)}`);
process.exit(bad ? 1 : 0);

// Inverse problem: find boss stats whose DPS for each setup is as close as possible to the targets.
// Loss is squared log-ratio (relative error) over base and drained targets, plus a weak pull
// toward the starting stats so unconstrained stats stay put.
// Optimiser: differential evolution (rand/1/bin) followed by integer coordinate descent.
import { loadout, dps, drained } from './engine.js';

/**
 * Stats the solver may change, with deliberately generous bounds. `scale` is a typical step size:
 * it sets how hard the pull toward the current stats is and how far the local search wanders.
 */
export const PARAMS = [
  { key: 'def', lo: 0, hi: 1500, scale: 500 },
  { key: 'magic', lo: 0, hi: 1500, scale: 500 },
  { key: 'crush', lo: -100, hi: 1500, scale: 500 },
  { key: 'mdef', lo: -100, hi: 1500, scale: 500 },
  { key: 'light', lo: -100, hi: 1500, scale: 500 },
  { key: 'standard', lo: -100, hi: 1500, scale: 500 },
  { key: 'heavy', lo: -100, hi: 1500, scale: 500 },
  { key: 'severity', lo: 0, hi: 250, scale: 60 },
  { key: 'defCap', lo: 0, hi: 100, scale: 100 },
  { key: 'mdefCap', lo: 0, hi: 100, scale: 100 },
];

/**
 * @param ctx {setups, targets: {id: {base, red}}, weights: {base, red}, mode, prior}
 */
function makeObjective(ctx) {
  const Ls = ctx.setups.map((s) => loadout(s));
  const T = ctx.setups.map((s) => ctx.targets[s.id]);
  const wB = ctx.weights.base;
  const wR = ctx.weights.red;
  return (b) => {
    const r = drained(b, ctx.mode);
    let loss = 0;
    for (let i = 0; i < Ls.length; i++) {
      const d0 = dps(Ls[i], b).dps;
      const d1 = dps(Ls[i], r).dps;
      const e0 = Math.log(Math.max(d0, 1e-3) / T[i].base);
      const e1 = Math.log(Math.max(d1, 1e-3) / T[i].red);
      loss += wB * e0 * e0 + wR * e1 * e1;
    }
    return loss;
  };
}

function toBoss(x, free, start) {
  const b = { ...start };
  for (let j = 0; j < free.length; j++) b[free[j].key] = Math.round(x[j]);
  return b;
}

function priorPenalty(x, free, start, lambda) {
  let p = 0;
  for (let j = 0; j < free.length; j++) {
    const z = (x[j] - start[free[j].key]) / free[j].scale;
    p += z * z;
  }
  return lambda * p;
}

/** Total loss and per-setup errors for a boss (used for display). */
export function fitReport(ctx, b) {
  const r = drained(b, ctx.mode);
  const rows = ctx.setups.map((s) => {
    const L = loadout(s);
    const base = dps(L, b);
    const red = dps(L, r);
    const t = ctx.targets[s.id];
    return { id: s.id, base, red, errBase: base.dps / t.base - 1, errRed: red.dps / t.red - 1 };
  });
  const obj = makeObjective(ctx);
  return { rows, loss: obj(b) };
}

/**
 * Run the solver. Yields control between generations so the page stays responsive.
 * @param start current boss stats
 * @param locked Set of locked keys (kept at start value)
 * @param opts {generations, onProgress(frac), signal}
 */
export async function solve(ctx, start, locked, opts = {}) {
  const free = PARAMS.filter((p) => !locked.has(p.key));
  const lambda = ctx.prior ?? 0.01;
  const gens = opts.generations ?? 160;
  const NP = Math.max(24, free.length * 5);
  const f = makeObjective(ctx);
  if (free.length === 0) return { loss: f(start), boss: start };

  const cost = (x) => f(toBoss(x, free, start)) + priorPenalty(x, free, start, lambda);
  const clamp = (v, p) => Math.min(p.hi, Math.max(p.lo, v));

  // initial population: the start point, points scattered around it, and a few anywhere in bounds
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const sample = (p, i) => {
    const s0 = clamp(start[p.key], p);
    if (i === 0) return s0;
    if (i % 5 === 0) return p.lo + Math.random() * (p.hi - p.lo);
    return clamp(s0 + gauss() * p.scale * (i % 2 ? 0.25 : 0.8), p);
  };
  const pop = [];
  const fit = [];
  for (let i = 0; i < NP; i++) {
    const x = free.map((p) => sample(p, i));
    pop.push(x);
    fit.push(cost(x));
  }
  for (let g = 0; g < gens; g++) {
    for (let i = 0; i < NP; i++) {
      let a; let b; let c;
      do a = (Math.random() * NP) | 0; while (a === i);
      do b = (Math.random() * NP) | 0; while (b === i || b === a);
      do c = (Math.random() * NP) | 0; while (c === i || c === a || c === b);
      const F = 0.5 + Math.random() * 0.4;
      const jr = (Math.random() * free.length) | 0;
      const y = pop[i].slice();
      for (let j = 0; j < free.length; j++) {
        if (j === jr || Math.random() < 0.9) {
          let v = pop[a][j] + F * (pop[b][j] - pop[c][j]);
          const p = free[j];
          if (v < p.lo) v = p.lo + Math.random() * (pop[i][j] - p.lo);
          if (v > p.hi) v = p.hi - Math.random() * (p.hi - pop[i][j]);
          y[j] = v;
        }
      }
      const fy = cost(y);
      if (fy <= fit[i]) {
        pop[i] = y;
        fit[i] = fy;
      }
    }
    if (g % 8 === 7) {
      if (opts.signal?.aborted) return null;
      opts.onProgress?.(g / gens);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // polish the best member on the integer grid
  let bi = 0;
  for (let i = 1; i < NP; i++) if (fit[i] < fit[bi]) bi = i;
  let x = pop[bi].map((v) => Math.round(v));
  let fx = cost(x);
  for (const stepSize of [500, 100, 20, 5, 1]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let j = 0; j < free.length; j++) {
        for (const dir of [-1, 1]) {
          const y = x.slice();
          y[j] = clamp(y[j] + dir * stepSize, free[j]);
          const fy = cost(y);
          if (fy < fx - 1e-12) {
            x = y;
            fx = fy;
            improved = true;
          }
        }
      }
    }
  }
  opts.onProgress?.(1);
  return { loss: fx, boss: toBoss(x, free, start) };
}

// Loads the hand-edited setup list (data/setups.json) in the browser and in Node (tools/verify.mjs).
async function load() {
  const url = new URL('../data/setups.json', import.meta.url);
  if (url.protocol === 'file:') {
    const fs = await import('node:fs');
    return JSON.parse(fs.readFileSync(url, 'utf8'));
  }
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`could not load data/setups.json (${res.status})`);
  return res.json();
}

export const CONFIG = await load();

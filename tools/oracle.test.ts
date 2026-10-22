/* Oracle: computes DPS with the real wiki calc for the setups in osrs-cmb-re/data/setups.json
 * over a set of boss stat cases, and writes the results to ORACLE_OUT. */
import { test } from '@jest/globals';
import * as fs from 'fs';
import { CUSTOM_MONSTER_BASE, INITIAL_MONSTER_INPUTS } from '@/lib/Monsters';
import { Monster } from '@/types/Monster';
import { EquipmentPiece, Player } from '@/types/Player';
import { Prayer } from '@/enums/Prayer';
import { spells } from '@/types/Spell';
import { getCombatStylesForCategory } from '@/utils';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import { scaleMonster } from '@/lib/MonsterScaling';
import { getTestPlayer } from '@/tests/utils/TestUtils';
import eq from '../../cdn/json/equipment.json';

const equipment = eq as EquipmentPiece[];
const SETUPS = process.env.SETUPS_JSON!;
const CASES = process.env.ORACLE_CASES!;
const OUT = process.env.ORACLE_OUT!;

function item(spec: string): EquipmentPiece {
  const [name, version] = spec.split('|');
  const e = equipment.find((x) => x.name === name && (version === undefined || x.version === version));
  if (!e) throw new Error(`missing item ${spec}`);
  return { ...e };
}


test('oracle', () => {
  const cfg = JSON.parse(fs.readFileSync(SETUPS, 'utf8'));
  const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const out: unknown[] = [];

  for (const c of cases) {
    const baseMonster: Monster = {
      ...CUSTOM_MONSTER_BASE,
      size: c.size,
      skills: { ...CUSTOM_MONSTER_BASE.skills, def: c.def, magic: c.magic, hp: c.hp },
      defensive: {
        ...CUSTOM_MONSTER_BASE.defensive,
        stab: c.stab, slash: c.slash, crush: c.crush, magic: c.mdef, light: c.light, standard: c.standard, heavy: c.heavy,
      },
      // the tool treats weakness as type-less; its elemental setups cast fire spells
      weakness: c.severity ? { element: 'fire', severity: c.severity } : null,
      inputs: {
        ...INITIAL_MONSTER_INPUTS,
        monsterCurrentHp: c.hp,
        defenceReductions: { ...INITIAL_MONSTER_INPUTS.defenceReductions, dwh: c.dwh || 0, ayak: c.ayak || 0 },
      },
    };
    const monster = scaleMonster(baseMonster);
    const res: Record<string, unknown> = {};

    for (const s of cfg.setups) {
      const eqp: Record<string, EquipmentPiece | null> = {};
      for (const [slot, spec] of Object.entries<string>(s.items)) eqp[slot] = item(spec);
      if (s.dart) {
        eqp.weapon = { ...eqp.weapon!, itemVars: { blowpipeDartId: item(s.dart).id } };
      }
      let spell = null;
      if (s.spell) spell = spells.find((sp) => sp.name === s.spell)!;
      const styles = getCombatStylesForCategory(eqp.weapon!.category);
      const style = styles.find((st) => st.name === s.style || st.stance === s.style)!;
      const group = s.group as 'melee' | 'ranged' | 'magic';
      const prayer = Prayer[cfg.player.prayers[group] as keyof typeof Prayer];

      const player: Player = getTestPlayer(monster, {
        equipment: eqp,
        style,
        spell,
        prayers: [prayer],
        skills: { ...cfg.player.levels },
        boosts: { ...cfg.player.boosts },
      } as never);

      const calc = new PlayerVsNPCCalc(player, baseMonster, { loadoutName: s.id });
      res[s.id] = {
        dps: calc.getDps(),
        acc: calc.getHitChance(),
        atk: calc.getMaxAttackRoll(),
        def: calc.getNPCDefenceRoll(),
        max: calc.getDistribution().getMax(),
        speed: calc.getExpectedAttackSpeed(),
      };
    }
    out.push({ case: c, res });
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
});

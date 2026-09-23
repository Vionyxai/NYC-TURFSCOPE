// m1 / run every fetcher. ACS + TIGER are required; PLUTO + DAC degrade gracefully.
import { log, warn, activeCounties } from '../lib/util.js';
import { runACS } from './acs.js';
import { runTiger } from './tiger.js';
import { runPluto } from './pluto.js';
import { runDAC } from './dac.js';

const steps = [
  ['ACS', runACS, true],
  ['TIGER', runTiger, true],
  ['PLUTO', runPluto, false],
  ['DAC', runDAC, false],
];

log(`Ingest · active counties: ${activeCounties().map((c) => c.name).join(', ')}`);
let failed = false;
for (const [name, fn, required] of steps) {
  try {
    await fn();
  } catch (e) {
    (required ? console.error : warn)(`${name} failed: ${e.message}`);
    if (required) failed = true;
  }
}
if (failed) { console.error('[turfscope] Ingest incomplete — fix required sources before scoring.'); process.exit(1); }
log('Ingest done → data/raw/');

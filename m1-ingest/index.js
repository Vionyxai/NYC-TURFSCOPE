// m1 / run every fetcher. ACS + TIGER are required; the rest degrade gracefully.
import { log, warn, activeCounties } from '../lib/util.js';
import { runACS } from './acs.js';
import { runTiger, runPlaces } from './tiger.js';
import { runPluto } from './pluto.js';
import { runDAC } from './dac.js';
import { runBusiness } from './business.js';

const steps = [
  ['ACS', runACS, true],
  ['TIGER', runTiger, true],
  ['Places', runPlaces, false],
  ['PLUTO', runPluto, false],
  ['DAC', runDAC, false],
  ['Businesses', runBusiness, false],
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

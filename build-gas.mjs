// Copies the shared rules engine into the Apps Script project as Rules.gs,
// so the browser and the backend always run identical rules.
import { readFile, writeFile } from 'node:fs/promises';

const src = await readFile(new URL('../js/rules.js', import.meta.url), 'utf8');
const header = '// GENERATED from js/rules.js by tools/build-gas.mjs — edit js/rules.js, not this file.\n';
await writeFile(new URL('../apps-script/Rules.gs', import.meta.url), header + src);
console.log('apps-script/Rules.gs updated from js/rules.js');

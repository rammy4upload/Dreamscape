/**
 * Backwards-compatible CLI entry (npm scripts, node index.js, legacy paths).
 * Implementation lives in cli/index.js.
 */
export { main } from './cli/index.js';

import path from 'path';
import { fileURLToPath } from 'url';

const entryPath = process.argv[1] && path.resolve(process.argv[1]);
const thisFile = fileURLToPath(import.meta.url);

if (entryPath && path.resolve(thisFile) === entryPath) {
  const { main } = await import('./cli/index.js');
  main().catch((err) => {
    console.error('[FAIL]', err);
    process.exitCode = 1;
  });
}

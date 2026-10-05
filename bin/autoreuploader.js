#!/usr/bin/env node
import { main } from '../cli/index.js';

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});

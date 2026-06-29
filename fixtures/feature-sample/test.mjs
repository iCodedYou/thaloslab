// Characterization tests for the two independent modules. New features must not break these.
import { greet } from './src/greeting.mjs';
import { log } from './src/logging.mjs';

let failed = 0;
if (greet('world') !== 'Hello, world!') {
  console.log('FAIL greeting.greet');
  failed++;
} else {
  console.log('PASS greeting.greet');
}
if (!log('hi').includes('hi')) {
  console.log('FAIL logging.log');
  failed++;
} else {
  console.log('PASS logging.log');
}
process.exit(failed > 0 ? 1 : 0);

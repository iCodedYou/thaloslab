// Minimal dependency-free test runner. Exits non-zero on failure (the gate reads the exit code).
import { sum } from './src/sum.mjs';

let failures = 0;
function expect(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`PASS ${name}`);
  }
}

expect('sum(2,3)', sum(2, 3), 5);
expect('sum(0,0)', sum(0, 0), 0);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');

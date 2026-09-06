import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('interrupt e2e (rs)', async () => {
    await runE2eScript('test-e2e-interrupt.sh', ['rs']);
});

test('interrupt e2e (js)', async () => {
    await runE2eScript('test-e2e-interrupt.sh', ['js']);
});

import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('redeploy e2e (rs)', async () => {
    await runE2eScript('test-e2e-redeploy.sh', ['rs']);
});

test('redeploy e2e (js)', async () => {
    await runE2eScript('test-e2e-redeploy.sh', ['js']);
});

import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('target-deploy e2e (rs)', async () => {
    await runE2eScript('test-e2e-target-deploy.sh', ['rs']);
});

test('target-deploy e2e (js)', async () => {
    await runE2eScript('test-e2e-target-deploy.sh', ['js']);
});

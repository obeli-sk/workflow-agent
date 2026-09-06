import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('deploy-outside-root e2e (rs)', async () => {
    await runE2eScript('test-e2e-deploy-outside-root.sh', ['rs']);
});

test('deploy-outside-root e2e (js)', async () => {
    await runE2eScript('test-e2e-deploy-outside-root.sh', ['js']);
});

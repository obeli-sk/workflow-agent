import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('redeploy e2e', async () => {
    await runE2eScript('test-e2e-redeploy.sh');
});

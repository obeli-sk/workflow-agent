import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('github-mount-deploy e2e', async () => {
    await runE2eScript('test-e2e-github-mount-deploy.sh');
});

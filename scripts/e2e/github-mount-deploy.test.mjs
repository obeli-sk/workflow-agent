import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('github-mount-deploy e2e (rs)', async () => {
    await runE2eScript('test-e2e-github-mount-deploy.sh', ['rs']);
});

test('github-mount-deploy e2e (js)', async () => {
    await runE2eScript('test-e2e-github-mount-deploy.sh', ['js']);
});

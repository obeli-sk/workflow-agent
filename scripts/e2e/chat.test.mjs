import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('chat e2e (rs)', async () => {
    await runE2eScript('test-e2e-chat.sh', ['rs']);
});

test('chat e2e (js)', async () => {
    await runE2eScript('test-e2e-chat.sh', ['js']);
});

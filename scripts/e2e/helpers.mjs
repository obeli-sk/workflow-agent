import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

// Runs an existing scripts/test-e2e-*.sh suite as a single node:test case.
// Output is buffered and only dumped on failure, since suites run
// concurrently (one per file) and interleaved live output would be
// unreadable; within a file, node:test runs cases sequentially, which is
// what keeps a suite's rs/js pair (same hardcoded ports) from colliding.
export function runE2eScript(script, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(path.join(ROOT, 'scripts', script), args, {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            console.error(output);
            reject(new Error(`${script} ${args.join(' ')} exited with code ${code}`));
        });
    });
}

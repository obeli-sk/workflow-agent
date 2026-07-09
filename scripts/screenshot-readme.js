// Captures the workflow-agent web UI screenshot used by the README.
//
// Usage:
//   nix develop .#screenshots -c \
//     node scripts/screenshot-readme.js <url> [output.png]
//
// Default output:
//   docs/workflow-agent.png

const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright-core');

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/screenshot-readme.js <url> [output.png]');
  process.exit(2);
}

const output = process.argv[3] || path.join(__dirname, '..', 'docs', 'workflow-agent.png');

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#detail h2, #detail .err-box', { timeout: 15000 });
  await page.waitForSelector('#detail .bubble, #detail .turn, #detail .confirm, #detail .ask, #detail .err-box', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.run-item.active', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  await page.screenshot({ path: output, fullPage: true });
  console.log(`Saved ${output}`);

  await browser.close();
})();

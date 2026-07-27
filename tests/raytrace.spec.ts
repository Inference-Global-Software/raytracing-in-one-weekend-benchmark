import { test, expect } from '@playwright/test';

// Smoke + screenshot: the page loads, the Inference-compiled wasm instantiates,
// a (fast, low-quality) render paints the 1920x1080 canvas with a real image,
// and no uncaught errors occur. A screenshot is saved as a CI artifact.
test('wasm instantiates and renders a non-blank image', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ?auto=0 disables the on-load preview so the test drives the render itself.
  await page.goto('/?auto=0');

  // The wasm ABI banner only appears once the module instantiated successfully.
  await expect(page.locator('#abi')).toContainText('ABI', { timeout: 30_000 });

  // Fast settings: 3 samples, depth 8, coarse render scale -> finishes quickly
  // even though the canvas is full 1920x1080.
  await page.selectOption('#scene', '0');
  await page.fill('#samples', '3');
  await page.fill('#depth', '8');
  await page.fill('#rscale', '6');
  await page.click('#render');

  // Wait until the render completes (tiny settings -> a few seconds).
  await page.waitForFunction(() => (window as any).__rt && (window as any).__rt.done === true, null, {
    timeout: 90_000,
  });

  // The canvas must be non-blank with real colour variety (sky + ground + spheres),
  // not a single flat fill.
  const stats = await page.evaluate(() => {
    const c = document.getElementById('view') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let nonBlack = 0;
    const colors = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r | g | b) nonBlack++;
      colors.add((r << 16) | (g << 8) | b);
    }
    return { nonBlack, distinct: colors.size, total: data.length / 4 };
  });

  expect(stats.nonBlack).toBeGreaterThan(stats.total * 0.2); // a real image, not blank
  expect(stats.distinct).toBeGreaterThan(100);               // sky+ground+spheres, not flat

  await page.screenshot({ path: testInfo.outputPath('raytrace-showcase.png') });
  await testInfo.attach('raytrace-showcase', {
    path: testInfo.outputPath('raytrace-showcase.png'),
    contentType: 'image/png',
  });

  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join('; ')}`).toEqual([]);
});

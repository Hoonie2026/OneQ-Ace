/**
 * v0.10 계산 도구: 계산 문제(문항 글자로 판정)면 계산기가 저절로 열리고, 도·분·초 계산·도분초 표시,
 * 손글씨 메모(다음 문항이면 지워짐), PC 키보드(2 → 답, Enter → 다음). 휴대폰 크기 + PC 크기(1366×768, 두 단 화면)
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const SAMPLE = resolve(import.meta.dirname, '../../packs/oneq-SURVEY-2022-1.zip');
async function toCalc(page: Page) {
  await page.getByTestId('go-subjects').click();
  await page.getByTestId('subject-study').first().click();
  for (let k = 0; k < 20; k++) {
    await page.getByRole('button', { name: '1번' }).waitFor();
    await page.waitForTimeout(150);
    if (await page.getByTestId('calc-tag').isVisible()) return;
    await page.getByRole('button', { name: '모름' }).click();
    await page.getByRole('button', { name: /^(다음 →|성적 보기)$/ }).click();
  }
  throw new Error('no calc question');
}
for (const [name, w, h] of [['phone', 0, 0], ['pc', 1366, 768]] as const) {
  test(`계산 도구(v0.10) ${name}: 계산 문제면 계산기 자동, 도분초 계산, 손글씨 메모, PC 키보드`, async ({ page }, info) => {
    test.skip(name === 'pc' && info.project.name !== 'pixel', 'PC 크기는 한 번만');
    test.skip(!existsSync(SAMPLE), '실제 팩(packs/oneq-SURVEY-2022-1.zip)이 있어야 계산 문제가 나옴');
    test.setTimeout(120_000);
    if (w) await page.setViewportSize({ width: w, height: h });
    await page.goto('./');
    await page.getByTestId('pack-input').first().setInputFiles(SAMPLE);
    await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    await toCalc(page);
    await expect(page.getByTestId('calculator')).toBeVisible();
    for (const k of ['5', '0', '°′″', '2', '0', '°′″', '1', '5', '°′″', '+', '1', '=']) await page.locator('.calc-key[data-key="' + k + '"]').click();
    await expect(page.getByTestId('calc-out')).toHaveText(/51\.3375/);
    await page.locator('.calc-key[data-key="SHIFT"]').click();
    await page.locator('.calc-key[data-key="°′″"]').click();
    await expect(page.getByTestId('calc-out')).toHaveText('51°20′15″');
    await page.screenshot({ path: `test-results/tools-calc-${name}-${info.project.name}.png` });
    await page.getByTestId('tool-memo').click();
    const c = page.getByTestId('pad-canvas');
    const b = (await c.boundingBox())!;
    await page.mouse.move(b.x + 30, b.y + 40);
    await page.mouse.down();
    for (let i = 0; i < 20; i++) await page.mouse.move(b.x + 30 + i * 8, b.y + 40 + Math.sin(i / 3) * 20);
    await page.mouse.up();
    await expect(c).toHaveAttribute('data-strokes', '1');
    // v0.10.1(Y5): 같은 문항에서는 계산기 ↔ 메모를 오가도, 닫았다 열어도 그대로
    await page.getByTestId('tool-calc').click();
    await expect(page.getByTestId('calc-out')).toHaveText('51°20′15″');
    await expect(page.getByTestId('calc-expr')).toHaveText('50°20′15″+1');
    await page.getByTestId('tool-memo').click();
    await expect(c).toHaveAttribute('data-strokes', '1');
    await page.getByTestId('tool-memo').click(); // 닫기
    await expect(page.getByTestId('tool-panel')).toBeHidden();
    await page.getByTestId('tool-memo').click(); // 다시 열기
    await expect(c).toHaveAttribute('data-strokes', '1');
    // 키보드(PC): 2 → 답, Enter → 다음 문항에서 메모가 지워짐
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('2');
    await expect(page.getByTestId('feedback')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('feedback')).toBeHidden();
    // 다음 문항이면 메모는 새 장
    if (!(await page.getByTestId('tool-panel').isVisible()) || !(await page.getByTestId('scratchpad').isVisible())) await page.getByTestId('tool-memo').click();
    await expect(page.getByTestId('pad-canvas')).toHaveAttribute('data-strokes', '0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
}

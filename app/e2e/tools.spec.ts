/**
 * 계산 도구(v0.10~v0.10.5): 모든 문항에서 보기 아래 줄 [계산기|메모] 박스(v0.10.5 하단 2줄) — 처음에는 닫혀 있고 누르면 열림(v0.10.4: 계산 문제 자동 판정 없앰).
 * 도·분·초 계산·도분초 표시, 손글씨 메모, 같은 문항에서 오가도 그대로, 다음 문항에서도 도구는 열린 채(메모만 새 장),
 * PC 키보드(2 → 답, Enter → 다음). 휴대폰 크기 + PC 크기(1366×768, 두 단 화면)
 */
import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makePack } from '../src/test/makePack';

const SAMPLE = resolve(import.meta.dirname, '../../packs/oneq-SURVEY-2022-1.zip');
async function packFile(): Promise<string> {
  if (existsSync(SAMPLE)) return SAMPLE;
  const dir = mkdtempSync(join(tmpdir(), 'oneq-tools-'));
  const path = join(dir, 'oneq-TEST-2022-1.zip');
  writeFileSync(path, await makePack({ questions: Array.from({ length: 40 }, (_, i) => ({ hash: `t${i}`, answer: (i % 4) + 1, subjectNo: Math.floor(i / 20) + 1 })) }));
  return path;
}

for (const [name, w, h] of [['phone', 0, 0], ['pc', 1366, 768]] as const) {
  test(`계산 도구 ${name}: [계산기]·[메모] 단추, 도분초 계산, 손글씨 메모, 상태 유지, PC 키보드`, async ({ page }, info) => {
    test.skip(name === 'pc' && info.project.name !== 'pixel', 'PC 크기는 한 번만');
    test.setTimeout(120_000);
    if (w) await page.setViewportSize({ width: w, height: h });
    await page.goto('./');
    await page.getByTestId('pack-input').first().setInputFiles(await packFile());
    await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('go-subjects').click();
    await page.getByTestId('subject-study').first().click();
    await page.getByRole('button', { name: '1번' }).waitFor();
    // v0.10.5: 하단 2줄 — 보기 바로 아래(4px) 한 줄에 [모름|쉬움] 박스와 [계산기|메모] 박스
    const lay = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { ch: r('.choices'), ans: r('.act-answer'), tools: r('.act-tools'), foot: r('footer.solve-bottom') };
    });
    expect(lay.ans.top - lay.ch.bottom).toBeLessThanOrEqual(5);
    expect(Math.abs(lay.ans.top - lay.tools.top)).toBeLessThan(1);
    expect(lay.tools.left).toBeGreaterThan(lay.ans.right);
    if (!w) expect(lay.foot.height).toBeLessThan(125);
    // 처음에는 닫혀 있고, 단추로 연다
    await expect(page.getByTestId('tool-panel')).toBeHidden();
    await expect(page.getByTestId('tool-calc')).toContainText('계산기');
    await page.getByTestId('tool-calc').click();
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
    // 답한 뒤: 왼쪽 박스가 [다음 →], 휴대폰에서는 도구가 아이콘만(이름은 aria-label)
    await expect(page.locator('.act-row > .btn-next')).toBeVisible();
    await expect(page.getByRole('button', { name: '계산기' })).toBeVisible();
    await expect(page.getByTestId('tool-calc').locator('span')).toBeVisible({ visible: !!w });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('feedback')).toBeHidden();
    // 다음 문항: 열어 둔 메모는 그대로 열려 있고 내용만 새 장
    await expect(page.getByTestId('scratchpad')).toBeVisible();
    await expect(page.getByTestId('pad-canvas')).toHaveAttribute('data-strokes', '0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
}

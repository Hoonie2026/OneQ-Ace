/** 홈 화면 모양 확인(v0.19.2): 수험표 흰 점 없음, 모의고사·더 보기 안내 문구 없음, 출제기준 → 학습 원리 순서 */
import { expect, test } from './fixtures';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePack } from '../src/test/makePack';

for (const scheme of ['light', 'dark'] as const) {
  test(`홈 화면(${scheme})`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    const dir = mkdtempSync(join(tmpdir(), 'oneq-home-'));
    const path = join(dir, 'oneq-TEST-2022-1.zip');
    writeFileSync(path, await makePack({ certName: '콘크리트기사', questions: [1, 2, 3, 4].map((no) => ({ hash: `h${no}`, subjectNo: no })) }));
    await page.goto('./');
    await page.getByTestId('pack-input').first().setInputFiles(path);
    await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
    const links = page.locator('.home-link');
    await expect(links.nth(0)).toHaveText('출제기준');
    await expect(links.nth(1)).toHaveText('학습 원리 · 예상 점수 계산 방법');
    await expect(page.locator('.mock-card .hint')).toHaveCount(0);
    const dot = await page.locator('.exam-row .exam-dday').evaluate((el) => getComputedStyle(el, '::before').content);
    expect(dot === 'none' || dot === 'normal' || dot === '').toBe(true);
    await page.waitForTimeout(3500); // 가져오기 알림이 사라진 뒤
    await expect(page.getByTestId('plan-open')).toContainText('시험일 미지정');
    await page.screenshot({ path: `test-results/home-${scheme}-${info.project.name}.png`, fullPage: true });
    // v0.19.4: 갤럭시(360×780)·아이폰(390×844)에서 스크롤 없이 한 화면 — 머리부터 더 보기 카드까지
    for (const [w, h] of [[360, 780], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      const bottom = await page.locator('.foot').evaluate((el) => el.getBoundingClientRect().bottom); // v0.20.4: 맨 아래 안내까지
      expect(bottom).toBeLessThanOrEqual(h);
    }
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => ((t as HTMLElement).style.display = 'none')));
    await page.screenshot({ path: `test-results/home-${scheme}-${info.project.name}-fit.png` });
  });
}

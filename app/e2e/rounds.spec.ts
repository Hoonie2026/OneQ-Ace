/**
 * 회차별 학습(v0.19, 사용자 2026-11-17): 홈 [과목별 학습 | 회차별 학습] → 회차 목록(최근 회차 먼저) →
 * 시험지 순서대로 풀기 → ✕로 나가면 회차 목록, 다시 누르면 이어 풀기, 다 풀면 성적(회독 기록·다시 풀기) → [다른 회차 고르기].
 */
import { expect, test } from './fixtures';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePack } from '../src/test/makePack';

test('회차별 학습: 목록 → 이어 풀기 → 성적 → 회차 목록', async ({ page }, info) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), 'oneq-rounds-'));
  const files = [];
  for (const round of [1, 2]) {
    const path = join(dir, `oneq-TEST-2022-${round}.zip`);
    writeFileSync(path, await makePack({ round, questions: Array.from({ length: 4 }, (_, i) => ({ hash: `r${round}-${i}`, text: `${round}회 ${i}번 문항 ① 가 ② 나 ③ 다 ④ 라`, answer: (i % 4) + 1 })) }));
    files.push(path);
  }
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(files);
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('go-rounds')).toHaveText('회차별 학습');
  await page.screenshot({ path: `test-results/rounds-home-${info.project.name}.png` });
  await page.getByTestId('go-rounds').click();
  const list = page.getByTestId('round-list');
  await expect(list).toBeVisible();
  const rows = list.getByTestId('round-study');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('2022년 2회');                  // 최근 회차 먼저
  await expect(rows.first()).toContainText('처음 풀기');
  await rows.nth(1).click();                                                 // 1회
  await expect(page.getByTestId('progress')).toHaveText('1 / 4');
  await page.getByRole('button', { name: '1번' }).click();
  await page.getByRole('button', { name: '다음 →' }).click();
  await page.getByRole('button', { name: '1번' }).click();                  // 2번 문항 정답은 ② → 오답
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await expect(page.getByTestId('round-list')).toBeVisible();               // 회차 목록으로 돌아옴
  const r1 = page.getByTestId('round-TEST-2022-1');
  await expect(r1).toContainText('2/4');
  await expect(r1.getByTestId('round-wrong')).toContainText('오답·모름 1문항');
  await page.screenshot({ path: `test-results/rounds-list-${info.project.name}.png` });
  await r1.getByTestId('round-study').click();                               // 이어 풀기 → 3번부터
  await expect(page.getByTestId('progress')).toHaveText('3 / 4');
  for (const n of ['3번', '4번']) {
    await page.getByRole('button', { name: n }).click();
    await page.getByRole('button', { name: /다음 →|성적 보기/ }).click();
  }
  await expect(page.getByTestId('result')).toContainText('4/4문항');
  await page.getByTestId('result-rounds').click();
  await expect(page.getByTestId('round-TEST-2022-1')).toContainText('다 풂');
});

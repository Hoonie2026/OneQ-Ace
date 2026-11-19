/**
 * 정답 미지정 문항(2026-11-17 사용자): 답할 때 정답을 묻는 창은 없다 — 그대로 채점(정답 미지정)하고,
 * 답한 뒤 [정답 지정하기](정답 미지정)·[정답 고치기](정답 확인 필요·내가 지정)를 누르고 보기 번호를 눌러 정한다.
 * 한 번 지정하면 다음부터 [정답 고치기]로, 안내 모양은 하나로.
 */
import { expect, test } from './fixtures';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePack } from '../src/test/makePack';

test('정답 미지정: 창 없이 기록 → [정답 지정하기] → 보기 번호 → 채점, 이후 [정답 고치기]', async ({ page }, info) => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), 'oneq-ans-'));
  const path = join(dir, 'oneq-TEST-2022-1.zip');
  writeFileSync(path, await makePack({ questions: [
    { hash: 'm1', text: '정답 없는 문항 ① 가 ② 나 ③ 다 ④ 라', answer: null, flags: ['answer-missing'] },
    { hash: 'm2', text: '정답 확인 필요 문항 ① 가 ② 나 ③ 다 ④ 라', answer: 2, flags: ['answer-unsure'] },
  ] }));
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(path);
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('go-subjects').click();
  await page.getByTestId('subject-study').first().click();
  await page.getByRole('button', { name: '3번' }).click();
  await expect(page.getByTestId('dialog')).toHaveCount(0);                       // 창 없음
  const fb = page.getByTestId('feedback');
  await expect(fb).toContainText('정답 미지정');
  await expect(fb).toContainText('내 답 ③');
  await expect(page.getByTestId('answer-missing')).toBeVisible();
  await expect(page.getByTestId('fix-answer')).toHaveText('정답 지정하기');
  await page.getByTestId('fix-answer').click();
  await expect(page.getByTestId('pick-note')).toBeVisible();
  await page.screenshot({ path: `test-results/answer-pick-${info.project.name}.png` });
  await page.getByRole('button', { name: '3번' }).click();
  await expect(fb).toContainText('✓ 정답');
  await expect(fb).toContainText('정답 ③');
  await expect(page.getByTestId('user-answer')).toBeVisible();
  await expect(page.getByTestId('fix-answer')).toHaveText('정답 고치기');
  await page.screenshot({ path: `test-results/answer-set-${info.project.name}.png` });
  // 정답 확인 필요 문항: 같은 모양의 안내, [정답 고치기]
  await page.getByRole('button', { name: '다음 →' }).click();
  await page.getByRole('button', { name: '1번' }).click();
  await expect(page.getByTestId('feedback')).toContainText('✕ 오답');
  await expect(page.getByTestId('answer-unsure')).toBeVisible();
  await expect(page.getByTestId('fix-answer')).toHaveText('정답 고치기');
  await page.getByTestId('fix-answer').click();
  await page.getByRole('button', { name: '1번' }).click();
  await expect(page.getByTestId('feedback')).toContainText('✓ 정답');
  await expect(page.getByTestId('user-answer')).toBeVisible();
  await page.screenshot({ path: `test-results/answer-fixed-${info.project.name}.png` });
});

test('스캔본 같은 문항(ADR 031): 정답 미지정이면 다른 회차 같은 문항의 정답을 참고로 보여 주고 그 문항을 열어 비교', async ({ page }, info) => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), 'oneq-ocr-'));
  const p1 = join(dir, 'oneq-TEST-2022-1.zip');
  const p2 = join(dir, 'oneq-TEST-2022-2.zip');
  writeFileSync(p1, await makePack({ round: 1, questions: [
    { hash: 'o1', text: '96, 레일의(부실시 레일길이가25m이•고 레일온도가20℃일 경우 레일!e이음매 유간의 표준은? ① 가. 4mm나. 5mm다, 6mrn라. 7mm', answer: 3, flags: ['ocr'] },
  ] }));
  writeFileSync(p2, await makePack({ round: 2, questions: [
    { hash: 'o2', text: '92.레일의 부설시 레일길이가25m이고 레일은도가 20℃일 경우 레일 이음매 유간의 표준은? ㉦4mm 5mm 6mm .@7mm', answer: null, flags: ['ocr', 'answer-missing'] },
  ] }));
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles([p1, p2]);
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('go-rounds').click();
  await page.getByTestId('round-study').first().click();                      // 2022년 2회(정답 미지정)
  await expect(page.getByTestId('freq-badge')).toContainText('2회 출제');     // OCR 글자가 달라도 같은 문항으로 묶임
  await page.getByRole('button', { name: '2번' }).click();
  const ref = page.getByTestId('ref-answer');
  await expect(ref).toContainText('2022년 1회');
  await expect(ref).toContainText('③');
  await page.getByTestId('ref-answer-toggle').click();
  await expect(ref.locator('img')).toBeVisible();
  await page.screenshot({ path: `test-results/answer-ref-${info.project.name}.png`, fullPage: true });
  // 정답은 학습자가 정한다 — 자동으로 옮기지 않음
  await expect(page.getByTestId('fix-answer')).toHaveText('정답 지정하기');
});

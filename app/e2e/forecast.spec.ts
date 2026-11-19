/** 시험일 예상 점수(v0.20): 과목마다 처음 푼 문항 10개가 쌓이면 "측정 전" → 점수·과목별 표·산식 */
import { expect, test } from './fixtures';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePack } from '../src/test/makePack';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('예상 점수: 기록이 모자라면 측정 전, 과목마다 10문항을 풀면 표시', async ({ page }) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'oneq-fc-'));
  const path = join(dir, 'oneq-TEST-2022-1.zip');
  const qs = Array.from({ length: 48 }, (_, i) => ({ hash: `f${i}`, answer: 1, subjectNo: Math.floor(i / 12) + 1, text: `${i + 1}. 철도 궤도 구조 문항 번호 ${i} 에 대한 설명으로 옳은 것은? ① 가 ② 나 ③ 다 ④ 라` }));
  writeFileSync(path, await makePack({ questions: qs, subjectNames: { 1: '철도공학', 2: '측량학', 3: '응용역학', 4: '철도보선관계법규' } }));
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(path);
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('plan-open').click();
  const exam = new Date();
  exam.setDate(exam.getDate() + 73);
  await page.getByTestId('plan-exam-date').fill(ymd(exam));
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('projected-avg')).toHaveText('측정 전');
  await expect(page.getByTestId('forecast-open')).toContainText('40문항 더 풀면 표시');

  for (let k = 0; k < 4; k++) {
    let done = 0;
    while (done < 10) {
      await page.getByTestId('go-subjects').click();
      await page.getByTestId('subject-study').nth(k).click();
      while (done < 10) {
        await page.getByRole('button', { name: '1번' }).click();
        await expect(page.getByTestId('feedback')).toContainText('정답');
        done++;
        const next = page.getByRole('button', { name: '다음 →' });
        if (!(await next.isVisible())) break;
        await next.click();
      }
      await page.goto('./');
      await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
    }
  }
  await expect(page.getByTestId('projected-avg')).toHaveText(/^\d+(\.\d)?$/);
  await page.getByTestId('forecast-open').click();
  await expect(page.getByTestId('forecast-need')).toContainText('충족');
  await expect(page.getByTestId('forecast-table')).toContainText('철도공학');
  await expect(page.getByTestId('forecast-ceiling')).toContainText('최고');
  await expect(page.getByTestId('forecast-basis')).toContainText('계산 근거');
  await expect(page.getByTestId('forecast-view')).not.toContainText('측량 기출');
  await page.screenshot({ path: 'test-results/forecast-measured.png', fullPage: true });
});

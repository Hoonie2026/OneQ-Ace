/**
 * 5단계 흐름 시뮬레이션(모바일 에뮬레이션, ADR 008 개편 후): 학습 계획 → 홈(현재 → 시험일 예상, 합격 가능성)
 * → 과목별 학습 15문항(오늘 추천 과목) → 틀린 문항 다시·이 과목 계속 → 모의고사(정답 숨김·타이머와 제출 분리) → 성적 이력.
 * 화면 사진은 test-results/stage5-*.png
 */
import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makePack } from '../src/test/makePack';

const SAMPLE = resolve(import.meta.dirname, '../../packs/oneq-SURVEY-2022-1.zip');

async function packFile(): Promise<string> {
  if (existsSync(SAMPLE)) return SAMPLE;
  const dir = mkdtempSync(join(tmpdir(), 'oneq-'));
  const path = join(dir, 'oneq-TEST-2022-1.zip');
  const qs = Array.from({ length: 100 }, (_, i) => ({ hash: `q${i}`, answer: (i % 4) + 1, subjectNo: Math.floor(i / 20) + 1 }));
  writeFileSync(path, await makePack({ questions: qs }));
  return path;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('5단계: 학습 계획 → 과목별 학습 → 모의고사', async ({ page }, info) => {
  page.on('dialog', (dlg) => dlg.accept());
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(await packFile());
  await expect(page.getByText(/문제팩 1회차/)).toBeVisible({ timeout: 30_000 });

  // 회차별 풀이는 없고, 과목별·모의고사 두 가지
  await expect(page.getByTestId('tab-subjects')).toBeVisible();
  await expect(page.getByTestId('pack-solve')).toHaveCount(0);
  await expect(page.getByTestId('current-avg')).toHaveText('0'); // 안 푼 문항 0점

  // 학습 계획: 시험일 14일 뒤, 하루 30분
  await page.getByTestId('plan-open').click();
  const exam = new Date();
  exam.setDate(exam.getDate() + 14);
  await page.getByTestId('plan-exam-date').fill(ymd(exam));
  await page.getByTestId('plan-daily').selectOption('30');
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('dday')).toHaveText('D-14');
  await expect(page.getByTestId('projected-avg')).toBeVisible();
  await expect(page.getByTestId('outlook')).toHaveAttribute('data-status', 'unknown');
  await expect(page.locator('.rec-badge')).toHaveCount(1);

  // 과목별 학습(오늘 추천 과목): 15문항, 정답 바로 표시, 한 과목만
  const rec = page.locator('.subject.is-rec');
  const subjectName = (await rec.locator('.subject-head b').textContent())!;
  await rec.getByTestId('subject-study').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 15');
  for (let k = 0; k < 15; k++) {
    const before = await page.getByTestId('progress').textContent();
    await expect(page.locator('.solve-meta span')).toContainText(subjectName);
    await page.getByRole('button', { name: k % 3 ? '모름' : `${(k % 4) + 1}번` }).click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    await page.getByRole('button', { name: /^(다음 →|성적 보기)$/ }).click();
    if (k < 14) await expect(page.getByTestId('progress')).not.toHaveText(before!);
  }
  await expect(page.getByTestId('result')).toContainText('15/15문항 풀이');
  await expect(page.getByTestId('today-next')).toHaveText('이 과목 계속(다음 15문항)');
  await page.screenshot({ path: `test-results/stage5-result-${info.project.name}.png`, fullPage: true });
  await page.getByTestId('retry-wrong').click();
  await expect(page.getByTestId('progress')).toContainText('1 /');
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await expect(page.getByTestId('today-resume')).toBeVisible();
  await expect(page.getByTestId('week-goal')).toContainText('15 /');
  await expect(page.getByTestId('pack-seen')).toContainText('풀어 본 문항 15/100');
  await expect(page.getByTestId('current-avg')).not.toHaveText('0');
  await page.screenshot({ path: `test-results/stage5-home-${info.project.name}.png`, fullPage: true });

  // 모의고사: 정답 숨김, 타이머와 제출 버튼이 따로
  await page.getByTestId('tab-mock').click();
  await page.getByTestId('mock-start').click();
  await expect(page.getByTestId('mock-timer')).toHaveText(/남은 시간 2:(2\d|30):\d\d/);
  await expect(page.getByTestId('mock-submit')).toHaveText('제출');
  for (let k = 0; k < 5; k++) {
    await expect(page.getByTestId('progress')).toHaveText(`${k + 1} / 100`);
    await page.getByRole('button', { name: `${(k % 4) + 1}번` }).click();
    await expect(page.getByTestId('feedback')).toBeHidden();
  }
  await page.screenshot({ path: `test-results/stage5-mock-${info.project.name}.png` });
  await page.getByTestId('mock-submit').click(); // 확인 창은 수락
  await expect(page.getByRole('heading', { name: '모의고사 결과' })).toBeVisible();
  await expect(page.getByTestId('result')).toContainText('5/100문항 풀이');
  await expect(page.locator('.verdict')).toBeVisible();
  await page.getByRole('button', { name: '홈으로' }).click();
  await page.getByTestId('tab-mock').click();
  await expect(page.getByTestId('mock-history').locator('tbody tr')).toHaveCount(1);
});

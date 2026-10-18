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

test('5단계: 학습 계획 → 오늘 학습(계획량 한 묶음·틀린 문항 한 번 더) → 마치기 → 과목 골라서 → 모의고사(멈춤)', async ({ page }, info) => {
  page.on('dialog', (dlg) => dlg.accept());
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(await packFile());
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });

  // 홈(ADR 010): 시험일 | D-day / 현재 점수 | 시험일 예상 점수 / 오늘 학습 / 다른 방법(과목 골라서·모의고사)
  await expect(page.getByTestId('pack-solve')).toHaveCount(0);
  await expect(page.getByTestId('current-avg')).toHaveText('0'); // 안 푼 문항 0점
  await expect(page.getByTestId('plan-open')).toContainText('학습계획 설정 및 재설정');
  await expect(page.getByTestId('subject-list')).toHaveCount(0); // 과목 목록은 "과목별 학습"에서

  // 학습 계획: 시험일 14일 뒤, 하루 30분(= 20문항)
  await page.getByTestId('plan-open').click();
  const exam = new Date();
  exam.setDate(exam.getDate() + 14);
  await page.getByTestId('plan-exam-date').fill(ymd(exam));
  await page.getByTestId('plan-daily').selectOption('30');
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('dday')).toHaveText('D-14');
  await expect(page.getByTestId('projected-avg')).not.toHaveText('—');
  await expect(page.getByTestId('plan-warn')).toBeVisible(); // 시험일 예상 70점 미만 → 계획 수정 필요
  await expect(page.getByTestId('today-plan')).toHaveText('30분 · 20문항');
  await expect(page.getByTestId('plan-open')).toBeVisible();
  await page.screenshot({ path: `test-results/stage5-home0-${info.project.name}.png`, fullPage: true });

  // 시스템 추천 학습: 무엇을 왜 푸는지 안내 → 학습 시작(계획량 20문항 한 묶음) → 끝나면 틀린·모름 한 번 더 → 성적
  await page.getByTestId('go-recommend').click();
  await expect(page.getByTestId('today-what')).toContainText('새 문항');
  await page.screenshot({ path: `test-results/stage5-recommend-${info.project.name}.png`, fullPage: true });
  await expect(page.getByTestId('today-start')).toHaveText('학습 시작 (20문항)');
  await page.getByTestId('today-start').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 20');
  let relearned = false;
  for (let k = 0; k < 60; k++) {
    const before = await page.getByTestId('progress').textContent();
    await page.getByRole('button', { name: k % 3 ? '모름' : `${(k % 4) + 1}번` }).click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    const last = (await page.getByRole('button', { name: /^(다음 →|성적 보기)$/ }).textContent()) === '성적 보기';
    await page.getByRole('button', { name: /^(다음 →|성적 보기)$/ }).click();
    if (last) {
      if (!relearned) {
        await expect(page.getByText('방금 틀린·모름 문항 한 번 더')).toBeVisible();
        relearned = true;
        continue;
      }
      break;
    }
    await expect(page.getByTestId('progress')).not.toHaveText(before!);
  }
  await expect(page.getByTestId('result')).toBeVisible();
  await expect(page.getByTestId('finish-day')).toHaveText('오늘 학습 마치기');
  await expect(page.getByTestId('today-next')).toHaveText('계속 학습하기');
  await page.screenshot({ path: `test-results/stage5-result-${info.project.name}.png`, fullPage: true });

  // 오늘 학습 마치기: 현재 ☞ 시험일 예상 + 계획을 고칠지
  await page.getByTestId('finish-day').click();
  await expect(page.getByTestId('day-summary')).toBeVisible();
  await expect(page.getByTestId('summary-verdict')).toBeVisible();
  await page.screenshot({ path: `test-results/stage5-summary-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: '그대로 두고 마치기' }).click();
  await expect(page.getByTestId('week-goal')).toContainText('완료');
  await page.getByTestId('go-recommend').click();
  await expect(page.getByTestId('recommend')).toContainText('오늘 목표 완료 · 추가 학습');
  await page.getByRole('button', { name: '홈으로' }).click();
  await expect(page.getByTestId('current-avg')).not.toHaveText('0');
  await page.screenshot({ path: `test-results/stage5-home-${info.project.name}.png`, fullPage: true });

  // 과목별 학습: 과목마다 현재 ☞ 시험일 예상, 풀이 횟수, 학습하기
  await page.getByTestId('go-subjects').click();
  await expect(page.getByTestId('subject-list')).toContainText('풀이');
  await page.screenshot({ path: `test-results/stage5-subjects-${info.project.name}.png`, fullPage: true });
  await page.getByTestId('subject-study').first().click();
  await expect(page.getByTestId('progress')).toContainText('1 /');
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await expect(page.getByTestId('today-resume')).toBeVisible();

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
  // ✕로 나가면 남은 시간이 멈춘다(Q6): 3초 기다렸다 이어서 열어도 거의 그대로
  const left1 = (await page.getByTestId('mock-timer').textContent())!;
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await page.waitForTimeout(3000);
  await page.getByTestId('tab-mock').click();
  await page.getByTestId('mock-resume').click();
  const toSec = (t: string) => t.match(/(\d+):(\d\d):(\d\d)/)!.slice(1).map(Number).reduce((a, b) => a * 60 + b, 0);
  expect(toSec(left1) - toSec((await page.getByTestId('mock-timer').textContent())!)).toBeLessThanOrEqual(2);
  await page.getByTestId('mock-submit').click(); // 확인 창은 수락
  await expect(page.getByRole('heading', { name: '모의고사 결과' })).toBeVisible();
  await expect(page.getByTestId('result')).toContainText('5/100문항 풀이');
  await expect(page.locator('.verdict')).toBeVisible();
  await page.getByRole('button', { name: '홈으로' }).click();
  await page.getByTestId('tab-mock').click();
  await expect(page.getByTestId('mock-history').locator('tbody tr')).toHaveCount(1);
});

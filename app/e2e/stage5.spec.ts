/**
 * 5단계 흐름 시뮬레이션(모바일 에뮬레이션, ADR 008 개편 후): 학습 계획 → 홈(현재 → 시험일 예상)
 * → 과목별 학습 15문항(오늘 추천 과목) → 틀린 문항 다시·이 과목 계속 → 모의고사(정답 숨김·타이머와 제출 분리) → 성적 이력.
 * 화면 사진은 test-results/stage5-*.png
 */
import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makePack } from '../src/test/makePack';

/** 화면 전체 사진. 아이폰 크기(화소 3배)에서 아주 긴 화면은 브라우저 한도를 넘어 실패하므로 그때는 보이는 부분만 */
async function shot(page: import('@playwright/test').Page, path: string) {
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    await page.screenshot({ path });
  }
}

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

test('5단계: 학습 계획 → 오늘 학습(계획량 한 묶음·틀린 문항 한 번 더) → 오늘 기록 → 과목 골라서(안내창) → 모의고사(멈춤)', async ({ page }, info) => {
  page.on('dialog', (dlg) => dlg.accept());
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(await packFile());
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });

  // 홈(ADR 010): 시험일 | D-day / 현재 점수 | 시험일 예상 점수 / 오늘 학습 / 다른 방법(과목 골라서·모의고사)
  await expect(page.getByTestId('pack-solve')).toHaveCount(0);
  await expect(page.getByTestId('current-avg')).toHaveText('—'); // v0.11: 푼 문항이 없으면 점수 없음(푼 문항 중 정답 비율)
  await expect(page.getByTestId('current-basis')).toHaveText('문제를 풀면 표시');
  await expect(page.getByTestId('plan-open')).toContainText('학습계획 설정(재설정)');
  await expect(page.getByTestId('plan-open')).not.toContainText('›');
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
  await expect(page.getByTestId('plan-warn')).toHaveCount(0); // v0.8.1: 배지 없음, 점수 색만(60 미만 빨강)
  await expect(page.locator('.score-box.bad')).toBeVisible();
  await expect(page.getByTestId('today-plan')).toHaveText('30분 · 20문항');
  await expect(page.getByTestId('plan-open')).toBeVisible();
  await shot(page, `test-results/stage5-home0-${info.project.name}.png`);

  // v0.8.0(ADR 014): 예상 점수 계산 보기 → 학습 원리(근거 문헌) → 홈
  await page.getByTestId('forecast-open').click();
  await expect(page.getByTestId('forecast-view')).toBeVisible();
  await expect(page.getByTestId('forecast-table')).toContainText('과목');
  await expect(page.getByTestId('forecast-avg')).toContainText('평균(홈 점수)');
  await expect(page.getByTestId('forecast-view')).not.toContainText('계획과 실제 학습량');
  await expect(page.getByTestId('forecast-ceiling')).toContainText('최고');
  await expect(page.getByTestId('forecast-basis')).toContainText('계산 근거');
  await expect(page.getByTestId('forecast-error')).toContainText('가정값');
  await expect(page.getByTestId('forecast-view')).not.toContainText('합격 가능성');
  await shot(page, `test-results/stage5-forecast-${info.project.name}.png`);
  await page.getByTestId('back-home').click();
  await page.getByTestId('principles-open').click();
  await expect(page.getByTestId('principles')).toContainText('간격 반복');
  await expect(page.getByTestId('principles')).toContainText('Roediger & Karpicke');
  await shot(page, `test-results/stage5-principles-${info.project.name}.png`);
  await page.getByTestId('back-home').click();

  // 시스템 추천 학습: 무엇을 왜 푸는지 안내 → 학습 시작(계획량 20문항 한 묶음) → 목표를 채우면 "오늘 학습 목표 달성" 상자(v0.7.1)
  await page.getByTestId('go-recommend').click();
  await expect(page.getByTestId('today-what')).toContainText('새 문항');
  await expect(page.getByTestId('rec-count')).toContainText('30분 ÷ 문항당 1분 30초 = 20문항');
  await expect(page.getByTestId('rec-subjects')).toBeVisible();
  await page.getByTestId('rec-why').locator('summary').click();
  await expect(page.getByTestId('rec-why')).toContainText('복습은 최대 60%');
  await shot(page, `test-results/stage5-recommend-${info.project.name}.png`);
  await expect(page.getByTestId('today-start')).toHaveText('학습 시작 (20문항)');
  await page.getByTestId('today-start').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 20');
  // 풀이 중 성적 보기 → ‹ 는 이 풀이로 돌아온다(v0.8.4)
  await page.getByRole('button', { name: '지금 성적 보기' }).click();
  await page.getByTestId('result-back').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 20');
  for (let k = 0; k < 20; k++) {
    await expect(page.getByTestId('progress')).toHaveText(`${k + 1} / 20`);
    await page.getByRole('button', { name: k % 3 ? '모름' : `${(k % 4) + 1}번` }).click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    await page.getByRole('button', { name: /^(다음 →|성적 보기)$/ }).click();
  }
  // 목표 달성 상자: 푼 문항·정답·오답·모름·성적 → 계속 학습하기(오늘 기록으로 다시 추천 — 틀린·모름 문항부터)
  await expect(page.getByTestId('goal-box')).toBeVisible();
  await expect(page.getByTestId('goal-box')).toContainText('20');
  await shot(page, `test-results/stage5-goal-${info.project.name}.png`);
  await expect(page.getByTestId('goal-continue')).toContainText('오답/모름');
  await page.getByTestId('goal-continue').click();
  // 계속 → 먼저 틀린·모름 "다시 풀기"(주황 띠·다시 풀기 n/m — v0.7.2)
  await expect(page.getByTestId('relearn-banner')).toContainText('다시 풀기 · 1 /');
  await expect(page.getByTestId('relearn-banner')).toContainText('새 문항이 아닙니다');
  await page.screenshot({ path: `test-results/stage5-relearn-${info.project.name}.png` });
  await expect(page.getByTestId('progress')).toContainText('1 /');
  await page.getByRole('button', { name: '1번' }).click();
  // v0.11(ADR 020): ✕는 묻지 않고 홈으로 — "이어서 학습"·"오늘 학습 마치기" 없음, 홈 단추는 늘 시스템 추천 학습(오늘 남은 목표)
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await expect(page.getByTestId('dialog')).toHaveCount(0);
  await expect(page.getByTestId('today-resume')).toHaveCount(0);
  await expect(page.getByTestId('finish-day')).toHaveCount(0);
  await expect(page.getByTestId('go-recommend-sub')).toHaveText('오늘 목표 완료 · 추가 학습');
  await expect(page.getByTestId('current-basis')).toContainText('문항 중 정답');

  // 오늘 기록 보기(보기만 — 묶음을 닫는 일 없음)
  await page.getByTestId('day-log').click();
  await expect(page.getByTestId('day-summary')).toBeVisible();
  await expect(page.getByRole('heading', { name: '오늘 학습 기록' })).toBeVisible();
  await expect(page.getByTestId('summary-verdict')).toBeVisible();
  await shot(page, `test-results/stage5-summary-${info.project.name}.png`);
  await page.getByTestId('summary-home').click();
  await expect(page.getByTestId('go-recommend')).toBeVisible();
  await expect(page.getByTestId('week-goal')).toContainText('완료');
  await page.getByTestId('go-recommend').click();
  await expect(page.getByTestId('recommend')).toContainText('오늘 목표 완료 · 추가 학습');
  await page.getByRole('button', { name: '홈으로' }).click();
  await expect(page.getByTestId('current-avg')).not.toHaveText('0');
  await shot(page, `test-results/stage5-home-${info.project.name}.png`);

  // 과목별 학습(v0.11): 안내문 대신 막대 안내창 — 누르면(마우스는 올리면) 그 과목 설명, 바깥을 누르면 닫힘
  await page.getByTestId('go-subjects').click();
  await expect(page.getByTestId('subject-list')).toContainText('푼 ');
  await expect(page.getByTestId('subject-tip')).toHaveCount(0);
  await page.getByTestId('subject-bar-hit').first().click();
  await expect(page.getByTestId('subject-tip')).toHaveCount(1);
  await expect(page.getByTestId('subject-tip')).toContainText('막대 = 현재 점수');
  await expect(page.getByTestId('subject-tip')).toContainText('과락선');
  await shot(page, `test-results/stage5-subjects-${info.project.name}.png`);
  await page.getByRole('heading', { name: '과목별 학습' }).click();
  await expect(page.getByTestId('subject-tip')).toHaveCount(0);
  await page.getByTestId('subject-study').first().click();
  await expect(page.getByTestId('progress')).toContainText('1 /');
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await expect(page.getByTestId('go-recommend')).toBeVisible();

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
  await expect(page.getByTestId('dialog')).toContainText('모의고사를 멈출까요?'); // v0.9.0
  await page.screenshot({ path: `test-results/stage5-mock-exit-${info.project.name}.png` });
  await page.getByTestId('dialog-choice-pause').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('tab-mock').click();
  await page.getByTestId('mock-resume').click();
  const toSec = (t: string) => t.match(/(\d+):(\d\d):(\d\d)/)!.slice(1).map(Number).reduce((a, b) => a * 60 + b, 0);
  expect(toSec(left1) - toSec((await page.getByTestId('mock-timer').textContent())!)).toBeLessThanOrEqual(2);
  await page.getByTestId('mock-submit').click();
  // 앱 안 확인 창(v0.7.2): 주소가 아니라 제목·큰 글자, [계속 풀기] [제출]
  await expect(page.getByTestId('dialog')).toContainText('모의고사 제출');
  await expect(page.getByTestId('dialog')).not.toContainText('github');
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByRole('heading', { name: '모의고사 결과' })).toBeVisible();
  await expect(page.getByTestId('result')).toContainText('5/100문항 풀이');
  await expect(page.locator('.verdict')).toBeVisible();
  await page.getByRole('button', { name: '홈으로' }).click();
  await page.getByTestId('tab-mock').click();
  await expect(page.getByTestId('mock-history').locator('tbody tr')).toHaveCount(1);
});

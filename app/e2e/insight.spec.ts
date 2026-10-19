/**
 * 학습 점검 카드(ADR 014, 실기기 W6 — 하루 안에는 "3일 이상 계획보다 적게 푼" 상태를 만들 수 없어 자동 시험으로 확인).
 * 브라우저 시계를 앞당기며 사흘 동안 하루 5문항만 풀고(계획 하루 4시간) 나흘째 홈을 연다.
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
const DAY = 86_400_000;

test('학습 점검 카드: 사흘 동안 계획(하루 4시간)보다 훨씬 적게 풀면 "이 속도면" 예상과 필요 시간', async ({ page }, info) => {
  const t0 = new Date(2026, 10, 2, 9, 0, 0);
  await page.clock.install({ time: t0 });
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(await packFile());
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('plan-open').click();
  await page.getByTestId('plan-exam-date').fill(ymd(new Date(t0.getTime() + 30 * DAY)));
  await page.getByTestId('plan-daily').selectOption('240');
  await page.getByTestId('plan-save').click();

  for (let d = 0; d < 3; d++) {
    if (d > 0) {
      await page.clock.setSystemTime(new Date(t0.getTime() + d * DAY));
      await page.reload();
    }
    await page.getByTestId('go-recommend').click();
    await page.getByTestId('today-start').click();
    for (let k = 0; k < 12; k++) {
      await expect(page.getByTestId('feedback')).toBeHidden();
      await page.waitForTimeout(150); // 문항이 화면에 뜬 시각이 기록되도록
      await page.clock.runFor(60_000); // 문항당 1분 생각하고 답
      await page.getByRole('button', { name: k % 2 ? '모름' : `${(k % 4) + 1}번` }).click();
      await page.getByRole('button', { name: /^(다음 →|성적 보기)$/ }).click();
    }
    await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
    await page.getByTestId('dialog-choice-end').click(); // ✕ → 오늘 학습 마치기 → 요약(묶음 닫힘)
    await page.getByTestId('summary-home').click();
    await expect(page.getByTestId('go-recommend')).toBeVisible();
  }
  await page.clock.setSystemTime(new Date(t0.getTime() + 3 * DAY));
  await page.reload();
  await expect(page.getByTestId('insight-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('insight-pace')).toContainText('최근 3일 하루 평균');
  await expect(page.getByTestId('insight-pace')).not.toContainText('평균 0분');
  await expect(page.getByTestId('insight-atpace')).toContainText('이 속도면 시험일 예상');
  await expect(page.getByTestId('insight-card')).not.toContainText('합격 가능성');
  await page.screenshot({ path: `test-results/insight-${info.project.name}.png`, fullPage: true });
});

/**
 * 3단계 게이트 시뮬레이션(모바일 에뮬레이션). 실기기 확인을 대신하지 않고, 실기기 전에 흐름이 끊기지 않는지 본다.
 *  ① 팩 가져오기 → ② 비행기 모드(오프라인)에서 다시 열기 → ③ 과목별 학습 2세션(중간에 앱 종료·이어 풀기) → ④ 백업(다운로드)
 *  (5단계 개편 ADR 008로 회차별 풀이가 없어져 ③을 과목별 학습으로 바꿈)
 *  → ⑤ 앱 삭제(새 브라우저 저장소) → ⑥ 복원 → ⑦ 팩 다시 가져오기 → 기록 지문 100% 일치
 * 샘플팩 packs/oneq-SURVEY-2022-1.zip이 있으면 그것을, 없으면 시험용 100문항 팩을 만들어 쓴다.
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makePack } from '../src/test/makePack';

const SAMPLE = resolve(import.meta.dirname, '../../packs/oneq-SURVEY-2022-1.zip');

async function packFile(): Promise<{ path: string; total: number }> {
  if (existsSync(SAMPLE)) return { path: SAMPLE, total: 100 };
  const dir = mkdtempSync(join(tmpdir(), 'oneq-'));
  const path = join(dir, 'oneq-TEST-2022-1.zip');
  const qs = Array.from({ length: 100 }, (_, i) => ({ hash: `q${i}`, answer: (i % 4) + 1, subjectNo: Math.floor(i / 20) + 1 }));
  writeFileSync(path, await makePack({ questions: qs }));
  return { path, total: 100 };
}

/**
 * Chrome 150대(실기기 153, PC 155)는 scrollTo·scrollBy·scrollIntoView가 Promise를 돌려준다. 시험용 Chromium은 더 오래돼
 * undefined를 돌려주므로, 새 동작을 흉내 내 같은 종류의 회귀(2026-10-15 검은 화면)를 잡는다
 */
function newerChromeScroll() {
  for (const [obj, name] of [[window, 'scrollTo'], [window, 'scroll'], [window, 'scrollBy'], [Element.prototype, 'scrollTo'], [Element.prototype, 'scrollIntoView']] as const) {
    const orig = (obj as any)[name];
    (obj as any)[name] = function (...args: unknown[]) {
      orig.apply(this, args);
      return Promise.resolve();
    };
  }
}

async function waitForSW(page: Page) {
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active, null, { timeout: 30_000 });
  await page.reload(); // 서비스워커가 페이지를 제어하게
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
}

async function fingerprintText(page: Page): Promise<string> {
  await page.getByRole('button', { name: '백업·설정' }).click();
  await expect(page.getByTestId('fingerprint')).toHaveText(/지문 [0-9a-f]{8}/);
  return (await page.getByTestId('fingerprint').textContent())!;
}

test('3단계 게이트(5단계 개편 후): 오프라인 과목별 학습·이어 풀기 → 백업 → 삭제 → 복원 100% 일치', async ({ browser }, info) => {
  const { path: pack, total } = await packFile();
  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'allow', acceptDownloads: true });
  await ctx.addInitScript(newerChromeScroll);
  const page = await ctx.newPage();
  await page.goto('./');
  await waitForSW(page);

  // ① 팩 가져오기
  await page.getByTestId('pack-input').first().setInputFiles(pack);
  await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
  // 학습 계획: 하루 4시간(160문항) — 과목 학습 한 묶음 = 오늘 남은 목표(v0.7.2)라 과목 문항 수(20)만큼 나오게
  await page.getByTestId('plan-open').click();
  const exam = new Date();
  exam.setDate(exam.getDate() + 30);
  await page.getByTestId('plan-exam-date').fill(`${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, '0')}-${String(exam.getDate()).padStart(2, '0')}`);
  await page.getByTestId('plan-daily').selectOption('240');
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('today-plan')).toHaveText('4시간 · 160문항');

  // ② 비행기 모드에서 다시 열기
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('go-recommend')).toBeVisible();

  const imgOk = async () =>
    page.locator('.zoom-inner img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  /** 지금 화면의 문항 하나를 풀고 다음으로. 문항 위치 n(1부터)으로 답을 정한다 */
  const answerOne = async () => {
    await expect.poll(imgOk, { timeout: 10_000 }).toBe(true);
    const n = Number((await page.getByTestId('progress').textContent())!.split('/')[0]);
    if (n % 7 === 3) await page.getByRole('button', { name: '모름' }).click();
    else if (n % 11 === 5) {
      // [쉬움](v0.9.2): 보기 없이 정답 처리 → 정답 화면. 5번째 문항은 "모름으로 바꾸기"까지(백업·복원 지문에 쉬움·바꾼 기록이 함께 들어감)
      await page.getByTestId('easy').click();
      await expect(page.getByTestId('feedback')).toContainText('쉬움');
      if (n === 5) {
        await page.getByTestId('easy-undo').click();
        await expect(page.getByTestId('feedback')).toContainText('모름');
        await expect(page.getByTestId('easy-undo')).toHaveCount(0);
      }
    } else await page.getByRole('button', { name: `${(n % 4) + 1}번` }).click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    return n;
  };
  const nextBtn = () => page.getByRole('button', { name: /^(다음 →|성적 보기)$/ });
  /** 다음으로 넘기고, 화면이 실제로 바뀔 때까지 기다린다(이전 문항 번호를 읽고 답하는 시험 경합 방지). 마지막이면 true */
  const goNext = async () => {
    const before = await page.getByTestId('progress').textContent();
    const last = (await nextBtn().textContent()) === '성적 보기';
    await nextBtn().click();
    // 오늘 목표(하루 1시간 = 40문항)를 채우면 "오늘 학습 목표 달성" 상자 — 과목 학습은 계속하면 그 과목을 이어서(v0.7.1)
    if (await page.getByTestId('goal-box').isVisible()) {
      await expect(page.getByTestId('goal-box')).toContainText('오늘 학습 목표 달성');
      await page.getByTestId('goal-continue').click();
      if (last) {
        await expect(page.getByTestId('progress')).toContainText('1 /');
        return false; // 그 과목 새 묶음으로 이어짐
      }
    }
    if (last) {
      // 묶음 끝: 틀린 문항이 있으면 "한 번 더" 묶음으로 바로 이어지고(ADR 010), 없으면 성적
      await expect(page.getByTestId('result').or(page.getByTestId('relearn-banner'))).toBeVisible();
      return page.getByTestId('result').isVisible();
    }
    await expect(page.getByTestId('feedback')).toBeHidden();
    await expect(page.getByTestId('progress')).not.toHaveText(before!);
    return false;
  };
  const doneToday = async () => Number((await page.getByTestId('week-goal').textContent())!.match(/오늘 (\d+) \//)![1]);
  /** 과목 학습 한 묶음(그 과목 20문항 + 틀린 문항 한 번 더)을 끝까지. 첫 문항에서 확대·메모를 한 번 해 본다(v0.7: 헷갈림 없앰, 한 줄 설명 → 메모) */
  const studySession = async (nth: number, extras = false) => {
    await page.getByTestId('go-subjects').click();
    await page.getByTestId('subject-study').nth(nth).click();
    if (extras) {
      // v0.9.2: 풀기 전에는 모름 | 쉬움 — 웹검색은 답한 뒤에만
      await expect(page.getByTestId('easy')).toBeVisible();
      await expect(page.getByTestId('web-search')).toHaveCount(0);
    }
    for (let k = 0; k < 40; k++) {
      await answerOne();
      if (extras && k === 0) {
        await expect(page.getByTestId('search-after')).toBeVisible(); // 웹검색은 답한 뒤 화면에
        await page.getByTestId('zoom-box').dblclick(); // 더블탭 확대 → 원래대로
        await expect(page.getByRole('button', { name: '원래 크기로' })).toBeVisible();
        await page.getByRole('button', { name: '원래 크기로' }).click();
        await expect(page.getByRole('button', { name: /헷갈림/ })).toHaveCount(0);
        await page.getByTestId('memo-btn').click();
        await page.getByPlaceholder(/메모해 두세요/).fill('시험용 메모');
      }
      if (await goNext()) break;
    }
    await expect(page.getByTestId('result')).toBeVisible();
    await page.getByRole('button', { name: '뒤로' }).click();
  };

  // ③-1 과목 골라서 학습(ADR 008·010): 1과목 15문항 + 틀린 문항 한 번 더(확대·헷갈림·메모 포함)
  await studySession(0, true);
  const n1 = await doneToday();
  expect(n1).toBeGreaterThanOrEqual(15);

  // ③-2 다른 과목을 7문항 풀다 ✕ → 앱 종료·다시 열기(오프라인) → 그 과목을 다시 고르면 남은 문항으로 새 묶음(v0.11 — "이어서 학습" 없음)
  await page.getByTestId('go-subjects').click();
  await expect(page.getByTestId('subject-study').nth(1)).toHaveText('학습하기 (20문항)'); // 오늘 남은 목표 vs 그 과목 낼 문항(20)
  await page.getByTestId('subject-study').nth(1).click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 20');
  for (let k = 0; k < 7; k++) {
    await answerOne();
    await goNext();
  }
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await expect(page.getByTestId('dialog')).toHaveCount(0); // ✕는 묻지 않고 홈으로(답은 이미 저장)
  await page.reload();
  await expect(page.getByTestId('go-recommend')).toBeVisible();
  await expect(page.getByTestId('today-resume')).toHaveCount(0);
  await page.getByTestId('go-subjects').click();
  await page.getByTestId('subject-study').nth(1).click();
  await expect(page.getByTestId('progress')).toContainText('1 /');
  for (let guard = 0; guard < 40; guard++) {
    await answerOne();
    if (await goNext()) break;
  }
  await expect(page.getByRole('heading', { name: '풀이 결과' })).toBeVisible();
  const counts = await page.locator('.rc b').allTextContents();
  expect(counts.map(Number).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '뒤로' }).click();
  const solved = await doneToday(); // 풀이 기록 수(한 번 더 푼 것 포함)
  expect(solved).toBeGreaterThanOrEqual(n1 + 20);

  // ④ 백업(다운로드)
  const before = await fingerprintText(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /백업 파일 저장/ }).click()]);
  const backupPath = join(mkdtempSync(join(tmpdir(), 'oneq-bk-')), dl.suggestedFilename());
  await dl.saveAs(backupPath);
  expect(dl.suggestedFilename()).toMatch(/^oneq-backup-\d{8}\.json$/);
  expect(JSON.parse(readFileSync(backupPath, 'utf8')).attempts).toHaveLength(solved);
  await ctx.close();

  // ⑤ 앱 삭제 = 저장소가 빈 새 컨텍스트, ⑥ 복원
  const ctx2 = await browser.newContext({ ...info.project.use, serviceWorkers: 'allow' });
  await ctx2.addInitScript(newerChromeScroll);
  const p2 = await ctx2.newPage();
  await p2.goto('./');
  await expect(p2.getByText('문제팩을 가져오세요')).toBeVisible();
  await p2.getByRole('button', { name: '백업·설정' }).click();
  p2.on('dialog', (d) => d.accept());
  await p2.getByTestId('restore-input').setInputFiles(backupPath);
  await p2.getByTestId('dialog-ok').click(); // 앱 안 확인 창(v0.7.2)
  await expect(p2.getByTestId('restore-report')).toContainText('백업과 기록 일치');
  await expect(p2.getByTestId('restore-report')).toContainText(`매핑 대기 ${solved + 1}건`); // 풀이 30 + 메모 1
  expect(await p2.getByTestId('fingerprint').textContent()).toBe(before);

  // ⑦ 팩 다시 가져오기 → 매핑 대기 0, 지문 그대로, 진도 100%
  await p2.getByRole('button', { name: '뒤로' }).click();
  await p2.getByTestId('pack-input').first().setInputFiles(pack);
  await expect(p2.getByText(new RegExp(`기록 ${solved + 1}건 이어짐`))).toBeVisible({ timeout: 30_000 });
  await expect(p2.getByTestId('week-goal')).toContainText(`오늘 ${solved} /`);
  expect(await fingerprintText(p2)).toBe(before);
  await expect(p2.locator('.diag')).toContainText('매핑 대기 0건');

  // 같은 팩을 다시 고르면 건너뛰고, 다른 종목 팩을 넣으면 종목 선택이 생긴다(문제팩 관리는 설정 화면 — ADR 009)
  await expect(p2.getByTestId('pack-section')).toContainText('문제팩 1회차');
  await p2.getByTestId('pack-section').getByTestId('pack-input').setInputFiles(pack);
  await expect(p2.getByText(/같은 팩 1개는 건너뜀/)).toBeVisible();
  const dir = mkdtempSync(join(tmpdir(), 'oneq-cert-'));
  const other = join(dir, 'oneq-TEST-2022-1.zip');
  writeFileSync(other, await makePack({ questions: [{ hash: 'x' }, { hash: 'y' }] }));
  await p2.getByTestId('pack-section').getByTestId('pack-input').setInputFiles(other);
  await expect(p2.getByTestId('pack-section')).toContainText('문제팩 2회차');
  await p2.getByRole('button', { name: '뒤로' }).click();
  // 종목 선택은 드롭다운(v0.7)
  await expect(p2.getByTestId('cert-select')).toHaveValue('TEST');
  await expect(p2.getByTestId('cert-select').locator('option')).toHaveCount(2);

  // 학습 기록만 지우기 → 백업 복원 → 문제팩을 다시 가져오지 않아도 바로 이어짐(실기기 2차 요청)
  await p2.getByRole('button', { name: '백업·설정' }).click();
  await p2.getByTestId('wipe-records').click();
  await p2.getByTestId('wipe-cert').selectOption('*');
  await p2.getByTestId('wipe-records-go').click();
  await p2.getByTestId('dialog-ok').click();
  await p2.getByRole('button', { name: '뒤로' }).click();
  await expect(p2.getByTestId('week-goal')).toContainText('오늘 0 /');
  await p2.getByRole('button', { name: '백업·설정' }).click();
  await p2.getByTestId('restore-input').setInputFiles(backupPath);
  await p2.getByTestId('dialog-ok').click(); // 앱 안 확인 창(v0.7.2)
  await expect(p2.getByTestId('restore-report')).toContainText('백업과 기록 일치');
  await expect(p2.getByTestId('restore-report')).not.toContainText('매핑 대기');
  expect(await p2.getByTestId('fingerprint').textContent()).toBe(before);
  await p2.getByRole('button', { name: '뒤로' }).click();

  // 문제팩 지우기: 종목 하나의 문제팩 전체 = 종목 삭제(다른 종목은 그대로) → 모든 종목 지우기 → 빈 홈(가져오기 화면)
  await p2.getByRole('button', { name: '백업·설정' }).click();
  await p2.getByTestId('wipe').click();
  await p2.getByTestId('wipe-cert').selectOption('TEST');
  await p2.getByTestId('wipe-pick-all').check();
  await p2.getByTestId('wipe-packs-go').click();
  await p2.getByTestId('dialog-ok').click();
  await expect(p2.getByTestId('pack-section')).toContainText('문제팩 1회차');
  await p2.getByTestId('wipe-cert').selectOption('*');
  await p2.getByTestId('wipe-all-go').click();
  await p2.getByTestId('dialog-ok').click();
  await p2.getByTestId('dialog-ok').click();
  await expect(p2.getByText('문제팩을 가져오세요')).toBeVisible();
  await ctx2.close();
});

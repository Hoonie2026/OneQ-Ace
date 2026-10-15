/**
 * 3단계 게이트 시뮬레이션(모바일 에뮬레이션). 실기기 확인을 대신하지 않고, 실기기 전에 흐름이 끊기지 않는지 본다.
 *  ① 팩 가져오기 → ② 비행기 모드(오프라인)에서 다시 열기 → ③ 1회차 완주 → ④ 백업(다운로드)
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

test('3단계 게이트: 오프라인 1회차 완주(회차·과목별 혼합) → 백업 → 삭제 → 복원 100% 일치', async ({ browser }, info) => {
  const { path: pack, total } = await packFile();
  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'allow', acceptDownloads: true });
  await ctx.addInitScript(newerChromeScroll);
  const page = await ctx.newPage();
  await page.goto('./');
  await waitForSW(page);

  // ① 팩 가져오기
  await page.getByTestId('pack-input').first().setInputFiles(pack);
  await expect(page.getByText(/문제팩 1회차/)).toBeVisible({ timeout: 30_000 });

  // ② 비행기 모드에서 다시 열기
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByText(/문제팩 1회차/)).toBeVisible();

  const imgOk = async () =>
    page.locator('.zoom-inner img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  /** 지금 화면의 문항 하나를 풀고 다음으로. 문항 위치 n(1부터)으로 답을 정한다 */
  const answerOne = async () => {
    await expect.poll(imgOk, { timeout: 10_000 }).toBe(true);
    const n = Number((await page.getByTestId('progress').textContent())!.split('/')[0]);
    if (n % 7 === 3) await page.getByRole('button', { name: '모름' }).click();
    else await page.getByRole('button', { name: `${(n % 4) + 1}번` }).click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    return n;
  };
  const nextBtn = () => page.getByRole('button', { name: /^(다음 →|성적 보기)$/ });
  /** 다음으로 넘기고, 화면이 실제로 바뀔 때까지 기다린다(이전 문항 번호를 읽고 답하는 시험 경합 방지). 마지막이면 true */
  const goNext = async () => {
    const before = await page.getByTestId('progress').textContent();
    const last = (await nextBtn().textContent()) === '성적 보기';
    await nextBtn().click();
    if (last) await expect(page.getByTestId('result')).toBeVisible();
    else await expect(page.getByTestId('feedback')).toBeHidden();
    if (!last) await expect(page.getByTestId('progress')).not.toHaveText(before!);
    return last;
  };
  const homeProgress = (n: number) => expect(page.getByTestId('pack-progress')).toContainText(`진도 ${n}/${total}`);

  // ③-1 회차 전체로 30문항 → 나가기. 이어 풀기 버튼과 진도가 같은 숫자
  await page.getByTestId('pack-solve').click();
  for (let k = 0; k < 30; k++) {
    const n = await answerOne();
    if (n === 1) {
      await page.getByTestId('zoom-box').dblclick(); // 더블탭 확대 → 원래대로
      await expect(page.getByRole('button', { name: '원래 크기로' })).toBeVisible();
      await page.getByRole('button', { name: '원래 크기로' }).click();
      await page.getByRole('button', { name: /헷갈림/ }).click();
      await page.getByRole('button', { name: /한 줄 설명/ }).click();
      await page.getByPlaceholder(/한 줄 설명/).fill('시험용 메모');
    }
    await goNext();
  }
  await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  await homeProgress(30);
  await expect(page.getByTestId('pack-solve')).toHaveText(`이어 풀기 30/${total}`);

  // ③-2 과목별: 3과목 5문항, 5과목 2문항, 다시 3과목 → 초기화되지 않고 6번째부터
  const subject = async (no: number, count: number, expectStart: number, per: number) => {
    await page.getByRole('button', { name: '과목별' }).click();
    await page.getByRole('button', { name: new RegExp(`^${no}과목`) }).click();
    await expect(page.getByTestId('progress')).toHaveText(`${expectStart} / ${per}`);
    for (let k = 0; k < count; k++) {
      await answerOne();
      await goNext();
    }
    await page.getByRole('button', { name: '풀이 멈추고 홈으로' }).click();
  };
  await subject(3, 5, 1, total / 5);
  await subject(5, 2, 1, total / 5);
  await subject(3, 0, 6, total / 5);
  await homeProgress(37);

  // ③-3 앱 종료 → 다시 열기(오프라인) → 이어 풀기는 안 푼 첫 문항(31번), 중간 성적 확인
  await page.reload();
  await expect(page.getByTestId('resume')).toContainText(`37 / ${total}문항`);
  await page.getByRole('button', { name: '이어서 풀기' }).click();
  await expect(page.getByTestId('progress')).toHaveText(`31 / ${total}`);
  await page.getByRole('button', { name: '지금 성적 보기' }).click();
  await expect(page.getByRole('heading', { name: '지금까지 성적' })).toBeVisible();
  await expect(page.getByTestId('result')).toContainText(`37/${total}문항 풀이`);
  await page.getByRole('button', { name: /이어서 풀기/ }).click();

  // ③-4 끝까지(과목별로 푼 문항은 건너뜀)
  for (let guard = 0; guard < total; guard++) {
    await answerOne();
    if (await goNext()) break;
  }
  await expect(page.getByRole('heading', { name: '풀이 결과' })).toBeVisible();
  const counts = await page.locator('.rc b').allTextContents();
  expect(counts.map(Number).reduce((a, b) => a + b, 0)).toBe(total);
  await page.getByRole('button', { name: '홈으로' }).click();
  await homeProgress(total);

  // ④ 백업(다운로드)
  const before = await fingerprintText(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /백업 파일 저장/ }).click()]);
  const backupPath = join(mkdtempSync(join(tmpdir(), 'oneq-bk-')), dl.suggestedFilename());
  await dl.saveAs(backupPath);
  expect(dl.suggestedFilename()).toMatch(/^oneq-backup-\d{8}\.json$/);
  expect(JSON.parse(readFileSync(backupPath, 'utf8')).attempts).toHaveLength(total);
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
  await expect(p2.getByTestId('restore-report')).toContainText('백업과 기록 일치');
  await expect(p2.getByTestId('restore-report')).toContainText(`매핑 대기 ${total + 1}건`); // 풀이 100 + 메모 1
  expect(await p2.getByTestId('fingerprint').textContent()).toBe(before);

  // ⑦ 팩 다시 가져오기 → 매핑 대기 0, 지문 그대로, 진도 100%
  await p2.getByRole('button', { name: '뒤로' }).click();
  await p2.getByTestId('pack-input').first().setInputFiles(pack);
  await expect(p2.getByText(new RegExp(`기록 ${total + 1}건 이어짐`))).toBeVisible({ timeout: 30_000 });
  await expect(p2.getByText(`진도 ${total}/${total}`)).toBeVisible();
  expect(await fingerprintText(p2)).toBe(before);
  await expect(p2.locator('.diag')).toContainText('매핑 대기 0건');

  // 같은 팩을 다시 고르면 건너뛰고, 다른 종목 팩을 넣으면 종목 선택이 생긴다
  await p2.getByRole('button', { name: '뒤로' }).click();
  await p2.getByTestId('pack-input').first().setInputFiles(pack);
  await expect(p2.getByText(/같은 팩 1개는 건너뜀/)).toBeVisible();
  const dir = mkdtempSync(join(tmpdir(), 'oneq-cert-'));
  const other = join(dir, 'oneq-TEST-2022-1.zip');
  writeFileSync(other, await makePack({ questions: [{ hash: 'x' }, { hash: 'y' }] }));
  await p2.getByTestId('pack-input').first().setInputFiles(other);
  await expect(p2.getByRole('button', { name: /시험용 종목/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(p2.getByText(/문제팩 1회차/)).toBeVisible();
  await p2.getByRole('button', { name: /측량|시험용 종목/ }).first().click();

  // 이 기기 데이터 지우기(앱 삭제 대신 쓰는 경로)
  await p2.getByRole('button', { name: '백업·설정' }).click();
  await p2.getByTestId('wipe').click();
  await expect(p2.getByText('문제팩을 가져오세요')).toBeVisible();
  await ctx2.close();
});

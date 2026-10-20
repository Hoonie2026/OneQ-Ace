/**
 * 문제팩 가져오기 진행 창·지연 안내·그만 가져오기·중단 안내(v0.10.7, 태블릿 실사용 의견).
 * 시계를 멈춰(page.clock) 진행 창이 떠 있는 상태를 확인하고, 20초를 앞당겨 "오래 걸림" 안내를 확인한다.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makePack } from '../src/test/makePack';

async function packFiles(n: number): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'oneq-imp-'));
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const year = 2010 + k;
    const qs = Array.from({ length: 20 }, (_, i) => ({ hash: `y${year}q${i}`, answer: (i % 4) + 1, subjectNo: 1 }));
    const path = join(dir, `oneq-IMP-${year}-1.zip`);
    writeFileSync(path, await makePack({ code: 'IMP', year, questions: qs }));
    out.push(path);
  }
  return out;
}

test('가져오기 진행 창: 몇 번째/전체, 20초 넘으면 안내, 그만 가져오기 → 결과 창', async ({ page }) => {
  // 파일 읽기를 붙잡아 두는 문(시험 전용) — 느린 클라우드 파일을 흉내 낸다
  await page.addInitScript(() => {
    const orig = Blob.prototype.arrayBuffer;
    const w = window as unknown as { __gate: Promise<void>; __release: () => void };
    w.__gate = new Promise<void>((r) => (w.__release = r));
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      await w.__gate;
      return orig.call(this);
    };
  });
  await page.clock.install();
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(await packFiles(4));
  await expect(page.getByTestId('import-progress')).toBeVisible();
  await expect(page.getByTestId('import-count')).toHaveText('1 / 4');
  await expect(page.getByTestId('import-progress')).toContainText('파일 읽는 중');
  await expect(page.getByTestId('import-slow')).toHaveCount(0);
  await page.clock.fastForward(21_000);
  await expect(page.getByTestId('import-slow')).toContainText('시간이 오래 걸리고 있습니다');
  await page.getByTestId('import-stop').click();
  await expect(page.getByTestId('import-stop')).toHaveText('멈추는 중…');
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(page.getByTestId('dialog')).toContainText('문제팩 가져오기 결과', { timeout: 15_000 });
  await expect(page.getByTestId('dialog')).toContainText('1개를 새로 가져왔습니다');
  await expect(page.getByTestId('dialog')).toContainText('4개 중 1개까지 처리, 나머지 3개는 가져오지 않음');
  await expect(page.getByTestId('import-progress')).toHaveCount(0);
});

test('여러 개를 끝까지 가져오면 결과 창, 다시 고르면 같은 팩은 건너뜀', async ({ page }) => {
  await page.goto('./');
  const files = await packFiles(5);
  await page.getByTestId('pack-input').first().setInputFiles(files);
  await expect(page.getByTestId('dialog')).toContainText('5개를 새로 가져왔습니다', { timeout: 30_000 });
  await page.getByTestId('dialog-ok').click();
  // 팩이 있으면 가져오기 단추는 설정 화면에
  await page.getByRole('button', { name: '백업·설정' }).click();
  await page.getByTestId('pack-input').first().setInputFiles(files);
  await expect(page.getByTestId('dialog')).toContainText('이미 있는 같은 팩 5개는 건너뜀', { timeout: 30_000 });
});

test('파일 선택기를 연 채로 앱이 다시 시작되면 중단 안내', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => sessionStorage.setItem('oneq-import-pick', String(Date.now() - 60_000)));
  await page.reload();
  await expect(page.getByTestId('dialog')).toContainText('문제팩 가져오기가 중단됨');
  await expect(page.getByTestId('dialog')).toContainText('10개 이하로 나눠서');
  await page.getByTestId('dialog-ok').click();
  await page.reload();
  await expect(page.getByTestId('dialog')).toHaveCount(0); // 한 번만
});

test('v0.10.8: 35개 결과 창은 요약되고 [확인]이 화면 안에 있어 누를 수 있다', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(await packFiles(35));
  const dlg = page.getByTestId('dialog');
  await expect(dlg).toContainText('35개를 새로 가져왔습니다', { timeout: 60_000 });
  await expect(dlg).toContainText('35개 회차');
  await expect(page.getByTestId('dialog-ok')).toBeInViewport();
  await page.getByTestId('dialog-ok').click();
  await expect(dlg).toHaveCount(0);
});

test('v0.10.8: 선택기에서 돌아왔는데 파일이 아직 안 오면 "기기가 받는 중" 안내 → 파일이 오면 사라지고 가져오기', async ({ page }) => {
  await page.goto('./');
  const files = await packFiles(2);
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('문제팩 가져오기').first().click();
  const fc = await chooser;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));   // 앱 화면으로 돌아옴(기기는 아직 내려받는 중)
  await expect(page.getByTestId('pick-wait')).toContainText('고른 파일을 기기가 받는 중', { timeout: 5_000 });
  await fc.setFiles(files);
  await expect(page.getByTestId('pick-wait')).toHaveCount(0);
  await expect(page.getByText(/2022년 1회|2010년 1회/).first()).toBeVisible({ timeout: 30_000 });
});

test('v0.10.8: 묶음 파일 하나(oneq-…-bundle-….zip)로 여러 팩 가져오기', async ({ page }) => {
  const { zipSync } = await import('fflate');
  const { readFileSync } = await import('node:fs');
  const packs = await packFiles(4);
  const entries: Record<string, Uint8Array> = {};
  for (const p of packs) entries[p.split(/[\\/]/).pop()!] = new Uint8Array(readFileSync(p));
  const dir = mkdtempSync(join(tmpdir(), 'oneq-bdl-'));
  const bundle = join(dir, 'oneq-IMP-bundle-2010-2013.zip');
  writeFileSync(bundle, zipSync(entries, { level: 0 }));
  await page.goto('./');
  await page.getByTestId('pack-input').first().setInputFiles(bundle);
  await expect(page.getByTestId('dialog')).toContainText('4개를 새로 가져왔습니다', { timeout: 30_000 });
});

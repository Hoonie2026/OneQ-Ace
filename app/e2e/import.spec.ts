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

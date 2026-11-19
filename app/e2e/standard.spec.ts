/** 출제기준 화면(v0.19.1 디자인 다듬기): 요약·숫자 타일·과목 목록·펼치기·모두 펼치기 — 밝은/어두운 모드 화면 확인 */
import { expect, test } from './fixtures';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePack } from '../src/test/makePack';

const U = (no: number, majors: [string, string[]][]) =>
  majors.flatMap(([major, items], i) => items.map((name, j) => ({ id: `${i + 1}-${j + 1}`, major, name })));

for (const scheme of ['light', 'dark'] as const) {
  test(`출제기준 화면(${scheme})`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    const dir = mkdtempSync(join(tmpdir(), 'oneq-std-'));
    const path = join(dir, 'oneq-TEST-2022-1.zip');
    writeFileSync(path, await makePack({
      certName: '콘크리트기사',
      standard: { version: '2025', period: { from: '2025-01-01', to: '2027-12-31' } },
      subjectNames: { 1: '콘크리트재료및배합', 2: '콘크리트제조,시험및품질관리', 3: '콘크리트의시공', 4: '콘크리트구조및유지관리' },
      examCount: { 1: 20, 2: 20, 3: 20, 4: 20 },
      units: {
        1: U(1, [['콘크리트용 재료', ['시멘트', '물', '골재', '혼화재료', '보강재료']], ['재료시험', ['시멘트 관련시험', '골재 관련시험', '혼화재료 관련시험', '기타 재료시험']], ['콘크리트의 배합', ['배합설계의 기본원리', '콘크리트공사 표준시방서(KCS 14 20 00)에 의한 배합설계 방법']]]),
        2: U(2, [['콘크리트의 제조', ['콘크리트 제조의 일반사항', '레디믹스트 콘크리트의 제조']], ['콘크리트 시험', ['굳지 않은 콘크리트 관련 시험', '굳은 콘크리트 관련 시험', '내구성 관련시험']]]),
        3: U(3, [['일반 콘크리트', ['운반', '타설', '다지기', '양생']]]),
        4: U(4, [['콘크리트 구조', ['철근콘크리트 구조', '프리스트레스트 콘크리트']]]),
      },
      questions: [1, 2, 3, 4].map((no) => ({ hash: `s${no}`, subjectNo: no })),
    }));
    await page.goto('./');
    await page.getByTestId('pack-input').first().setInputFiles(path);
    await expect(page.getByTestId('go-recommend')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('go-subjects').click();
    await page.getByTestId('open-standard').click();
    const v = page.getByTestId('standard-view');
    await expect(v).toContainText('콘크리트기사');
    await expect(v).toContainText('적용 중');
    await expect(v).toContainText('콘크리트재료 및 배합');
    await page.screenshot({ path: `test-results/std-${scheme}-closed-${info.project.name}.png`, fullPage: true });
    await page.getByTestId('standard-subject').first().getByRole('button').click();
    await expect(v).toContainText('혼화재료');
    await page.screenshot({ path: `test-results/std-${scheme}-open-${info.project.name}.png`, fullPage: true });
    await page.getByTestId('std-toggle-all').click();
    await expect(page.getByTestId('std-toggle-all')).toHaveText('모두 접기');
  });
}

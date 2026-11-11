import { PREP_DOWNLOAD_URL, PREP_RELEASES_URL, PREP_SETUP_URL, prepOffer } from '../prep';
import { deviceEnv } from '../util';

/**
 * 전처리기 받기 카드(v0.12.0, PREP-PLAN-v0.5 D1 · ADR 021 7절).
 * - Windows PC: [전처리기 설치 파일 받기](Setup.exe, v0.12.2) + 받을 때·처음 실행할 때 경고 넘기는 법, 보조로 설치 없는 zip
 * - 맥 등 다른 PC: Windows 전용이라고만
 * - 휴대폰·태블릿: 문제팩은 PC에서 만든다 — 이 주소를 PC로 열라고만(compact면 아무것도 안 보임)
 * 전처리기는 팩 파일을 PC에 저장할 뿐 이 앱으로 보내지 않는다 → 기기마다 [문제팩 가져오기]
 */
export function PrepCard(props: { compact?: boolean; testId?: string }) {
  const env = deviceEnv();
  const offer = prepOffer(env);
  if (props.compact && offer !== 'download') return null;
  const testId = props.testId ?? 'prep-card';

  if (offer === 'use-pc')
    return (
      <section className="card prep-card" data-testid={testId}>
        <h2>문제팩 만들기(PC)</h2>
        <p className="hint">
          기출 PDF를 문제팩으로 바꾸는 <b>원큐합격 전처리기</b>는 Windows PC 프로그램입니다. 이 앱 주소를 PC의 Chrome·Edge로 열면 받는 단추가 나옵니다. 만든
          문제팩은 이 기기로 옮겨 [문제팩 가져오기]로 넣습니다.
        </p>
      </section>
    );

  if (offer === 'windows-only')
    return (
      <section className="card prep-card" data-testid={testId}>
        <h2>문제팩 만들기 — 전처리기(Windows 전용)</h2>
        <p className="hint">원큐합격 전처리기는 Windows PC에서만 돌아갑니다. Windows PC에서 이 앱 주소를 열어 받으세요.</p>
      </section>
    );

  return (
    <section className="card guide prep-card" data-testid={testId}>
      <h2>{props.compact ? '문제팩이 없으면 — 직접 만드세요' : '문제팩 만들기 — 원큐합격 전처리기'}</h2>
      <p className="hint">기출 PDF를 넣으면 현행 출제기준에 맞춰 과목·단원·유형을 정리한 문제팩을 만듭니다(Windows 10·11, 관리자 권한 없이 설치).</p>
      <a className="btn btn-primary btn-block" href={PREP_SETUP_URL} data-testid="prep-download" rel="noopener">
        전처리기 설치 파일 받기
      </a>
      <ol className="install-steps">
        <li>
          브라우저가 「흔히 다운로드되는 파일이 아닙니다」라고 하면 <b>…</b> → <b>유지</b>(Chrome·Edge)
        </li>
        <li>
          받은 <b>OneQ-Prep-Setup.exe</b>를 엽니다. 「Windows의 PC 보호」 창이 뜨면 <b>추가 정보</b> → <b>실행</b>
        </li>
        <li>
          [설치] → 끝나면 시작 메뉴·바탕화면의 <b>원큐합격 전처리기</b>로 엽니다. 새 판도 같은 방법으로 덮어 설치합니다
        </li>
        <li>만든 문제팩(oneq-종목-bundle-….zip)을 이 앱의 [문제팩 가져오기]로 넣습니다 — 휴대폰은 파일을 옮겨서 따로</li>
      </ol>
      <p className="hint">
        설치가 막힌 PC는{' '}
        <a href={PREP_DOWNLOAD_URL} data-testid="prep-download-zip" rel="noopener">
          설치 없이 쓰는 zip
        </a>
        (오른쪽 클릭 → 모두 압축 풀기 → 풀린 폴더의 OneQ-Prep.exe). 받기가 안 되면{' '}
        <a href={PREP_RELEASES_URL} target="_blank" rel="noopener">
          배포 페이지
        </a>
        에서 직접 받습니다. 지울 때는 Windows 설정 → 앱에서 제거(만든 문제팩은 남음).
      </p>
    </section>
  );
}

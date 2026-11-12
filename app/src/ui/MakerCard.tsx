import { MAKER_DOWNLOAD_URL, MAKER_NAME, MAKER_RELEASES_URL, MAKER_SETUP_ASSET, MAKER_SETUP_URL, makerOffer } from '../maker';
import { deviceEnv } from '../util';

/**
 * 문제팩이 없을 때의 서브 안내 — 원큐합격 문제팩 생성기(설치 루트 재설계, 사용자 2026-11-12 세션 #19).
 * 학습앱 첫 화면(설치한 앱)과 설정에서 [문제팩 가져오기] 아래에 둔다.
 * - Windows PC 학습앱: "문제팩이 없으면 생성기를 이 PC에 설치" + 설치 파일 받기 링크
 * - 휴대폰·태블릿: "PC에서 학습앱을 설치한 뒤 생성기를 설치해 만드세요" — 받기 링크를 주지 않음
 * - 맥: Windows 전용 안내
 */
export const MAKER_WHAT = `${MAKER_NAME}는 Q-Net의 최신 출제기준과 기출문제 PDF로 이 학습앱에서 풀 문제팩(과목·단원·유형 정리)을 만드는 Windows PC 프로그램입니다.`;

export function MakerCard(props: { testId?: string }) {
  const offer = makerOffer(deviceEnv());
  const testId = props.testId ?? 'maker-card';

  if (offer === 'use-pc')
    return (
      <div className="maker-card" data-testid={testId}>
        <p className="maker-lead">
          문제팩이 없는 경우 <b>PC에서 원큐합격 학습앱을 설치</b>한 뒤, PC 학습앱에서 「문제팩 생성기」를 설치해 문제팩을 만들어 주세요.
        </p>
        <p className="hint">만든 문제팩은 생성기의 [문제팩 공유하기]로 이 기기에 보내 위의 [문제팩 가져오기]로 넣습니다.</p>
      </div>
    );

  if (offer === 'windows-only')
    return (
      <div className="maker-card" data-testid={testId}>
        <p className="maker-lead">
          문제팩이 없는 경우 <b>Windows PC</b>에서 원큐합격 학습앱을 설치한 뒤, PC 학습앱에서 「문제팩 생성기」를 설치해 문제팩을 만들어 주세요(생성기는 Windows 전용).
        </p>
      </div>
    );

  return (
    <div className="maker-card" data-testid={testId}>
      <p className="maker-lead">
        문제팩이 없는 경우 <b>{MAKER_NAME}</b>를 이 PC에 설치하여 문제팩을 만드세요.
      </p>
      <p className="hint">{MAKER_WHAT}</p>
      <a className="btn btn-block" href={MAKER_SETUP_URL} data-testid="maker-download" rel="noopener">
        문제팩 생성기 설치 파일 받기
      </a>
      <ol className="install-steps">
        <li>
          브라우저가 「흔히 다운로드되는 파일이 아닙니다」라고 하면 <b>…</b> → <b>유지</b>
        </li>
        <li>
          받은 <b>{MAKER_SETUP_ASSET}</b>를 엽니다. 「Windows의 PC 보호」 창이 뜨면 <b>추가 정보</b> → <b>실행</b> → [설치](관리자 권한 필요 없음)
        </li>
        <li>
          바탕화면·시작 메뉴의 <b>{MAKER_NAME}</b>(노란 아이콘)에서 문제팩을 만들고, 만든 팩을 위의 [문제팩 가져오기]로 넣습니다
        </li>
      </ol>
      <p className="hint">
        설치가 막힌 PC는{' '}
        <a href={MAKER_DOWNLOAD_URL} data-testid="maker-download-zip" rel="noopener">
          설치 없이 쓰는 zip
        </a>
        , 받기가 안 되면{' '}
        <a href={MAKER_RELEASES_URL} target="_blank" rel="noopener">
          배포 페이지
        </a>
        . 지울 때는 Windows 설정 → 앱(만든 문제팩은 남음).
      </p>
    </div>
  );
}

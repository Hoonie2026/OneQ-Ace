import { useEffect, useMemo, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { appInstalledOnDevice, canPromptInstall, externalOpenUrl, forgetInstalled, installedAt, justInstalled, onInstallChange, promptInstall } from '../install';
import { deviceEnv, deviceNoun, type DeviceEnv } from '../util';

/**
 * 기기별 설치 안내(v0.10.1 — 실기기 Y6·추가 검토). 권장 경로를 기기마다 하나로:
 * 안드로이드 = Chrome에서 [앱 설치], 아이폰·아이패드 = Safari에서 공유 → 홈 화면에 추가, PC = Chrome·Edge에서 설치(2026-11-12부터 PC도 이 길 하나).
 * 카카오톡·네이버 앱 안에서 열리면 설치가 안 되고 기록도 따로 저장되므로 먼저 바깥 브라우저로 보낸다.
 *
 * 설치 루트 재설계(사용자 2026-11-12 세션 #19): 모든 설치는 학습앱 설치에서 시작한다.
 * - 설치 안내는 [PC(Windows)] · [모바일(Android·iPhone)] 둘로 나누고, 지금 기기 쪽을 먼저 보인다
 * - 설치 안내에는 설치 내용만(문제팩 가져오기·문제팩 생성기 안내는 설치한 앱을 처음 열었을 때 — Home)
 * - 기본 설치 위치: PC = Windows 앱 목록(시작 메뉴) + 바탕화면 바로가기, 모바일 = 앱 목록 + 홈 화면
 */
interface Guide {
  title: string;
  lead?: string;
  action?: { label: string; run: () => void; testId: string };
  steps: ReactNode[];
  note?: string;
  /** 나중에(7일 숨김) 단추를 보일지 — 앱 안 브라우저·아이폰 Safari 탭은 기록이 따로라 숨기지 않음 */
  dismissible: boolean;
}

function guideFor(env: DeviceEnv, canPrompt: boolean, url: string, copy: () => void, install: () => void): Guide {
  const dev = deviceNoun(env);
  if (env.inApp) {
    const appName = env.inApp === 'kakao' ? '카카오톡' : env.inApp === 'naver' ? '네이버 앱' : '다른 앱';
    const target = env.os === 'ios' ? 'Safari' : 'Chrome';
    const ext = externalOpenUrl(env.inApp, env.os, url);
    return {
      title: `${appName} 안에서 열렸습니다`,
      lead: `여기서는 설치가 안 되고 기록도 따로 저장됩니다. ${target}에서 열어 주세요.`,
      action: ext ? { label: `${target}로 열기`, run: () => (window.location.href = ext), testId: 'open-external' } : { label: '주소 복사', run: copy, testId: 'copy-url' },
      steps:
        env.os === 'ios'
          ? ['화면 아래 공유 단추(□↑) 또는 ··· 를 누릅니다', `「Safari로 열기」를 고릅니다`, '안 보이면 [주소 복사] → Safari 주소창에 붙여넣기']
          : ['화면의 ⋮ (점 세 개)를 누릅니다', '「다른 브라우저로 열기」 → Chrome을 고릅니다'],
      dismissible: false,
    };
  }
  if (env.os === 'ios') {
    if (env.browser !== 'Safari')
      return {
        title: 'Safari로 열어 주세요',
        lead: '아이폰·아이패드는 Safari에서 홈 화면에 추가해야 앱처럼 쓰고 기록이 오래 보존됩니다.',
        action: { label: '주소 복사', run: copy, testId: 'copy-url' },
        steps: ['[주소 복사]를 누릅니다', 'Safari를 열고 주소창에 붙여넣습니다', '열린 화면의 안내대로 홈 화면에 추가합니다'],
        dismissible: false,
      };
    return {
      title: `${dev} 홈 화면에 추가하세요`,
      steps: [
        `${env.kind === 'tablet' ? '화면 위' : '화면 아래'} 공유 단추(□↑)를 누릅니다`,
        '목록을 위로 밀어 「홈 화면에 추가」를 누릅니다',
        '오른쪽 위 「추가」를 누릅니다',
        '홈 화면과 앱 보관함(앱 목록)에 원큐합격 아이콘이 생깁니다 — 이제 그 아이콘으로 엽니다',
      ],
      note: '이 Safari 화면과 홈 화면 앱은 기록이 따로 저장되니, 설치한 뒤에는 아이콘으로 여세요.',
      dismissible: false,
    };
  }
  if (env.kind === 'pc')
    // 사용자 2026-11-12: PC도 Chrome·Edge 정식 설치(PWA)로 통일 — 바탕화면·시작 메뉴 아이콘, Windows 설정 › 앱에 올라가 거기서 제거
    return {
      title: 'PC에 원큐합격 학습앱 설치',
      lead: '설치하면 Windows 앱 목록(시작 메뉴)과 바탕화면에 원큐합격 아이콘이 생기고, 창으로 열립니다. Windows 설정 › 앱에서 지울 수 있고, 실행은 인터넷이 필요 없으며 학습 기록은 이 PC에 저장됩니다.',
      action: canPrompt ? { label: 'PC에 설치', run: install, testId: 'install-app' } : undefined,
      steps:
        env.browser === 'Edge'
          ? [
              canPrompt ? '[PC에 설치]를 누르거나, 주소창 오른쪽의 「앱 사용 가능」 아이콘 · ⋯ → 앱 → 「이 사이트를 앱으로 설치」' : '주소창 오른쪽의 「앱 사용 가능」 아이콘을 누르거나, ⋯ → 앱 → 「이 사이트를 앱으로 설치」',
              '「설치」를 누릅니다',
              '설치 뒤 뜨는 창에서 「시작에 고정」과 「바탕 화면 바로 가기 만들기」를 켜 둔 채 「허용」을 누릅니다(창이 지나갔으면 주소창에 edge://apps → 원큐합격 「세부 정보」에서 켭니다)',
              '시작 메뉴·바탕화면의 원큐합격 아이콘으로 엽니다',
            ]
          : env.browser === 'Chrome' || env.browser === '웨일'
            ? [
                canPrompt ? '[PC에 설치]를 누르거나, 주소창 오른쪽 끝의 설치 아이콘(모니터 모양)' : '주소창 오른쪽 끝의 설치 아이콘(모니터 모양)을 누릅니다',
                '「설치」를 누릅니다 — 시작 메뉴(Windows 앱 목록)와 바탕화면에 원큐합격 아이콘이 생깁니다',
                '시작 메뉴·바탕화면의 원큐합격 아이콘으로 엽니다',
              ]
            : ['이 브라우저는 설치를 지원하지 않습니다 — Chrome 또는 Edge로 이 주소를 엽니다', '주소창 오른쪽의 설치 아이콘을 누릅니다'],
      dismissible: true,
    };
  // 안드로이드에서 Chrome이 아닌 브라우저(Firefox·Edge·웨일 등 — 기본 브라우저면 메일·메신저 링크가 여기로 열림, 실기기 Z4)
  if (env.browser !== 'Chrome' && !(canPrompt && env.browser === '삼성 인터넷')) {
    const ext = externalOpenUrl('other', 'android', url);
    return {
      title: `${dev}에서는 Chrome으로 설치하세요`,
      lead: `지금은 ${env.browser}에서 열렸습니다. 브라우저마다 기록이 따로 저장되므로 설치와 학습은 Chrome 한 곳에서 하세요.`,
      action: ext ? { label: 'Chrome으로 열기', run: () => (window.location.href = ext), testId: 'open-chrome' } : undefined,
      steps: [
        '[Chrome으로 열기]를 누릅니다(안 되면 Chrome을 열고 주소창에 이 주소를 입력)',
        'Chrome 화면의 [원큐합격 앱 설치] 또는 ⋮ → 「앱 설치」·「설치 및 바로가기 만들기 → 설치」',
        `${env.browser}에서 계속 쓰려면: 메뉴(⋮) → 「설치」 또는 「홈 화면에 추가」`,
      ],
      dismissible: true,
    };
  }
  // 안드로이드 휴대폰·태블릿(Chrome·삼성 인터넷)
  return {
    title: `${dev}에 앱으로 설치하세요`,
    lead: '설치하면 인터넷 없이도 열리고 기록이 오래 보존됩니다.',
    action: canPrompt ? { label: '원큐합격 앱 설치', run: install, testId: 'install-app' } : undefined,
    steps:
      env.browser === 'Chrome'
        ? [
            canPrompt ? '[원큐합격 앱 설치]를 누르거나, 오른쪽 위 ⋮ 를 누릅니다' : '오른쪽 위 ⋮ (점 세 개)를 누릅니다',
            '「앱 설치」 또는 「설치 및 바로가기 만들기」 → 「설치」를 고릅니다',
            '잠시 뒤 앱 목록과 홈 화면에 원큐합격 아이콘이 생깁니다. 홈 화면에 없으면 앱 목록에서 아이콘을 길게 눌러 「홈 화면에 추가」',
          ]
        : [
            canPrompt ? '[원큐합격 앱 설치]를 누릅니다' : 'Chrome으로 이 주소를 엽니다(설치가 가장 쉽습니다)',
            '설치가 끝나면 앱 목록·홈 화면의 원큐합격 아이콘으로 엽니다(홈 화면에 없으면 앱 목록에서 길게 눌러 「홈 화면에 추가」)',
          ],
    dismissible: true,
  };
}

type Platform = 'pc' | 'mobile';

/** 지금 기기가 아닌 쪽 탭 — 다른 기기에서 이 주소를 여는 방법(어느 브라우저로 열릴지는 기기마다 달라 단정하지 않음) */
function otherGuide(target: Platform): Guide {
  if (target === 'pc')
    return {
      title: 'PC(Windows)에 설치하려면',
      steps: [
        'PC에서 이 학습앱 주소를 엽니다 — 아래 [주소 복사]·[보내기]로 PC에 보내세요(카카오톡 PC·메일 등)',
        'PC의 Chrome 또는 Edge에서 주소창 오른쪽의 설치 아이콘 → 「설치」',
        'Windows 앱 목록(시작 메뉴)과 바탕화면에 원큐합격 아이콘이 생깁니다',
      ],
      dismissible: false,
    };
  return {
    title: '휴대폰·태블릿에 설치하려면',
    steps: [
      '휴대폰 카메라로 아래 QR을 찍거나, [주소 복사] 후 카카오톡 「나와의 채팅」·메일로 보내 휴대폰에서 엽니다',
      '열린 화면이 그 기기(Android·iPhone)에 맞는 설치 방법을 알려 줍니다',
      '설치하면 앱 목록과 홈 화면에 원큐합격 아이콘이 생깁니다',
    ],
    dismissible: false,
  };
}

/** 학습앱 주소 QR(SVG) — PC 화면에서 휴대폰으로 옮길 때 */
function QrCode(props: { url: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(props.url);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [props.url]);
  return <div className="install-qr" role="img" aria-label="학습앱 주소 QR" data-testid="install-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const HIDE_KEY = 'oneq-install-hide-until';

export function InstallGuide(props: { url: string; onCopy: () => void; compact?: boolean; testId?: string; /** 첫 화면(팩 없음)의 메인 — '나중에' 숨기기 없음 */ main?: boolean }) {
  const env = deviceEnv();
  const own: Platform = env.kind === 'pc' ? 'pc' : 'mobile';
  const showTabs = !!props.main || !props.compact;
  // 설정(설치한 앱 안)에서는 다른 기기 설치가 쓸모 있으므로 그쪽 탭을 먼저(PC 학습앱 → 휴대폰 QR)
  const [platform, setPlatform] = useState<Platform>(env.standalone && showTabs && !props.main ? (own === 'pc' ? 'mobile' : 'pc') : own);
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [hidden, setHidden] = useState(() => {
    try {
      return Number(localStorage.getItem(HIDE_KEY) ?? 0) > Date.now();
    } catch {
      return false;
    }
  });
  // 설치 직후 PC Chrome·Edge는 지금 탭을 그대로 앱 창으로 옮긴다(새로 불러오지 않음) → 표시 방식이 바뀌면 카드를 숨긴다(실기기 Z5)
  const [installedNow, setInstalledNow] = useState(false);
  // 휴대폰·태블릿(v0.10.3, 실기기): 설치를 눌러도 브라우저 화면은 그대로 남고 앱 아이콘은 1~2분 뒤에 생긴다 →
  // 카드를 숨기지 말고 "설치 중 → 설치 완료, 이 브라우저 화면은 닫고 앱 아이콘으로 여세요"로 바꾼다
  const [mobileInstall, setMobileInstall] = useState<'none' | 'pending' | 'done'>(() => (installedAt() ? 'pending' : 'none'));
  useEffect(() => {
    if (env.kind === 'pc' || env.standalone || mobileInstall === 'none' || mobileInstall === 'done') return;
    let alive = true;
    let tries = 0;
    const check = async () => {
      const ok = await appInstalledOnDevice();
      if (!alive) return;
      if (ok) return setMobileInstall('done');
      // 설치 뒤 5분이 지나도 확인이 안 되면(앱을 지웠거나 설치 실패, 확인 기능이 없는 브라우저) 다시 설치 안내로
      const since = Date.now() - (installedAt() ?? Date.now());
      if (since > 5 * 60_000) {
        forgetInstalled();
        return setMobileInstall('none');
      }
      if (++tries < 40) timer = window.setTimeout(check, 7_500);
    };
    let timer = window.setTimeout(check, 1_500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mobileInstall]);
  useEffect(() => {
    const off = onInstallChange(() => {
      setCanPrompt(canPromptInstall());
      if (justInstalled()) {
        if (env.kind === 'pc') setInstalledNow(true); // PC는 지금 탭이 앱 창으로 옮겨짐
        else setMobileInstall('pending');
      }
    });
    const mq = window.matchMedia?.('(display-mode: standalone)');
    const onMode = () => mq?.matches && setInstalledNow(true);
    mq?.addEventListener?.('change', onMode);
    return () => {
      off();
      mq?.removeEventListener?.('change', onMode);
    };
  }, []);
  // 카카오톡 안에서 처음 열리면 바로 바깥 브라우저로(카카오톡이 제공하는 주소). 실패하면 이 카드의 단추·안내
  useEffect(() => {
    if (!props.compact || env.inApp !== 'kakao') return;
    try {
      if (sessionStorage.getItem('oneq-kakao-escape')) return;
      sessionStorage.setItem('oneq-kakao-escape', '1');
    } catch {
      return;
    }
    const ext = externalOpenUrl('kakao', env.os, props.url);
    if (ext) window.location.href = ext;
  }, []);

  const installedHere = env.standalone || installedNow;
  if (installedHere && !(showTabs && !props.main)) return null;
  if (!installedHere && env.kind !== 'pc' && mobileInstall !== 'none') {
    return (
      <section className={`card guide install-guide install-done${props.compact ? '' : ' plain'}`} data-testid={props.testId ?? 'install-guide'} role="status">
        <h2>{mobileInstall === 'done' ? '설치 완료 — 앱 아이콘으로 여세요' : '설치하고 있습니다(1~2분)'}</h2>
        <p className="hint">
          {mobileInstall === 'done'
            ? `${deviceNoun(env)}의 앱 목록에 원큐합격이 생겼습니다. 지금 이 화면은 앱이 아니라 브라우저입니다.`
            : '앱 목록에 원큐합격 아이콘이 생기기까지 1~2분 걸릴 수 있습니다. 지금 이 화면은 앱이 아니라 브라우저입니다.'}
        </p>
        <ol className="install-steps">
          <li>이 브라우저 화면을 닫습니다(뒤로 가기, 또는 최근 앱 목록에서 위로 밀기)</li>
          <li>앱 목록(또는 홈 화면)에서 <b>원큐합격</b> 아이콘을 누릅니다</li>
          <li>홈 화면에 없으면 앱 목록에서 아이콘을 길게 눌러 「홈 화면에 추가」</li>
        </ol>
        <p className="hint">아이콘이 3분이 지나도 안 보이면 이 화면을 새로 고쳐 다시 설치하세요. 브라우저에서 공부해도 기록은 앱과 같은 곳에 저장됩니다.</p>
      </section>
    );
  }
  const g: Guide =
    platform !== own
      ? otherGuide(platform)
      : installedHere
        ? { title: `${deviceNoun(env)}에는 이미 설치되어 있습니다`, steps: [`${own === 'pc' ? '시작 메뉴·바탕화면' : '앱 목록·홈 화면'}의 원큐합격 아이콘으로 엽니다`], dismissible: false }
        : guideFor(env, canPrompt, props.url, props.onCopy, () => void promptInstall());
  if (props.compact && hidden && g.dismissible && !props.main) return null;
  const other = platform !== own;

  return (
    <section className={`card guide install-guide${props.compact ? '' : ' plain'}`} data-testid={props.testId ?? 'install-guide'}>
      {showTabs && (
        <>
          {props.main && <p className="install-kicker">원큐합격 학습앱 설치</p>}
          <div className="install-tabs" role="tablist" aria-label="설치할 기기">
            {(['pc', 'mobile'] as const).map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={platform === p}
                className={platform === p ? 'on' : ''}
                onClick={() => setPlatform(p)}
                data-testid={`install-tab-${p}`}
              >
                {p === 'pc' ? 'PC(Windows)' : '모바일(Android·iPhone)'}
                {p === own && <span className="install-tab-here">이 기기</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <h2>{g.title}</h2>
      {g.lead && <p className="hint">{g.lead}</p>}
      {g.action && (
        <button className="btn btn-primary btn-block" onClick={g.action.run} data-testid={g.action.testId}>
          {g.action.label}
        </button>
      )}
      <ol className="install-steps">
        {g.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {other && platform === 'mobile' && <QrCode url={props.url} />}
      {other && (
        <div className="test-actions">
          <button className="btn btn-small" onClick={props.onCopy} data-testid="install-copy-url">
            주소 복사
          </button>
          {'share' in navigator && (
            <button className="btn btn-small" onClick={() => navigator.share({ title: '원큐합격 학습앱', url: props.url }).catch(() => undefined)}>
              보내기
            </button>
          )}
        </div>
      )}
      {g.note && <p className="hint">{g.note}</p>}
      {props.compact && g.dismissible && !props.main && (
        <button
          className="link-btn install-later"
          onClick={() => {
            try {
              localStorage.setItem(HIDE_KEY, String(Date.now() + 7 * 86_400_000));
            } catch {
              /* 저장이 안 되면 이번에만 숨김 */
            }
            setHidden(true);
          }}
        >
          나중에(7일 동안 숨기기)
        </button>
      )}
    </section>
  );
}

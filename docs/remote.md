# 원격 포털과 집 Mac 연결

## 연결 방식

- 외부 PC의 Chrome에서 포털에 로그인하면 그 PC에 설치한 탭룸 확장이 인증된 WebSocket으로 서버에 연결합니다. 에이전트의 브라우저 작업은 연결한 PC에서 실행됩니다.
- 휴대폰에서 **집 Mac Chrome에 연결**을 누르면, HTTPS 포털이 집 Mac의 로컬 연결 탭을 통해 Chrome 확장에 연결합니다. 집 Mac이 깨어 있고 Chrome의 연결 탭이 열려 있어야 합니다.
- 채팅 목록, 등록 스킬, 자주 쓰는 작업, 딥링크와 저장된 탭그룹은 서버에서 공유합니다. 연결된 실제 Chrome 탭은 기기별이며 저장된 그룹을 현재 연결 기기에서 복원할 수 있습니다. 탭룸 ID는 복원 전후에 유지됩니다.

## 집 Mac에 설정

1. [README](../README.md)의 로컬 실행 절차를 완료합니다. 원격 HTTPS 포털 주소와 유효한 인증서를 제공하는 역방향 프록시를 준비합니다. [Caddy 예시](../deploy/remote/Caddyfile.example)는 환경 변수 `TABROOM_PUBLIC_ORIGIN`을 사용합니다.
2. 집 Mac의 Chrome 확장 서비스 워커 DevTools에서 다음 명령으로 브라우저 프로필 ID를 확인합니다. 로컬 포털에 한 번 연결하면 ID가 생깁니다.

   ```js
   (await chrome.storage.local.get('tabroomBrowserId')).tabroomBrowserId
   ```

3. 같은 ID로 게이트웨이 설정과 원격 PC용 ZIP을 생성합니다. `https://tabroom.example.org`는 실제 HTTPS 주소로 바꿉니다. 게이트웨이 설정 파일은 macOS의 탭룸 앱 데이터 폴더에 생성됩니다.

   ```sh
   python3 deploy/remote/configure.py init '<home-chrome-profile-uuid>'
   npm ci --prefix deploy/remote
   python3 deploy/remote/package-extension.py https://tabroom.example.org
   node deploy/remote/portal-gateway.mjs \
     "$HOME/Library/Application Support/Tabroom/remote/keys.json" \
     outputs/tabroom https://tabroom.example.org
   ```

4. 별도 터미널에서 휴대폰용 연결 탭을 엽니다. 인증된 사용자는 포털에서 `outputs/tabroom-extension.zip`을 다운로드해 외부 PC Chrome에 설치할 수 있습니다.

   ```sh
   python3 deploy/remote/configure.py open-mac
   ```

## 포트와 권한

| 연결 | 역할 |
| --- | --- |
| `127.0.0.1:18840` | Python 포털과 정적 자산 |
| `127.0.0.1:18846` | 집 Mac 연결 탭의 WebSocket |
| `127.0.0.1:18847` | HTTPS 역방향 프록시 뒤의 포털 게이트웨이 |
| 앱 데이터의 `agent.sock` | Chrome 연결과 Codex 에이전트를 이어주는 Unix 소켓 |

게이트웨이는 HTTPS 로그인 쿠키와 접속 출처를 검사합니다. 외부 PC의 확장은 1회용 티켓으로 연결하고, 집 Mac 연결 탭은 로컬 비밀값으로 인증합니다.

탭룸은 Codex 세션에 `read-only`와 `approvalPolicy: never`를 설정합니다. Chrome 제어 범위는 확장이 현재 채팅의 탭그룹을 기준으로 검사합니다. 사이트 안에서 사용자 확인이 필요한 상황에는 에이전트가 채팅으로 확인을 요청할 수 있습니다.

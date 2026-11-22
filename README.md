# 탭룸

Chrome 탭을 채팅에 참조하고, 채팅에 연결된 탭그룹 안에서 에이전트가 작업하는 도구입니다. 포털의 오른쪽 영역과 Chrome 사이드 패널에서 탭 화면을 볼 수 있습니다.

## macOS에서 실행

Python 3.10 이상, Node.js 25 이상, Google Chrome 142 이상, ChatGPT 계정으로 로그인한 Codex CLI가 필요합니다. 브라우저 도구로 영상을 처리하려면 FFmpeg도 `PATH`에 준비합니다.

1. `chrome://extensions`에서 개발자 모드를 켜고 `outputs/tabroom` 폴더를 압축해제된 확장으로 불러옵니다.
2. 저장소 루트에서 실행기를 시작합니다. 이 명령은 Chrome의 네이티브 연결을 등록한 뒤 포털을 엽니다.

   ```sh
   python3 outputs/tabroom-launcher/launch.py --regular
   ```

3. `http://127.0.0.1:18840/`에서 `#`으로 탭을 고릅니다. 탭 칩만 보내면 연결된 채팅과 탭그룹이 생기고, 문장을 함께 보내면 에이전트가 응답합니다. 탭을 고르기 전에도 채팅할 수 있습니다.

Chrome for Testing과 샘플 영상 세 개를 쓰려면 `--regular` 없이 실행합니다. 전체 사용법은 [설치 안내](docs/install-ko.txt)에 있습니다. [Windows 보조 프로그램](outputs/tabroom-launcher/install_windows_visibility.py)은 창 가림 감지용입니다. Windows 전체 실행 환경은 실기기 검증이 남아 있습니다.

## 코드와 문서

| 위치 | 내용 |
| --- | --- |
| [outputs/tabroom](outputs/tabroom) | MV3 확장, 포털과 사이드 패널, 미리보기, 탭 선택, 대화형 UI |
| [outputs/tabroom-launcher](outputs/tabroom-launcher) | 로컬 포털, Codex App Server 연결, 브라우저 도구와 스킬, 세션 저장 |
| [deploy/remote](deploy/remote) | HTTPS 포털, 외부 PC용 확장 빌드, 휴대폰의 집 Mac 연결 |
| [구현 기록](outputs/tabroom/implementation/index.md) | 구현 버전별 기능과 검증 기록 |
| [미리보기 설계](docs/preview.html) | 캡처 해상도, FPS, CPU, 선택기와 모션 |
| [홍보 영상](media/tabroom-promo.mp4) · [편집 프로젝트](media/promo) | Playwright 녹화와 Remotion 편집본 |

설정 파일과 채팅, 저장한 탭그룹, 스킬 등 개인 데이터는 macOS의 `~/Library/Application Support/Tabroom`에 보관합니다. 공개 HTTPS 주소와 기기별 접속 정보는 각 설치 환경에서 설정합니다. [원격 접속 설정](docs/remote.md)

## 테스트

```sh
node --test outputs/tabroom/tests/*.test.mjs
node deploy/remote/check-shared-library.mjs
python3 deploy/remote/package-extension.py https://tabroom.example.org
unzip -tq outputs/tabroom-extension.zip
```

공유 데이터 테스트는 임시 디렉터리와 가상 브라우저 연결을 사용합니다. 브라우저 도구 런타임과 가이드의 출처는 [Aside 연동 기록](outputs/tabroom-launcher/aside/SOURCE.txt)에 있습니다.

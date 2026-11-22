---
name: quick-task-creator
description: Ask what a reusable task should do and save its draft with an optional independent tab-group chip.
---

# 자주 쓰는 작업 만들기

사용자가 반복할 일과 원하는 결과를 확인한다. 아직 알 수 없는 사항만 한 번에 짧게 묻는다.

1. 요청이 구체적이지 않으면 어떤 작업을 하고 무엇을 결과로 받고 싶은지 묻는다.
2. 웹사이트 사용 여부가 모호하면 브라우저 작업인지 확인한다. 브라우저 작업이면 기존 저장 그룹, 현재 채팅 그룹, 또는 사용자가 지정한 웹 주소 중 무엇을 쓸지 확인한다.
3. 기존 저장 그룹은 `listTabBundles`로 실제 이름과 ID를 찾고 칩 자리에 `{bundleId}`를 넣는다. 서버가 그 그룹의 이름과 탭 구성을 복사한다. 현재 그룹의 웹 주소는 브라우저 스킬과 `browser_repl`의 `listBrowserTabs()`로 확인한다. 현재 그룹이나 직접 지정한 주소를 저장할 때는 칩 자리에 `{tabGroup:{title,urls}}`를 넣는다.
4. 작업 제목과 순서 있는 초안 `parts`를 `save_quick_task`로 저장한다. 예를 들어 `[{text:"먼저 "},{bundleId:"실제 ID"},{text:"을 열고 일정 확인해줘"}]`처럼 쓴다. 그룹이 없는 작업은 `[{text:"작업 문구"}]`로 저장한다.

저장된 칩은 작업 초안의 독립적인 일부다. 실제 탭 열기와 작업 실행은 사용자가 초안을 보낼 때 이루어진다.

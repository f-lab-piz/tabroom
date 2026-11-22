---
name: skill-creator
description: Design, write and register a reusable Tabroom skill.
---

# 스킬 만들기

사용자가 반복할 목적, 스킬을 고르는 조건, 따라야 할 순서와 결과 형식을 확인한다. 이미 받은 조건은 그대로 사용한다. 모호한 부분만 짧게 질문한다.

1. 사용자가 볼 제목과 짧은 사용 조건을 쓴다. 고유한 `name`은 영문 소문자, 숫자와 하이픈으로 정한다. `list_skills`로 이름 중복을 확인한다.
2. 지침 본문에는 언제 이 스킬을 쓰는지, 어떤 도구나 입력이 필요한지, 단계별 동작과 원하는 결과를 구체적으로 적는다. 장황한 설명과 메인 지침의 반복을 피한다.
3. 사용자가 스킬 작성을 요청했고 필요한 내용이 정해지면 `create_skill`에 `name`, `title`, `description`, `body`를 보내 저장한다. `body`에는 Markdown 본문을 준다.
4. 저장이 완료되면 새 스킬 이름과 채팅에서 `/`로 고를 수 있다는 점을 알려준다.

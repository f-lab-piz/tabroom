export const fps = 30;
export const scenes = [
  {
    id: 'intro', seconds: 4, label: 'Tabroom',
    captions: [[0, '보고 있는 탭으로, 바로 대화를 시작하세요.']],
    focus: [0.56,0.48,1.025],
  },
  {
    id: 'current', seconds: 12, label: '현재 탭',
    captions: [
      [0, '#을 누르면 열려 있는 탭을 미리 볼 수 있어요.'],
      [4.55, 'Shift + Enter로 탭을 여러 개 담으세요.'],
      [8.9, '탭 그룹을 열면 오른쪽에 실시간 화면이 나타나요.'],
    ],
    focus: [0.54,0.75,1.078],
  },
  {
    id: 'saved', seconds: 9, label: '저장된 탭그룹',
    captions: [
      [0, '새 채팅에서 #으로 저장된 탭그룹을 찾아요.'],
      [4.75, '저장한 화면을 확인하고 묶음째 다시 열어요.'],
    ],
    focus: [0.49,0.68,1.055],
  },
  {
    id: 'search', seconds: 12, label: '검색',
    captions: [
      [0, '# 뒤에 사이트 이름을 쓰면 방문 기록에서 찾아요.'],
      [5.25, '“영화 순위”처럼 원하는 페이지를 입력해도 돼요.'],
      [8.85, '찾은 페이지를 골라 바로 탭 그룹을 열어요.'],
    ],
    focus: [0.49,0.74,1.055],
  },
  {
    id: 'ingroup', seconds: 11, label: '그룹 안에서 참조',
    captions: [
      [0, '그룹이 열린 뒤에는 #으로 오른쪽 탭을 골라요.'],
      [5.65, 'Enter로 탭을 문장 속에 넣고 질문하세요.'],
    ],
    focus: [0.85,0.68,1.065],
  },
  {
    id: 'jump', seconds: 2, label: '탭으로 이동',
    captions: [[0, '오른쪽 미리보기를 클릭하면']],
    focus: [0.84,0.37,1.045],
  },
  {
    id: 'landing', seconds: 3, label: '탭으로 이동',
    captions: [[0, '이미 열린 탭으로 바로 이동해요.']],
    focus: [0.55,0.53,1.035],
  },
  {
    id: 'source', seconds: 7, label: '답변의 출처',
    captions: [
      [0, '답변 속 칩에 마우스를 올려 출처 화면을 확인해요.'],
      [5.15, '탭을 고르고, 보면서, 바로 물어보세요.'],
    ],
    focus: [0.43,0.51,1.08],
  },
];

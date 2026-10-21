# PRD 기능 확인 안내 (심사용)

배포된 데모에서 PRD 기능 ID별로 직접 확인하는 방법과, 같은 기능을 검사하는 자동 테스트를 정리했습니다. PRD 원문과 주최 측 제공 자료는 공개 저장소에 넣지 않았으며, 기능 ID와 섹션 번호만 인용합니다.

- 로그인: `/login` · 참가자 `hello@siktak.demo` · 운영자 `admin@siktak.demo` (운영 담당 `ops@`, 안전 담당 `safety@`) · 비밀번호는 제출 양식 참고
- 참가자 화면은 모바일 폭(390px)에 맞춰져 있습니다. 운영자와 참가자를 **서로 다른 브라우저(또는 시크릿 창)** 에서 열어 두면 편합니다.
- 해커톤 허용 범위: 모의 결제·환불, 가상 식당 예약, 시연 시간 이동 버튼(실제 24시간을 기다리지 않고 예약 작업을 지금 실행)

## 1. 전체 흐름 시나리오 (약 5분)

| 단계 | 누가 | 할 일 | 확인할 것 (PRD ID) |
| --- | --- | --- | --- |
| 1 | 운영자 | `회차·식당` 탭 → **심사용 시연 회차 만들기** (서버 시작 시 1개가 자동으로 준비되어 있으면 생략 가능) | 3일 뒤 저녁 회차·가상 식당 생성, 합성 참가자 11명이 모의 결제를 마친 상태 (`신청·결제` 탭) |
| 2 | 참가자 | 홈 `다가오는 식탁` → 심사용 시연 회차 선택 → 이용권(1회권 9,900원 등) 선택 → 동의 → 신청 → 모의 결제 | 회차 목록·복수 선택·신청·이용권 (APP-01~04), 결제 상태 (PAY-01), 홈 상태 칩 `신청 완료 · 결제 완료 · 매칭 대기` (STA-01), 다음 안내 예정 시각 (STA-02) |
| 3 | 운영자 | 회차 목록의 해당 회차 → 시연 시간 이동 **매칭 시각** | 몇 초 뒤 worker가 자동 매칭·확정 (MAT-01, MAT-10). `매칭·테이블` 탭에서 4~6명 테이블, 나이 차 8살 이내, 식당 배정 (MAT-02, MAT-03, INF-02) |
| 4 | 참가자 | 홈 새로고침 → `나의 모임` | 확정 알림 (INF-01), 가상 식당·시간·지도 (INF-03), **이 식탁으로 매칭된 이유** 설명 (MAT-12), 함께할 사람 (INF-06 최소 공개), `우리 단체방으로` 자동 생성된 방과 확정·취소 정책 공지 (INF-04, INF-05) |
| 5 | 운영자 | 같은 회차 → **시작 시각** | 단체방에 공통 관심사 기반 대화 주제 3개 자동 게시 (CON-01~03) |
| 6 | 참가자 | `체크인하기` | 참석 기록 (FDB-01) |
| 7 | 운영자 | 같은 회차 → **종료 시각** | 참가자에게 후기 요청 알림 (FDB 흐름 시작) |
| 8 | 참가자 | `피드백 남기기` → 분위기·대화·식당 평가, 재참여 의향, 추천 의향, 사람별 선호/비선호 | 만족도·재참여·사람별 선호 저장 (FDB-02~04). 같은 화면의 신고·차단 (SAF-01) |
| 9 | 운영자 | **심사용 시연 회차 만들기**를 한 번 더 → 참가자도 다시 신청·결제 → **매칭 시각** | 끝난 회차의 합성 참가자가 다시 신청합니다. 8단계에서 비선호·차단한 사람과는 같은 테이블에 배정되지 않고, 이미 만난 사람은 최소화됩니다 (MAT-05, MAT-06, FDB-04). 저장된 관계는 운영자 `안전 관리` 탭에서 확인 |

참가자가 필요하면 `/signup`에서 새 계정을 만들어 기본 정보·매칭 프로필·식사 조건·개인정보 동의 입력부터 확인할 수 있습니다 (ACC-01~05). 재로그인 후 프로필 재사용은 ACC-06입니다.

## 2. 심사 항목별 확인 위치

### 자동 매칭 (25점)

| PRD ID | 화면에서 확인 | 자동 테스트 |
| --- | --- | --- |
| MAT-01 예약 실행 | 회차의 매칭 시각에 결제 완료자만 자동 실행. 시연에서는 `매칭 시각` 버튼 | `tests/scheduler.test.ts`, `tests/automated-lifecycle.test.ts` |
| MAT-02 필수 조건 | 날짜·지역·4~6명·식당 수용량을 지킨 테이블 (`매칭·테이블`) | `tests/matching.test.ts`, `tests/matching-decisions.test.ts` |
| MAT-03 연령 조건 | 한 테이블의 나이 차 8살 이내 (9살은 거절) | `tests/matching.test.ts`, `tests/manual-allocation.test.ts` |
| MAT-04 우선순위 | 성비 → MBTI → 관심사 → 희망 성향 순서의 고정 가중치(25:13:7:3), 최소 20점. 정수계획(HiGHS)으로 최적해를 증명한 결과만 확정 | `tests/matching-decisions.test.ts`, `tests/matching-solver-failure.test.ts` |
| MAT-05 제외 조건 | 차단·신고·비선호 관계는 같은 테이블 불가 (시나리오 9단계) | `tests/matching-decisions.test.ts`, `tests/flows.test.ts` |
| MAT-06 기존 만남 | 이미 만난 쌍 최소화(새 만남 우선) | `tests/matching-decisions.test.ts` |
| MAT-07~09 검증·재배치·분리/병합 | 자동·수동·취소·충원 모두 같은 기준으로 재검사, 지역 공동 최적화 | `tests/matching-decisions-flow.test.ts`, `tests/automated-lifecycle.test.ts` |
| MAT-10 자동 확정 | 운영자 승인 없이 확정 | `tests/matching-decisions-flow.test.ts` |
| MAT-11 실패 처리 | 인원 부족 시 대안 일정·이용권 보관·모의 환불 선택 (STA-04~06) | `tests/flows.test.ts`, `tests/ai-decisions.test.ts` |
| MAT-12 처리 설명 | 참가자 `나의 모임`의 매칭 이유, 운영자 테이블 상세의 조건 충족 사실 | `tests/match-facts.test.ts`, `tests/preference-explanation.test.ts` |
| MAT-13 예외 큐 | 운영자 `예외·작업` 탭 | `tests/ai-decisions.test.ts` |
| MAT-14 긴급 수정 | `매칭·테이블`에서 미리보기 → 사유 입력 → 이동/분리/병합/해제 | `tests/manual-allocation.test.ts`, `tests/browser/manual-allocation.spec.ts` |
| MAT-15 가중치 설정 | `운영 설정`에서 조회만 가능 (정책 고정, 편집 미제공) | `tests/browser/matching-policy.spec.ts` |
| MAT-16 학습형 추천 | 구현하지 않음 | — |

### 모임 안내 (20점)

| PRD ID | 화면에서 확인 | 자동 테스트 |
| --- | --- | --- |
| INF-01 확정 안내 | 참가자 알림·홈 카드 (Web Push는 VAPID 설정 시) | `tests/flows.test.ts`, `tests/push-payload.test.ts` |
| INF-02 식당 배정 | 테이블별 가상 식당 자동 배정, 재고 부족 시 예외 | `tests/flows.test.ts`, `tests/matching-decisions-flow.test.ts` |
| INF-03 식당 정보 | 확정 참가자에게만 식당·예약명·지도 | `tests/notifications.test.ts` |
| INF-04 단체방 | 확정 멤버만 입장, 교체 시 접근 회수 | `tests/flows.test.ts`, `tests/manual-allocation.test.ts` |
| INF-05 자동 공지 | 단체방 첫 공지(큐레이션·취소 정책), 운영자 `운영 설정`의 안내 템플릿 | `tests/notifications.test.ts`, `tests/cancellation-policy.test.ts` |
| INF-06 공개 범위 | 다른 참가자의 상세 정보·점수 비공개 | `tests/match-facts.test.ts` |
| INF-07 리마인드 | 행사 하루 전 안내 예약 (참가자 홈의 다음 안내 시각) | `tests/notifications.test.ts`, `tests/automated-lifecycle.test.ts` |
| INF-08 재시도 | 발송 실패 재시도·반복 실패 예외, 운영자 `예외·작업`의 시도 이력 | `tests/job-history.test.ts` |
| CON-01~03 콘텐츠 | `시작 시각` 후 단체방 대화 주제 3개 | `tests/content-catalog.test.ts` |
| CON-04 콘텐츠 관리 | 운영자 `콘텐츠` 탭: 초안 → 미리보기 → 게시/중지 | `tests/browser/content-catalog.spec.ts` |

### 피드백 반영 (15점)

| PRD ID | 화면에서 확인 | 자동 테스트 |
| --- | --- | --- |
| FDB-01 참석 기록 | 참가자 체크인, 운영자 `참석·피드백`의 미참석 후보 확인 | `tests/flows.test.ts` |
| FDB-02~03 만족도·재참여 | 후기 화면 입력 → 운영자 `참석·피드백` 집계 | `tests/flows.test.ts` |
| FDB-04 사람별 선호 | 비선호는 상대에게 공개되지 않고 다음 매칭에서 제외 (시나리오 9단계) | `tests/automated-lifecycle.test.ts`, `tests/matching-decisions-flow.test.ts` |
| RET-01~03 재참여 | `마이`의 참가 이력·이용권 잔여·다음 일정 추천 | `tests/participant-progress.test.ts` |

### 운영자 어드민 (10점)

정상 흐름은 자동으로 처리되고 운영자는 예외만 봅니다. `운영 개요`의 확인 필요 예외·운영 체크, `예외·작업`(결제·식당·조건 충돌·반복 실패), `대기자`(STA-07), `안전 관리`(SAF-01~02), CSV 내보내기를 확인할 수 있습니다. 테스트: `tests/operational-summary.test.ts`, `tests/waitlist.test.ts`, `tests/privacy-operations.test.ts`.

### 참가자 경험 (10점)

모바일 웹앱(PWA 설치 가능)으로 신청부터 후기까지 한 화면 흐름에서 끝납니다. 홈의 상태 칩과 다음 안내 시각, 매칭 이유 설명, 단체방, 신고·차단 접근성을 확인할 수 있습니다. 브라우저 테스트: `tests/browser/journey.spec.ts`, `tests/browser/signup.spec.ts`.

## 3. 범위와 한계

- 결제·환불은 모의 처리입니다 (PAY-04 실 PG 미구현).
- 식당은 가상 데이터이며 실제 예약을 하지 않습니다 (Q&A 허용 범위).
- 실제 휴대폰 푸시 수신, 실제 24시간 경과 발송, 실사용자 사용성은 검증하지 않았습니다.
- 소셜 로그인·휴대전화 인증·이메일 소유 확인은 구현하지 않았습니다.
- 정책이 PRD에 없는 부분(취소·노쇼·멤버십 횟수 등)은 시연용 임시 기준이며 화면에 그렇게 표시합니다.

## 4. 자동 테스트 직접 실행

GitHub Actions(`App checks`)가 push마다 타입 검사, 단위·DB 테스트, 빌드, 브라우저 테스트를 실행합니다. 로컬 실행은 [DEPLOY.md](DEPLOY.md)를 참고하세요.

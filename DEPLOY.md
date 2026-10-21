# 배포와 로컬 실행

## A. Render 무료 배포 (권장, 외부 Cron 불필요)

[`render.yaml`](render.yaml) Blueprint가 무료 웹 1개와 무료 PostgreSQL 1개를 만듭니다.

1. Render 대시보드 → **New → Blueprint** → 이 저장소(`gurwnswh9910-maker/siktakpublic`, 공개) 선택
2. `DEMO_PASSWORD`에 테스트 계정 비밀번호(12자 이상)를 입력하고 **Deploy Blueprint**. 비밀번호는 저장소에 넣지 않습니다.
3. 첫 빌드(약 5~10분)가 끝나면 컨테이너가 다음 순서로 시작합니다.
   `prisma migrate deploy` → 시연 데이터(테스트 계정 + 신청 가능한 심사용 회차) → 작업 worker → 웹 서버
4. `https://<서비스 이름>.onrender.com/api/health`가 200이면 `/login`에서 로그인합니다.
5. (선택) 저장소 **Settings → Secrets and variables → Actions → Variables**에 `SIKTAK_DEMO_URL`을 넣으면 [`keep-awake`](.github/workflows/keep-awake.yml)가 10분마다 서버를 깨워 첫 접속 지연을 줄입니다.

참고
- Render 무료 PostgreSQL은 만든 날부터 30일 동안 쓸 수 있고, 워크스페이스당 1개입니다.
- 무료 웹은 15분 동안 요청이 없으면 잠들고, 잠든 동안 예약 작업은 대기했다가 다음 접속 때 처리됩니다.
- 서버가 시작될 때마다 신청 가능한 심사용 회차가 없으면 하나를 새로 만듭니다. 기존 데이터와 비밀번호는 바꾸지 않습니다.
- 계정 비밀번호는 처음 계정을 만들 때의 `DEMO_PASSWORD`로 정해집니다. 나중에 값을 바꿔도 기존 계정 비밀번호는 바뀌지 않습니다.

### 기존 PostgreSQL(예: Supabase)을 쓰는 경우

`render.yaml`의 `databases` 항목을 지우고 `DATABASE_URL`을 `sync: false`로 바꿔 연결 문자열을 넣습니다. Supabase는 Session pooler(5432)와 `sslmode=require`를 사용합니다. 전용 스키마·역할 준비 SQL은 [`deploy/`](deploy)에 있습니다. 외부 Cron으로 처리하려면 `AUTOMATION_MODE=scheduler`, `SCHEDULER_SECRET`(32자 이상)을 설정하고 [`deploy/supabase-cron.sql`](deploy/supabase-cron.sql)로 `POST /api/jobs/run`을 호출합니다.

## B. Docker Compose (로컬)

```bash
npm run setup
docker compose up --build -d
docker compose --profile demo run --rm seed
```

`http://localhost:3000/login`에서 로그인합니다. 비밀번호는 `.env`의 `DEMO_PASSWORD`입니다. compose는 PostgreSQL·마이그레이션·웹·worker를 각각 띄웁니다.

## C. Node만으로 실행 (PostgreSQL 17 필요)

```bash
npm ci
npm run setup              # .env 생성(비밀값 자동 생성)
# .env의 DATABASE_URL을 준비한 PostgreSQL로 바꾼다
npx prisma generate
npm run db:migrate
npm run db:seed
npm run dev                # 웹
npm run worker             # 다른 터미널: 작업 worker
```

## 테스트

```bash
npm run typecheck
npm test                   # 단위·DB 테스트: DATABASE_URL의 DB 이름 뒤에 _test를 붙인 격리 DB 사용
npm run build
npx playwright install chromium && npm run test:e2e
```

GitHub Actions(`.github/workflows/app-checks.yml`)가 같은 순서로 실행합니다.

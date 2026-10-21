import { parseArgs } from "node:util";
import { processSyntheticPrivacyRequest } from "../src/server/privacy-operations";
import { AppError, db } from "../src/server/db";

async function main() {
  const { values } = parseArgs({
    options: {
      actor: { type: "string" },
      user: { type: "string" },
      execute: { type: "boolean", default: false },
      fingerprint: { type: "string" },
      confirm: { type: "string" },
      "identity-confirmed": { type: "boolean", default: false },
      case: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`합성 계정 개인정보 처리 검증 도구 (기본: 조회만)

node --env-file=.env --import tsx scripts/privacy-account.ts --actor ADMIN_ID --user SYNTHETIC_ID

실행 시 추가 인자:
  --execute --fingerprint DRY_RUN_SHA256
  --confirm DELETE_SYNTHETIC:SYNTHETIC_ID --identity-confirmed --case QA_CASE_REFERENCE

DEMO_MODE=true 및 합성 계정 ID privacy-test-<8~80자 소문자/숫자/->,
정확히 <계정 ID>@example.test인 참가자만 허용합니다.
ADMIN 권한과 진행 신청·대기·환불·유효 이용권·푸시 작업을 서버에서 다시 확인합니다.
실제 이용자의 요청·법적 보존 기간·백업 삭제를 대신하는 도구가 아닙니다.`);
    return;
  }
  if (!values.actor || !values.user)
    throw new AppError("--actor와 --user를 명시해 주세요. 사용법: --help");
  const result = await processSyntheticPrivacyRequest({
    actorId: values.actor,
    userId: values.user,
    execute: values.execute,
    expectedFingerprint: values.fingerprint,
    confirmation: values.confirm,
    identityConfirmed: values["identity-confirmed"],
    caseReference: values.case,
  });
  // Counts and internal IDs only; never print profiles, credentials or originals.
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof AppError
        ? error.message
        : "처리하지 못했습니다. 인자와 DB 연결·마이그레이션 상태를 확인해 주세요.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

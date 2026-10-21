export type OperationalSummaryData = {
  unresolvedConditionCases: number;
  venueCases: number;
  unassignedVenueTables: number;
  unassignedVenueApplications: number;
  noticeFailures: number;
  sameDayCancellations: number;
};

const rows: {
  key: keyof OperationalSummaryData;
  label: string;
  unit: string;
  description: string;
}[] = [
  {
    key: "unresolvedConditionCases",
    label: "미해결 조건·데이터 예외",
    unit: "건",
    description: "필수 정보나 조건을 확인해야 하는 미처리 예외",
  },
  {
    key: "venueCases",
    label: "식당 재고 확인 예외",
    unit: "건",
    description: "배정할 식당을 확보하지 못해 확인을 기다리는 예외",
  },
  {
    key: "unassignedVenueTables",
    label: "식당이 없는 확정 테이블",
    unit: "개",
    description: "확정 상태인데 식당 연결이 없는 테이블",
  },
  {
    key: "unassignedVenueApplications",
    label: "식당 미배정 테이블의 확정 신청",
    unit: "건",
    description: "위 테이블에 현재 확정되어 있는 신청",
  },
  {
    key: "noticeFailures",
    label: "안내·리마인드 발송 실패",
    unit: "건",
    description: "자동 재시도를 마치고도 처리되지 않은 발송",
  },
  {
    key: "sameDayCancellations",
    label: "행사 당일 취소",
    unit: "건",
    description: "한국 시간으로 행사 날짜에 취소한 신청",
  },
];

export function AdminOperationalSummary({
  summary,
}: {
  summary: OperationalSummaryData | null;
}) {
  if (!summary) return null;
  return (
    <section className="panel" aria-label="유형별 운영 현황">
      <div className="panel-title">
        <h2>유형별 운영 현황</h2>
        <span className="small muted">현재 조회 범위 기준</span>
      </div>
      {rows.map(({ key, label, unit, description }) => (
        <div className="check-row" key={key}>
          <div>
            <span>{label}</span>
            <p className="small muted">{description}</p>
          </div>
          <strong>
            {summary[key]}
            <small> {unit}</small>
          </strong>
        </div>
      ))}
      <p className="small muted">
        대안 선택 대기는 참가자가 이동·보관·환불을 고르는 정상 상태입니다.
        미처리 예외와 별도로 확인해 주세요.
      </p>
    </section>
  );
}

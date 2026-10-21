import Link from "next/link";
import { privacyPolicy } from "@/domain/privacy-policy";

export default function Page() {
  return (
    <main className="legal">
      <Link href="/app">← 우연한 식탁으로</Link>
      <h1>개인정보·탈퇴 처리 안내</h1>
      <p>{privacyPolicy.status}</p>
      {privacyPolicy.sections.map((section) => (
        <section key={section.id} aria-labelledby={`privacy-${section.id}`}>
          <h2 id={`privacy-${section.id}`}>{section.title}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
      <h2>삭제와 보존을 구분하는 기준</h2>
      <dl>
        {privacyPolicy.retention.map((item) => (
          <div key={item.id}>
            <dt>
              <strong>{item.category}</strong>
            </dt>
            <dd>
              {item.action}. {item.scope}.
            </dd>
          </div>
        ))}
      </dl>
      <p>정책 초안 버전: {privacyPolicy.version}</p>
      <Link href="/login">로그인 화면으로</Link>
    </main>
  );
}

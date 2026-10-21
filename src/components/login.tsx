"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Brand, BrandPanel, Field } from "./shared";
import Link from "next/link";
export default function Login({
  demo,
  signup = false,
}: {
  demo: boolean;
  signup?: boolean;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  // Server HTML is visible before React can preserve input and handle submits.
  useEffect(() => setReady(true), []);
  const disabled = !ready || busy;
  function selectDemo(email: string) {
    if (!emailInput.current) return;
    emailInput.current.value = email;
    emailInput.current.focus();
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    // Read both credentials from the same form, including password-manager fills.
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (signup && f.get("password") !== f.get("confirmPassword"))
        throw new Error("비밀번호 확인이 일치하지 않아요.");
      const r = await fetch(
        `/api/auth/${signup ? "sign-up" : "sign-in"}/email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: String(f.get("email") ?? "").trim(),
            password: f.get("password"),
            ...(signup ? { name: String(f.get("name") ?? "").trim() } : {}),
          }),
        },
      );
      const d = await r.json();
      if (!r.ok)
        throw new Error(
          r.status === 429
            ? "요청이 많아요. 잠시 후 다시 시도해 주세요."
            : signup
              ? "가입하지 못했어요. 입력 내용을 확인하거나 기존 계정으로 로그인해 주세요."
              : "이메일과 비밀번호를 확인해 주세요.",
        );
      location.href = ["ADMIN", "OPERATIONS", "SAFETY"].includes(d.user?.role)
        ? "/admin"
        : signup
          ? "/app?tab=profile"
          : "/app";
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인에 실패했어요.");
      setBusy(false);
    }
  }
  return (
    <main className="site-shell">
      <BrandPanel />
      <section className="phone login">
        <header>
          <Brand />
          <span className="edition">SOCIAL DINING</span>
        </header>
        <div className="login-content">
          <span className="eyebrow">YOUR NEXT GOOD EVENING</span>
          <h1>
            반가워요.
            <br />
            어떤 저녁을
            <br />
            만나고 싶나요?
          </h1>
          <p className="muted">
            {signup
              ? "내 계정을 만들고 프로필을 작성해 보세요."
              : "로그인하고 나에게 맞는 식탁을 찾아보세요."}
          </p>
          <form onSubmit={submit} aria-busy={disabled}>
            {signup && (
              <Field label="이름">
                <input
                  name="name"
                  disabled={disabled}
                  autoComplete="name"
                  required
                  maxLength={40}
                />
              </Field>
            )}
            <Field label="이메일">
              <input
                type="email"
                name="email"
                autoComplete="username"
                required
                ref={emailInput}
                defaultValue={demo && !signup ? "hello@siktak.demo" : ""}
                disabled={disabled}
              />
            </Field>
            <Field label="비밀번호">
              <input
                name="password"
                type="password"
                disabled={disabled}
                autoComplete={signup ? "new-password" : "current-password"}
                required
                minLength={8}
                maxLength={128}
                placeholder="비밀번호를 입력해 주세요"
              />
            </Field>
            {signup && (
              <Field label="비밀번호 확인">
                <input
                  name="confirmPassword"
                  type="password"
                  disabled={disabled}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                />
              </Field>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary full" disabled={disabled}>
              {busy
                ? "처리 중…"
                : signup
                  ? "가입하고 프로필 작성하기"
                  : "좋은 저녁 시작하기"}
              <ArrowRight size={18} />
            </button>
          </form>
          <p>
            <Link href={signup ? "/login" : "/signup"}>
              {signup
                ? "이미 계정이 있어요 · 로그인"
                : "처음 오셨나요? 회원가입"}
            </Link>
          </p>
          {signup && (
            <p className="muted">
              현재는 이메일 인증·분실 비밀번호 복구를 지원하지 않습니다.
              비밀번호를 안전하게 보관해 주세요. 개인정보 동의와 모임 프로필은
              가입 후 작성합니다.{" "}
              <Link href="/privacy">개인정보 처리 안내</Link>
            </p>
          )}
          {demo && !signup && (
            <div className="demo-login">
              <span className="eyebrow">테스트 계정</span>
              <p>
                참가자와 운영자의 흐름을 둘러볼 수 있어요.
                <br />
                비밀번호는 제출 양식에 적은 테스트 계정 안내를 확인해 주세요.
              </p>
              <div className="row">
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => selectDemo("hello@siktak.demo")}
                >
                  참가자
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => selectDemo("admin@siktak.demo")}
                >
                  운영자
                </button>
              </div>
            </div>
          )}
        </div>
        <footer>서로를 존중하는 마음으로, 편안한 만남을 만들어요.</footer>
      </section>
    </main>
  );
}

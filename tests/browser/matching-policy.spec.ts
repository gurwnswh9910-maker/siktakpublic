import { test, expect } from "@playwright/test";
import { loginDemo } from "./demo-login";

test("operator sees the fixed policy and cannot bypass it through the API", async ({
  page,
}) => {
  await loginDemo(page, "admin@siktak.demo", /\/admin$/);
  await page.getByRole("button", { name: "운영 설정", exact: true }).click();
  await expect(page.getByLabel("최소 매칭 점수 (0~100)")).toHaveValue("20");
  await expect(page.getByLabel("최소 매칭 점수 (0~100)")).toHaveAttribute(
    "readonly",
    "",
  );
  for (const [label, weight] of [
    ["성비", 25],
    ["MBTI", 13],
    ["관심사", 7],
    ["희망 성향", 3],
  ] as const) {
    await expect(
      page.getByLabel(`${label} 가중치`, { exact: true }),
    ).toHaveValue(String(weight));
    await expect(
      page.getByLabel(`${label} 가중치`, { exact: true }),
    ).toHaveAttribute("readonly", "");
  }
  await expect(
    page.getByRole("button", { name: "매칭 기준 저장", exact: true }),
  ).toHaveCount(0);
  const response = await page.request.post("/api/command", {
    headers: { origin: "http://localhost:3100" },
    data: {
      action: "setting",
      data: {
        key: "matchingPolicy",
        value: { minimum: 0, weights: [25, 13, 7, 3] },
      },
    },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toContain("고정");
  await page.reload();
  await page.getByRole("button", { name: "운영 설정", exact: true }).click();
  await expect(page.getByLabel("최소 매칭 점수 (0~100)")).toHaveValue("20");
});

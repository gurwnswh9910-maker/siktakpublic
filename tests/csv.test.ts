import { expect, it } from "vitest";
import { csvCell } from "@/domain/csv";
it("escapes CSV formulas after whitespace and quotes embedded delimiters", () => {
  for (const input of ["=1+1", " +SUM(1,2)", "\t@SUM(1)", "\n-1"])
    expect(csvCell(input).startsWith("\"'")).toBe(true);
  expect(csvCell('홍대, "식탁"')).toBe('"홍대, ""식탁"""');
  expect(csvCell(null)).toBe('""');
});

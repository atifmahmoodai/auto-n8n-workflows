import { formatMoney, isValidIsoDate, parseAmount, sumMoney } from "../format";

describe("parseAmount", () => {
  it.each([
    ["12.50", 12.5],
    ["12,50", 12.5],
    ["1,234.50", 1234.5],
    ["1.234,50", 1234.5],
    ["$ 3.99", 3.99],
    ["-2.00", -2],
    ["12.", 12],
    ["", null],
    ["abc", null],
  ])("%s -> %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });
});

describe("sumMoney", () => {
  it("avoids floating point drift", () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([19.99, 5.01, -1.5])).toBe(23.5);
  });
});

describe("isValidIsoDate", () => {
  it("accepts real dates only", () => {
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("28/02/2026")).toBe(false);
  });
});

describe("formatMoney", () => {
  it("falls back for invalid currency codes", () => {
    expect(formatMoney(3, "ZZ")).toBe("ZZ 3.00");
    expect(formatMoney(3, "USD")).toContain("3.00");
  });
});

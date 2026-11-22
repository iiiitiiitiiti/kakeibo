import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AMOUNT_MAX, BUDGET_MAX, CAT_NAME_MAX, MEMO_MAX, PERSON_MAX } from "../src/model";

const rules = readFileSync(resolve(process.cwd(), "firestore.rules"), "utf8");
const pick = (re: RegExp): number => {
  const m = rules.match(re);
  expect(m, String(re)).not.toBeNull();
  return Number(m![1]);
};

describe("firestore.rules の上限がアプリと揃っている", () => {
  it("金額", () => expect(pick(/d\.amount >= 1 && d\.amount <= (\d+)/)).toBe(AMOUNT_MAX));
  it("メモ", () => expect(pick(/shortString\(d\.memo, 0, (\d+)\)/)).toBe(MEMO_MAX));
  it("呼び名", () => expect(pick(/shortString\(d\.addedBy, 0, (\d+)\)/)).toBe(PERSON_MAX));
  it("カテゴリ名", () => expect(pick(/shortString\(d\.name, 1, (\d+)\)/)).toBe(CAT_NAME_MAX));
  it("予算", () => expect(pick(/d\.amount >= 0 && d\.amount <= (\d+)/)).toBe(BUDGET_MAX));
});

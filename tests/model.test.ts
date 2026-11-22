import { describe, expect, it } from "vitest";
import {
  addMonths,
  calendarWeeks,
  shortYen,
  budgetFor,
  categoryOf,
  DEFAULT_CATEGORIES,
  groupByDate,
  localDate,
  mergeCategories,
  monthRange,
  nextOrder,
  OTHER_ID,
  calcPress,
  evaluate,
  formatExpr,
  type CalcKey,
  totalsByCategory,
  yen,
  type Entry,
} from "../src/model";

const entry = (p: Partial<Entry>): Entry => ({
  id: Math.random().toString(36),
  amount: 100,
  categoryId: "food",
  date: "2026-11-22",
  memo: "",
  addedBy: "",
  createdAt: 0,
  ...p,
});

describe("localDate", () => {
  it("端末の時刻で日付を作る（世界時にしない）", () => {
    // 日本の朝7時は世界時では前日の22時
    const d = new Date(2026, 10, 22, 7, 0);
    expect(localDate(d)).toBe("2026-11-22");
  });
});

describe("addMonths / monthRange", () => {
  it("年をまたぐ", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });
  it("月の範囲は日付の文字列で比べられる", () => {
    const [from, to] = monthRange("2026-02");
    expect("2026-02-28" >= from && "2026-02-28" <= to).toBe(true);
    expect("2026-03-01" <= to).toBe(false);
  });
});

describe("budgetFor", () => {
  const budgets = [
    { month: "2026-10", amount: 150000 },
    { month: "2027-01", amount: 180000 },
  ];
  it("その月以前で一番新しい予算を使う", () => {
    expect(budgetFor("2026-12", budgets)).toBe(150000);
    expect(budgetFor("2027-03", budgets)).toBe(180000);
  });
  it("決めた月より前は予算なし", () => {
    expect(budgetFor("2026-09", budgets)).toBeNull();
  });
  it("0 は決めていない扱い", () => {
    expect(budgetFor("2027-02", [...budgets, { month: "2027-02", amount: 0 }])).toBeNull();
  });
});

describe("mergeCategories", () => {
  it("保存先が空なら最初の7種、その他が最後", () => {
    const cats = mergeCategories([]);
    expect(cats.map((c) => c.id)).toEqual(DEFAULT_CATEGORIES.map((c) => c.id));
    expect(cats.at(-1)!.id).toBe(OTHER_ID);
  });
  it("同じ ID の文書で名前や隠すを上書きし、足した分を並べる", () => {
    const cats = mergeCategories([
      { id: "food", name: "食材", order: 10, hidden: false },
      { id: "rent", name: "家賃", order: 40, hidden: true },
      { id: "abc", name: "趣味", order: 70, hidden: false },
    ]);
    expect(cats.find((c) => c.id === "food")!.name).toBe("食材");
    expect(cats.find((c) => c.id === "rent")!.hidden).toBe(true);
    expect(cats.map((c) => c.id).indexOf("abc")).toBe(cats.length - 2);
  });
  it("全部隠したらその他を出す", () => {
    const cats = mergeCategories(DEFAULT_CATEGORIES.map((c) => ({ ...c, hidden: true })));
    expect(cats.filter((c) => !c.hidden).map((c) => c.id)).toEqual([OTHER_ID]);
  });
  it("見つからないカテゴリの記録はその他", () => {
    expect(categoryOf("gone", mergeCategories([])).id).toBe(OTHER_ID);
  });
  it("新しいカテゴリはその他の前", () => {
    const cats = mergeCategories([]);
    expect(nextOrder(cats)).toBe(70);
    expect(nextOrder(cats)).toBeLessThan(1000);
  });
});

describe("電卓", () => {
  const press = (...keys: CalcKey[]) => keys.reduce((e, k) => calcPress(e, k), "");
  it("頭の0は付かない・00で桁が増える", () => {
    expect(press("0", "0")).toBe("");
    expect(press("1", "2", "00")).toBe("1200");
    expect(press("5", "+", "0", "7")).toBe("5+7");
  });
  it("記号は続けて押すと置き換わり、式の頭には置かない", () => {
    expect(press("+")).toBe("");
    expect(press("3", "+", "×")).toBe("3×");
  });
  it("掛け算・割り算が先", () => {
    expect(evaluate("100+200×3")).toBe(700);
    expect(evaluate("1000−300÷3")).toBe(900);
  });
  it("割り切れないときは四捨五入、0で割ると null", () => {
    expect(evaluate("1000÷3")).toBe(333);
    expect(evaluate("1000÷0")).toBeNull();
  });
  it("最後の記号は無視する", () => {
    expect(evaluate("1280+")).toBe(1280);
  });
  it("= で答えに置き換わる。0以下なら式のまま", () => {
    expect(press("1", "2", "0", "0", "÷", "4", "=")).toBe("300");
    expect(press("1", "−", "5", "=")).toBe("1−5");
  });
  it("1つの数は7桁まで", () => {
    expect(press("9", "9", "9", "9", "9", "9", "9", "9")).toBe("9999999");
    expect(press("9", "9", "9", "9", "9", "9", "9", "+", "1")).toBe("9999999+1");
  });
  it("1文字消す・全部消す", () => {
    expect(press("1", "2", "+", "back")).toBe("12");
    expect(press("1", "2", "C")).toBe("");
  });
  it("式の見せ方", () => {
    expect(formatExpr("12800+1500×2")).toBe("12,800 + 1,500 × 2");
  });
});

describe("集計", () => {
  const cats = mergeCategories([]);
  const list = [
    entry({ amount: 300, categoryId: "food", date: "2026-11-01", createdAt: 1 }),
    entry({ amount: 1000, categoryId: "eatout", date: "2026-11-02", createdAt: 2 }),
    entry({ amount: 200, categoryId: "food", date: "2026-11-02", createdAt: 3 }),
    entry({ amount: 50, categoryId: "gone", date: "2026-11-02", createdAt: 4 }),
  ];
  it("カテゴリ別は多い順、消えたカテゴリはその他にまとめる", () => {
    const t = totalsByCategory(list, cats);
    expect(t.map((x) => [x.category.id, x.total])).toEqual([
      ["eatout", 1000],
      ["food", 500],
      [OTHER_ID, 50],
    ]);
  });
  it("日付ごとは新しい日が先、日の合計つき", () => {
    const days = groupByDate(list);
    expect(days.map((d) => [d.date, d.total])).toEqual([
      ["2026-11-02", 1250],
      ["2026-11-01", 300],
    ]);
    expect(days[0].entries[0].createdAt).toBe(4);
  });
  it("円の表示", () => {
    expect(yen(1234567)).toBe("¥1,234,567");
    expect(yen(-500)).toBe("−¥500");
  });
});

describe("calendarWeeks", () => {
  it("2026年11月は日曜はじまりで5行、合計と件数が入る", () => {
    const w = calendarWeeks("2026-11", [
      entry({ amount: 300, date: "2026-11-01" }),
      entry({ amount: 200, date: "2026-11-01" }),
      entry({ amount: 900, date: "2026-11-30" }),
    ]);
    expect(w.length).toBe(5);
    expect(w[0][0]).toMatchObject({ date: "2026-11-01", total: 500, count: 2 });
    expect(w[4][1]).toMatchObject({ date: "2026-11-30", total: 900 });
    expect(w[4][2].date).toBeNull();
  });
  it("前の空きを埋める（2026年10月1日は木曜）", () => {
    const w = calendarWeeks("2026-10", []);
    expect(w[0].slice(0, 4).map((c) => c.date)).toEqual([null, null, null, null]);
    expect(w[0][4].date).toBe("2026-10-01");
  });
});

describe("shortYen", () => {
  it("1万未満はそのまま、1万以上は万で", () => {
    expect(shortYen(9800)).toBe("9,800");
    expect(shortYen(12800)).toBe("1.2万");
    expect(shortYen(30000)).toBe("3万");
    expect(shortYen(150000)).toBe("15万");
  });
});

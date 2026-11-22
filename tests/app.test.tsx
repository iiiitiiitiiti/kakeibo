import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeCategories, type Entry } from "../src/model";

/*
 * 画面の流れを、保存先につながずに確かめる。
 * useBook を差し替え、本物の家計簿には何も書かない。
 */
const store = vi.hoisted(() => {
  let value: unknown = null;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next: unknown) => {
      value = next;
      subs.forEach((f) => f());
    },
    sub: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
});

vi.mock("../src/useBook", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useBook: () => useSyncExternalStore(store.sub, store.get) };
});

const { App } = await import("../src/App");

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

const makeBook = (over: Record<string, unknown> = {}) => ({
  state: "ready",
  synced: true,
  monthReady: true,
  recent: [] as Entry[],
  monthEntries: [entry({ amount: 30000 })],
  categories: mergeCategories([]),
  budgets: [{ month: "2026-11", amount: 100000 }],
  categoryBudgets: [] as { month: string; categoryId: string; amount: number }[],
  unsettled: [] as Entry[],
  add: vi.fn(() => "new-id"),
  update: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  saveCategory: vi.fn(),
  swapCategories: vi.fn(),
  addCategory: vi.fn(() => "cat-id"),
  setBudget: vi.fn(),
  setCategoryBudget: vi.fn(),
  setSettled: vi.fn(),
  ...over,
});

let root: Root;
let host: HTMLDivElement;

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const type = (keys: string[]) =>
  act(() => {
    for (const key of keys) window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const pick = (sel: string, value: string) =>
  act(() => {
    const el = $<HTMLSelectElement>(sel);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
const fill = (sel: string, value: string) =>
  act(() => {
    const el = $<HTMLInputElement>(sel);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = (el: Element) => act(() => (el as HTMLElement).click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 22, 12, 0));
  localStorage.setItem("kakeibo:me", "たろう");
  window.location.hash = `#k=${"a".repeat(32)}`;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  localStorage.clear();
});

const render = (book = makeBook()) => {
  store.set(book);
  act(() => root.render(<App />));
  return book;
};

describe("記録する", () => {
  it("金額とカテゴリを入れて記録すると、今月の残りを知らせる", async () => {
    const book = render();
    expect($(".date-text.full").textContent).toBe("11月22日(日)");
    expect($<HTMLButtonElement>(".submit").disabled).toBe(true);

    await type(["1", "2", "8", "0"]);
    await pick(".cat-select select", "food");
    expect($(".amount").textContent).toBe("¥1,280");
    await click($(".submit"));

    expect(book.add).toHaveBeenCalledWith({ amount: 1280, categoryId: "food", date: "2026-11-22", memo: "" });
    // 予算 10万 − これまでの 3万 − 今回の 1,280
    expect($(".toast").textContent).toContain("食費 ¥1,280 を記録");
    expect($(".toast").textContent).toContain("今月の残り ¥68,720");
    // 記録したら金額とカテゴリは空に戻る
    expect($(".amount").textContent).toBe("¥0");
    expect($<HTMLSelectElement>(".cat-select select").value).toBe("");
  });

  it("予算を超えたら超えた額を知らせ、予算が無ければ残りは出さない", async () => {
    render(makeBook({ monthEntries: [entry({ amount: 99500 })] }));
    await type(["1", "0", "0", "0"]);
    await pick(".cat-select select", "food");
    await click($(".submit"));
    expect($(".toast").textContent).toContain("今月の予算を ¥500 超えています");

    render(makeBook({ budgets: [] }));
    await type(["5", "0", "0"]);
    await pick(".cat-select select", "food");
    await click($(".submit"));
    expect($(".toast").textContent).toContain("食費 ¥500 を記録");
    expect($(".toast").textContent).not.toContain("今月");
  });

  it("選んだ日付は記録したあとも残る（前の月の分は今月の残りに入れない）", async () => {
    const book = render();
    await fill(".date-field input", "2026-10-30");
    expect($(".date-text.full").textContent).toBe("10月30日(金)");
    expect($(".date-field").className).toContain("other");

    await type(["3", "0", "0"]);
    await pick(".cat-select select", "daily");
    await click($(".submit"));

    expect(book.add).toHaveBeenCalledWith({ amount: 300, categoryId: "daily", date: "2026-10-30", memo: "" });
    expect($(".toast").textContent).not.toContain("今月の残り");
    expect($(".date-text.full").textContent).toBe("10月30日(金)");
  });

  it("選んだ日付はその日のうちだけ有効で、日が変わったら今日に戻る。先の日付は受け取らない", async () => {
    render();
    await fill(".date-field input", "2026-11-20");
    expect($(".date-text.full").textContent).toBe("11月20日(金)");
    await fill(".date-field input", "2026-11-25");
    expect($(".date-text.full").textContent).toBe("11月20日(金)");

    vi.setSystemTime(new Date(2026, 10, 25, 9, 0));
    await act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect($(".date-text.full").textContent).toBe("11月25日(水)");
    expect($(".date-field").className).not.toContain("other");
  });

  it("日付を選んでいなければ、開いたまま日をまたいでも今日に付いていく", async () => {
    render();
    expect($(".date-text.full").textContent).toBe("11月22日(日)");
    vi.setSystemTime(new Date(2026, 10, 23, 0, 5));
    await act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect($(".date-text.full").textContent).toBe("11月23日(月)");
    expect($(".date-field").className).not.toContain("other");
  });

  it("0時を過ぎたら、何もしなくてもすぐ今日の日付に変わる", async () => {
    vi.setSystemTime(new Date(2026, 10, 22, 23, 59, 50));
    render();
    expect($(".date-text.full").textContent).toBe("11月22日(日)");
    await act(() => vi.advanceTimersByTime(11000));
    expect($(".date-text.full").textContent).toBe("11月23日(月)");
  });

  it("カテゴリの予算があれば、そのカテゴリの残りを知らせる。超えたら超えた額を先に知らせる", async () => {
    render(
      makeBook({
        monthEntries: [entry({ amount: 30000, categoryId: "food" }), entry({ amount: 5000, categoryId: "daily" })],
        categoryBudgets: [
          { month: "2026-10", categoryId: "food", amount: 31000 },
          { month: "2026-11", categoryId: "daily", amount: 0 },
        ],
      }),
    );
    await type(["4", "0", "0"]);
    await pick(".cat-select select", "food");
    await click($(".submit"));
    expect($(".toast").textContent).toContain("食費の残り ¥600");

    await type(["1", "3", "0", "0"]);
    await pick(".cat-select select", "food");
    await click($(".submit"));
    expect($(".toast").textContent).toContain("食費の予算を ¥300 超えています");

    // 0 にしたカテゴリは「決めていない」。全体の残りを出す
    await type(["1", "0", "0"]);
    await pick(".cat-select select", "daily");
    await click($(".submit"));
    expect($(".toast").textContent).toContain("今月の残り ¥64,900");
  });

  it("プルダウンの最後からカテゴリの整理を開いても、選んでいたカテゴリは変わらない", async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    render();
    await pick(".cat-select select", "eatout");
    await pick(".cat-select select", "__edit__");
    expect($("dialog h2").textContent).toBe("カテゴリの整理");
    expect($<HTMLSelectElement>(".cat-select select").value).toBe("eatout");

    // 閉じるを押すと、閉じる動きのあとで外れる
    await click($("dialog .icon-btn"));
    expect($("dialog").className).toContain("closing");
    await act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector("dialog")).toBeNull();
  });
});

describe("未精算", () => {
  const showModal = () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  };

  it("「自分で払った」を選んで記録すると未精算になり、次の記録では元に戻る", async () => {
    const book = render();
    await type(["9", "0", "0"]);
    await pick(".cat-select select", "food");
    expect($(".pay-toggle").getAttribute("aria-pressed")).toBe("false");
    await click($(".pay-toggle"));
    expect($(".pay-toggle").getAttribute("aria-pressed")).toBe("true");
    await click($(".submit"));

    expect(book.add).toHaveBeenCalledWith({ amount: 900, categoryId: "food", date: "2026-11-22", memo: "", pay: "unsettled" });
    // 立て替えた分も共通の出費として残りから引く
    expect($(".toast").textContent).toContain("食費 ¥900 を未精算で記録");
    expect($(".toast").textContent).toContain("今月の残り ¥69,100");
    expect($(".pay-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("未精算の記録に印を付け、今月の画面に合計の入口を出す", async () => {
    const mine = entry({ id: "u1", amount: 1200, settled: false, paidBy: "たろう" });
    render(makeBook({ recent: [mine, entry({ id: "s1", settled: true, paidBy: "たろう" }), entry({ id: "n1" })], unsettled: [mine] }));
    const tags = [...document.querySelectorAll(".recent li")].map((li) => li.querySelector(".unsettled-tag")?.textContent ?? "");
    expect(tags).toEqual(["未精算", "", ""]);

    await click(document.querySelectorAll(".tabs button")[1]);
    expect($(".unsettled-link").textContent).toBe("未精算¥1,200");
  });

  it("未精算が無ければ、今月の画面に入口を出さない", async () => {
    render();
    await click(document.querySelectorAll(".tabs button")[1]);
    expect(document.querySelector(".unsettled-link")).toBeNull();
  });

  it("払った人ごとに並べ、まとめても1件ずつも精算済みにできる。元にも戻せる", async () => {
    showModal();
    const list = [
      entry({ id: "a", amount: 1000, date: "2026-11-20", settled: false, paidBy: "たろう" }),
      entry({ id: "b", amount: 500, date: "2026-10-30", settled: false, paidBy: "たろう" }),
      entry({ id: "c", amount: 800, settled: false, paidBy: "はなこ" }),
    ];
    const book = render(makeBook({ unsettled: list }));
    const open = async () => {
      await click(document.querySelectorAll(".tabs button")[1]);
      await click($(".unsettled-link"));
    };
    await open();
    const people = [...document.querySelectorAll(".unsettled-person")];
    expect(people.map((p) => p.querySelector("h3")!.textContent)).toEqual(["たろうに返す¥1,500", "はなこに返す¥800"]);
    // 古い日付から並べる
    expect([...people[0].querySelectorAll(".entry-sub")].map((x) => x.textContent)).toEqual(["10月30日(金)", "11月20日(金)"]);
    // 1件しか無い人には「まとめて」を出さない
    expect(people[1].querySelector(".btn.primary")).toBeNull();

    await click(people[0].querySelector(".btn.primary")!);
    expect(book.setSettled).toHaveBeenLastCalledWith(["b", "a"], true);
    await act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector("dialog")).toBeNull();
    expect($(".toast").textContent).toContain("¥1,500 を精算済みにしました");
    await click($(".toast button"));
    expect(book.setSettled).toHaveBeenLastCalledWith(["b", "a"], false);

    await click($(".unsettled-link"));
    await click(document.querySelectorAll(".unsettled-person")[1].querySelector(".unsettled-row .btn")!);
    expect(book.setSettled).toHaveBeenLastCalledWith(["c"], true);
  });

  it("記録を直す画面で払った財布を変えられる。相手が払った分は相手の名前のまま", async () => {
    showModal();
    const theirs = entry({ id: "t", amount: 700, settled: false, paidBy: "はなこ" });
    const shared = entry({ id: "n", amount: 300, addedBy: "たろう" });
    const forgotten = entry({ id: "f", amount: 400, addedBy: "はなこ" });
    const book = render(makeBook({ recent: [theirs, shared, forgotten], unsettled: [theirs] }));
    const rows = () => [...document.querySelectorAll<HTMLElement>(".recent .entry")];
    const paySelect = () => [...document.querySelectorAll<HTMLSelectElement>("dialog select")].at(-1)!;
    const choose = (value: string) =>
      act(() => {
        const el = paySelect();
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });

    await click(rows()[0]);
    expect([...paySelect().options].map((o) => o.textContent)).toEqual([
      "共通の財布",
      "はなこが払った・未精算",
      "はなこが払った・精算済み",
    ]);
    expect(paySelect().value).toBe("unsettled");
    await choose("settled");
    await act(() => $<HTMLFormElement>("dialog form").requestSubmit());
    expect(book.update).toHaveBeenLastCalledWith(
      "t",
      { amount: 700, categoryId: "food", date: "2026-11-22", memo: "", pay: "settled" },
      "はなこ",
    );
    await act(() => vi.advanceTimersByTime(300));

    // 共通の財布の記録を、あとから自分で払ったことにする。変えなければ財布のことは書かない
    await click(rows()[1]);
    expect(paySelect().options[1].textContent).toBe("自分で払った・未精算");
    await act(() => $<HTMLFormElement>("dialog form").requestSubmit());
    expect(book.update).toHaveBeenLastCalledWith("n", { amount: 300, categoryId: "food", date: "2026-11-22", memo: "" }, "たろう");
    await act(() => vi.advanceTimersByTime(300));
    await click(rows()[1]);
    await choose("unsettled");
    await act(() => $<HTMLFormElement>("dialog form").requestSubmit());
    expect(book.update).toHaveBeenLastCalledWith(
      "n",
      { amount: 300, categoryId: "food", date: "2026-11-22", memo: "", pay: "unsettled" },
      "たろう",
    );
    await act(() => vi.advanceTimersByTime(300));

    // 相手が付け忘れた記録をこちらで未精算にしても、払った人は記録した相手
    await click(rows()[2]);
    expect(paySelect().options[1].textContent).toBe("はなこが払った・未精算");
    await choose("unsettled");
    await act(() => $<HTMLFormElement>("dialog form").requestSubmit());
    expect(book.update).toHaveBeenLastCalledWith(
      "f",
      { amount: 400, categoryId: "food", date: "2026-11-22", memo: "", pay: "unsettled" },
      "はなこ",
    );
  });
});

describe("届いた記録", () => {
  it("開いたあとに届いた記録だけ色を付ける", async () => {
    const first = entry({ id: "e1", createdAt: 1 });
    render(makeBook({ recent: [first] }));
    expect(document.querySelector(".recent li.flash")).toBeNull();

    const arrived = entry({ id: "e2", createdAt: Date.now(), addedBy: "はな" });
    // 1件消えて繰り上がってきた古い記録は、届いた記録に数えない
    const old = entry({ id: "e0", createdAt: 0 });
    await act(() => store.set(makeBook({ recent: [arrived, first, old] })));
    const rows = [...document.querySelectorAll(".recent li")];
    expect(rows[0].className).toBe("flash");
    expect(rows[1].className).toBe("");
    expect(rows[2].className).toBe("");

    await act(() => vi.advanceTimersByTime(2100));
    expect(document.querySelector(".recent li.flash")).toBeNull();
  });

  it("まだ届いていない記録には送信待ちを付ける", () => {
    render(makeBook({ recent: [entry({ id: "p1", pending: true }), entry({ id: "p2" })] }));
    const rows = [...document.querySelectorAll(".recent li")];
    expect(rows[0].textContent).toContain("送信待ち");
    expect(rows[1].textContent).not.toContain("送信待ち");
  });
});

describe("今月", () => {
  it("残りと、月末までの日数・1日あたりの額を出す", async () => {
    render();
    await click(document.querySelectorAll(".tabs button")[1]);
    expect($(".summary-big").textContent).toBe("¥70,000");
    expect($(".summary-pace").textContent).toBe("月末まで9日・1日あたり ¥7,777");
  });

  it("読み終える前は金額を出さない", async () => {
    render(makeBook({ monthReady: false, monthEntries: [] }));
    await click(document.querySelectorAll(".tabs button")[1]);
    expect($(".summary-big").textContent).toBe("…");
    await click($(".cal-day.today"));
    expect($(".days .muted").textContent).toBe("読み込んでいます…");
  });

  it("カテゴリ別の行を押すと、そのカテゴリの記録が開く", async () => {
    render(
      makeBook({
        monthEntries: [
          entry({ id: "a", amount: 500, categoryId: "food", memo: "セブン" }),
          entry({ id: "b", amount: 900, categoryId: "daily", memo: "ニトリ" }),
        ],
      }),
    );
    await click(document.querySelectorAll(".tabs button")[1]);
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".cat-total")];
    expect(rows.map((r) => r.querySelector(".bar-label")!.textContent)).toEqual(["日用品", "食費"]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");

    await click(rows[0]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    const fold = rows[0].nextElementSibling!;
    expect(fold.className).toBe("fold open");
    expect(fold.textContent).toContain("ニトリ");
    expect(fold.textContent).not.toContain("セブン");
  });

  it("予算を決めたカテゴリは残りを出し、超えたら赤くする。隠したカテゴリの予算は使わない", async () => {
    const cats = mergeCategories([{ id: "eatout", name: "外食", order: 30, hidden: true }]);
    render(
      makeBook({
        categories: cats,
        monthEntries: [
          entry({ amount: 5000, categoryId: "food" }),
          entry({ amount: 900, categoryId: "daily" }),
          entry({ amount: 300, categoryId: "eatout" }),
          entry({ amount: 100, categoryId: "phone" }),
        ],
        categoryBudgets: [
          { month: "2026-09", categoryId: "food", amount: 4000 },
          { month: "2026-11", categoryId: "daily", amount: 1800 },
          { month: "2026-11", categoryId: "eatout", amount: 100 },
          { month: "2026-12", categoryId: "phone", amount: 50 },
        ],
      }),
    );
    await click(document.querySelectorAll(".tabs button")[1]);
    const row = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".cat-total")].find((r) => r.querySelector(".bar-label")!.textContent === name)!;

    expect(row("食費").className).toBe("cat-total over");
    expect(row("食費").querySelector(".cat-budget")!.textContent).toBe("予算 ¥4,000・¥1,000 超え");
    expect(row("食費").querySelector<HTMLElement>(".bar span")!.style.width).toBe("100%");
    expect(row("日用品").className).toBe("cat-total");
    expect(row("日用品").querySelector(".cat-budget")!.textContent).toBe("予算 ¥1,800・残り ¥900");
    expect(row("日用品").querySelector<HTMLElement>(".bar span")!.style.width).toBe("50%");
    expect(row("外食").querySelector(".cat-budget")).toBeNull();
    expect(row("通信").querySelector(".cat-budget")).toBeNull();
  });

  it("月の予算の画面でカテゴリごとの額を入れると、変わった分だけ保存する", async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    // メニューは、ホーム画面に追加済みかどうかを調べる
    window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    const book = render(
      makeBook({
        categoryBudgets: [
          { month: "2026-10", categoryId: "food", amount: 40000 },
          { month: "2026-10", categoryId: "daily", amount: 8000 },
        ],
      }),
    );
    await click($('[aria-label="メニュー"]'));
    await click([...document.querySelectorAll("dialog button")].find((b) => b.textContent!.includes("月の予算"))!);
    const input = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".cat-budget-row")]
        .find((r) => r.querySelector(".cat-budget-name")!.textContent === name)!
        .querySelector("input")!;
    expect(input("食費").value).toBe("40000");
    expect(input("外食").value).toBe("");

    const set = (el: HTMLInputElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await set(input("外食"), "12000");
    await set(input("日用品"), "");
    await act(() => $<HTMLFormElement>("dialog form").requestSubmit());

    expect(book.setBudget).not.toHaveBeenCalled();
    expect(book.setCategoryBudget.mock.calls).toEqual([
      ["2026-11", "daily", 0],
      ["2026-11", "eatout", 12000],
    ]);
    expect($(".toast").textContent).toContain("カテゴリの予算を保存しました");
  });

  it("予算の画面を開いたあとで予算が届いても、触っていない欄を空で上書きしない", async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    const first = render(makeBook({ budgets: [] }));
    await click($('[aria-label="メニュー"]'));
    await click([...document.querySelectorAll("dialog button")].find((b) => b.textContent!.includes("月の予算"))!);
    // 開いている間に、全体の予算とカテゴリの予算が届く（相手が決めた）
    const late = makeBook({
      budgets: [{ month: "2026-11", amount: 100000 }],
      categoryBudgets: [{ month: "2026-11", categoryId: "food", amount: 40000 }],
    });
    await act(() => store.set(late));
    await act(() => $<HTMLFormElement>("dialog form").requestSubmit());
    for (const b of [first, late]) {
      expect(b.setBudget).not.toHaveBeenCalled();
      expect(b.setCategoryBudget).not.toHaveBeenCalled();
    }
  });

  it("カレンダーで選んだ日から「この日に記録する」を押すと、その日付で記録画面が開く", async () => {
    window.scrollTo = vi.fn();
    const book = render();
    await click(document.querySelectorAll(".tabs button")[1]);
    expect(document.querySelector(".day-add")).toBeNull();
    // 月の記録は並べない。日を選ぶまでは案内だけ
    expect(document.querySelector(".days .entries")).toBeNull();
    expect($(".days").textContent).toBe("日付を押すと、その日の記録が出ます");

    const day = (n: string) => [...document.querySelectorAll(".cal-day")].find((b) => b.querySelector(".cal-num")?.textContent === n)!;
    // 先の日には出さない
    await click(day("25"));
    expect(document.querySelector(".day-add")).toBeNull();

    await click(day("22"));
    expect($(".days-head").textContent).toBe("11月22日(日)¥30,000");
    expect(document.querySelectorAll(".days .entry-row, .days .entries > li").length).toBe(1);

    await click(day("20"));
    expect($(".days-head").textContent).toBe("11月20日(金)");
    expect($(".days .muted").textContent).toBe("この日の記録はありません");
    expect($(".day-add").textContent).toBe("この日に記録する");
    await click($(".day-add"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect($(".date-text.full").textContent).toBe("11月20日(金)");
    expect($(".date-field").className).toContain("other");

    await type(["8", "0", "0"]);
    await pick(".cat-select select", "food");
    await click($(".submit"));
    expect(book.add).toHaveBeenCalledWith({ amount: 800, categoryId: "food", date: "2026-11-20", memo: "" });
    expect($(".toast").textContent).toContain("今月の残り ¥69,200");

    // 上の「記録」から開き直したときは今日で始める
    await click(document.querySelectorAll(".tabs button")[1]);
    await click(document.querySelectorAll(".tabs button")[0]);
    expect($(".date-text.full").textContent).toBe("11月22日(日)");
  });

  it("今日を選んで「この日に記録する」を押すと、今日の日付で開く", async () => {
    window.scrollTo = vi.fn();
    render();
    await click(document.querySelectorAll(".tabs button")[1]);
    await click($(".cal-day.today"));
    await click($(".day-add"));
    expect($(".date-text.full").textContent).toBe("11月22日(日)");
    expect($(".date-field").className).not.toContain("other");
    expect($<HTMLInputElement>(".memo-field input").placeholder).toBe("メモ(店名など)");
  });
});

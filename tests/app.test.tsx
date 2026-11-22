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
  add: vi.fn(() => "new-id"),
  update: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  saveCategory: vi.fn(),
  swapCategories: vi.fn(),
  addCategory: vi.fn(() => "cat-id"),
  setBudget: vi.fn(),
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

  it("カレンダーで選んだ日から「この日に記録する」を押すと、その日付で記録画面が開く", async () => {
    window.scrollTo = vi.fn();
    const book = render();
    await click(document.querySelectorAll(".tabs button")[1]);
    expect(document.querySelector(".day-add")).toBeNull();

    const day = (n: string) => [...document.querySelectorAll(".cal-day")].find((b) => b.querySelector(".cal-num")?.textContent === n)!;
    // 先の日には出さない
    await click(day("25"));
    expect(document.querySelector(".day-add")).toBeNull();

    await click(day("20"));
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

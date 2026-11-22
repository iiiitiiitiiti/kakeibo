/** 1件の金額の上限（円）。firestore.rules の validEntry と揃える */
export const AMOUNT_MAX = 9999999;
/** 月の予算の上限（円）。firestore.rules の validBudget と揃える */
export const BUDGET_MAX = 99999999;
/** メモの長さの上限。firestore.rules と揃える */
export const MEMO_MAX = 40;
/** カテゴリ名の長さの上限。firestore.rules と揃える */
export const CAT_NAME_MAX = 12;
/** 書いた人の呼び名の長さの上限。firestore.rules と揃える */
export const PERSON_MAX = 20;
/** 記録画面に出す最近の記録の数 */
export const RECENT_COUNT = 10;

export interface Entry {
  id: string;
  amount: number;
  categoryId: string;
  /** 端末のローカル日付 YYYY-MM-DD */
  date: string;
  memo: string;
  addedBy: string;
  createdAt: number;
}

export interface Category {
  id: string;
  name: string;
  order: number;
  hidden: boolean;
}

export interface Budget {
  /** YYYY-MM */
  month: string;
  amount: number;
}

export const OTHER_ID = "other";

/**
 * 最初からあるカテゴリ。保存先には持たず、2人が変えた分（名前・並び・隠す）だけを同じ ID の文書で上書きする。
 * 最初に保存先へ書き込む方式だと、2台目の初回起動で1台目の変更を元に戻してしまうため。
 */
export const DEFAULT_CATEGORIES: readonly Category[] = [
  { id: "food", name: "食費", order: 10, hidden: false },
  { id: "daily", name: "日用品", order: 20, hidden: false },
  { id: "eatout", name: "外食", order: 30, hidden: false },
  { id: "rent", name: "家賃", order: 40, hidden: false },
  { id: "utility", name: "光熱費", order: 50, hidden: false },
  { id: "phone", name: "通信", order: 60, hidden: false },
  { id: OTHER_ID, name: "その他", order: 1000, hidden: false },
];

/** 最初からあるカテゴリに、保存先の文書（上書き分と足した分）を重ねて並べる */
export function mergeCategories(stored: readonly Category[]): Category[] {
  const byId = new Map<string, Category>();
  for (const c of DEFAULT_CATEGORIES) byId.set(c.id, { ...c });
  for (const c of stored) byId.set(c.id, { ...c });
  const all = [...byId.values()];
  // 全部を隠すと記録できなくなるので、そのときは「その他」を出す
  if (all.every((c) => c.hidden)) {
    const other = all.find((c) => c.id === OTHER_ID);
    if (other) other.hidden = false;
  }
  return all.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ja"));
}

/** 記録の categoryId から表示するカテゴリを引く。見つからなければ「その他」 */
export function categoryOf(id: string, cats: readonly Category[]): Category {
  return (
    cats.find((c) => c.id === id) ??
    cats.find((c) => c.id === OTHER_ID) ??
    DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1]
  );
}

/** 新しく足すカテゴリの並び順。「その他」より前の最後に置く */
export function nextOrder(cats: readonly Category[]): number {
  const before = cats.filter((c) => c.id !== OTHER_ID).map((c) => c.order);
  const other = cats.find((c) => c.id === OTHER_ID)?.order ?? 1000;
  const max = before.length ? Math.max(...before) : 0;
  const next = max + 10;
  return next < other ? next : (max + other) / 2;
}

/** 全角半角・空白の違いをそろえ、長さを切る */
export function cleanText(v: string, max: number): string {
  return v.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 端末のローカル時刻での日付。toISOString は世界時なので、日本の朝9時前が前日になる */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export const monthOf = (date: string): string => date.slice(0, 7);

/** 月をずらす（"2026-01" に -1 → "2025-12"） */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** その月の記録を取る範囲（日付の文字列で比べる） */
export function monthRange(month: string): [string, string] {
  return [`${month}-01`, `${month}-31`];
}

/** その月の予算。その月か、それより前で一番新しい月の値。0 は「決めていない」 */
export function budgetFor(month: string, budgets: readonly Budget[]): number | null {
  let best: Budget | null = null;
  for (const b of budgets) {
    if (b.month <= month && (!best || b.month > best.month)) best = b;
  }
  return best && best.amount > 0 ? best.amount : null;
}

export interface CategoryTotal {
  category: Category;
  total: number;
}

/** カテゴリごとの合計（多い順） */
export function totalsByCategory(entries: readonly Entry[], cats: readonly Category[]): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>();
  for (const e of entries) {
    const c = categoryOf(e.categoryId, cats);
    const t = map.get(c.id) ?? { category: c, total: 0 };
    t.total += e.amount;
    map.set(c.id, t);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.category.order - b.category.order);
}

export const sum = (entries: readonly Entry[]): number => entries.reduce((n, e) => n + e.amount, 0);

export interface EntryDay {
  date: string;
  total: number;
  entries: Entry[];
}

/** 日付ごとにまとめる（新しい日が先、同じ日の中は書いた順の新しい方が先） */
export function groupByDate(entries: readonly Entry[]): EntryDay[] {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = map.get(e.date) ?? [];
    list.push(e);
    map.set(e.date, list);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => ({
      date,
      total: sum(list),
      entries: list.sort((a, b) => b.createdAt - a.createdAt),
    }));
}

const yenFmt = new Intl.NumberFormat("ja-JP");
export const yen = (n: number): string => `${n < 0 ? "−" : ""}¥${yenFmt.format(Math.abs(n))}`;

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** 「11月22日(日)」。今日・昨日は言葉で */
export function dateLabel(date: string, today: string = localDate()): string {
  if (date === today) return "今日";
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (date === localDate(yest) && today === localDate()) return "昨日";
  const head = String(y) === today.slice(0, 4) ? "" : `${y}年`;
  return `${head}${m}月${d}日(${WEEK[t.getDay()]})`;
}

export const monthLabel = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
};

/** 数字キーで打った文字列に1文字足す。上限を超える・先頭の0は受け付けない */
export function pushDigit(current: string, key: string): string {
  const next = current === "0" ? key.replace(/^0+/, "") : current + key;
  if (next === "" || /^0+$/.test(next)) return "";
  return Number(next) > AMOUNT_MAX ? current : next;
}

export function keyFromHash(hash: string): string | null {
  const m = /(?:^#|&)k=([0-9a-f]{32})(?:&|$)/.exec(hash);
  return m ? m[1] : null;
}

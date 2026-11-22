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
  /** まだ保存先に届いていない（電波が無い所で書いた） */
  pending?: boolean;
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
  { id: "utility", name: "水道・光熱費", order: 50, hidden: false },
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

/** カテゴリごとの月の予算。保存先の文書 ID は `YYYY-MM_カテゴリID`（firestore.rules の catBudgets と揃える） */
export interface CategoryBudget {
  /** YYYY-MM */
  month: string;
  categoryId: string;
  amount: number;
}

export const categoryBudgetId = (month: string, categoryId: string): string => `${month}_${categoryId}`;

/** 文書 ID を月とカテゴリに分ける。形が違えば null */
export function parseCategoryBudgetId(id: string): { month: string; categoryId: string } | null {
  const m = /^(\d{4}-(?:0[1-9]|1[0-2]))_([A-Za-z0-9]{1,40})$/.exec(id);
  return m ? { month: m[1], categoryId: m[2] } : null;
}

/**
 * その月のカテゴリごとの予算。月全体の予算と同じく、カテゴリごとに「その月か、それより前で一番新しい月の値」を使う。
 * 0 は「決めていない」なので入れない。
 */
export function categoryBudgetsFor(month: string, list: readonly CategoryBudget[]): Map<string, number> {
  const best = new Map<string, CategoryBudget>();
  for (const b of list) {
    if (b.month > month) continue;
    const cur = best.get(b.categoryId);
    if (!cur || b.month > cur.month) best.set(b.categoryId, b);
  }
  const out = new Map<string, number>();
  for (const b of best.values()) if (b.amount > 0) out.set(b.categoryId, b.amount);
  return out;
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

export interface Pace {
  /** 今日を含めた月末までの日数 */
  daysLeft: number;
  /** 残りを日数で割った、1日に使える額（円未満は切り捨て。残りが無ければ 0） */
  perDay: number;
}

/** 今見ている月が今月のときの、月末までの日数と1日に使える額。今月でなければ null */
export function paceFor(month: string, today: string, left: number): Pace | null {
  if (monthOf(today) !== month) return null;
  const [y, m] = month.split("-").map(Number);
  const daysLeft = new Date(y, m, 0).getDate() - Number(today.slice(8)) + 1;
  return { daysLeft, perDay: left > 0 ? Math.floor(left / daysLeft) : 0 };
}

/** そのカテゴリで前に書いたメモ（新しい順・同じものは1つ・n 件まで）。メモを打つときの候補に出す */
export function memoSuggestions(entries: readonly Entry[], categoryId: string | null, n = 8): string[] {
  const seen = new Set<string>();
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  for (const e of sorted) {
    if (seen.size >= n) break;
    if (e.memo && (categoryId === null || e.categoryId === categoryId)) seen.add(e.memo);
  }
  return [...seen];
}

/** パソコンのキーボードのキーを電卓のキーに読み替える。関係ないキーは null */
export function calcKeyFromKeyboard(key: string): CalcKey | null {
  if (/^[0-9]$/.test(key)) return key as CalcKey;
  const map: Record<string, CalcKey> = {
    "+": "+",
    "-": "−",
    "*": "×",
    "/": "÷",
    "=": "=",
    Backspace: "back",
    Delete: "C",
    Escape: "C",
  };
  return map[key] ?? null;
}

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

/** 「11月22日(日)」。今年でなければ頭に年を付ける */
export function dateLabel(date: string, today: string = localDate()): string {
  const [y, m, d] = date.split("-").map(Number);
  const head = String(y) === today.slice(0, 4) ? "" : `${y}年`;
  return `${head}${m}月${d}日(${WEEK[new Date(y, m - 1, d).getDay()]})`;
}

/** 幅の狭い所に出す「11/22(日)」。今年でなければ「2025/12/31」 */
export function dateShort(date: string, today: string = localDate()): string {
  const [y, m, d] = date.split("-").map(Number);
  if (String(y) !== today.slice(0, 4)) return `${y}/${m}/${d}`;
  return `${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})`;
}

export const monthLabel = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
};

/* ---------- 電卓 ---------- */

export const OPERATORS = ["+", "−", "×", "÷"] as const;
export type Operator = (typeof OPERATORS)[number];
export type CalcKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | Operator | "=" | "C" | "back";

const isOp = (c: string): c is Operator => (OPERATORS as readonly string[]).includes(c);
/** 1つの数の桁数の上限（金額の上限と同じ7桁） */
const NUM_DIGITS = String(AMOUNT_MAX).length;

/** 式を数と記号に分ける（"1200+300×2" → ["1200", "+", "300", "×", "2"]） */
export function tokens(expr: string): string[] {
  return expr.match(/\d+|[+−×÷]/g) ?? [];
}

/**
 * 電卓のキーを1つ押したあとの式。
 * 数の頭の0は付けない・記号は続けて押すと置き換える・式の頭に記号は置かない。
 */
export function calcPress(expr: string, key: CalcKey): string {
  if (key === "C") return "";
  if (key === "back") return expr.slice(0, -1);
  if (key === "=") {
    const v = evaluate(expr);
    return v !== null && v > 0 ? String(v) : expr;
  }
  if (isOp(key)) {
    if (expr === "") return "";
    return isOp(expr.slice(-1)) ? expr.slice(0, -1) + key : expr + key;
  }
  const last = tokens(expr).at(-1) ?? "";
  const current = isOp(last) ? "" : last;
  const head = expr.slice(0, expr.length - current.length);
  const next = (current + key).replace(/^0+/, "");
  if (next.length > NUM_DIGITS) return expr;
  return head + next;
}

/** 式の値（円・四捨五入）。最後が記号なら無視する。0で割るなど計算できなければ null */
export function evaluate(expr: string): number | null {
  const t = tokens(expr);
  if (t.length && isOp(t[t.length - 1])) t.pop();
  if (t.length === 0) return 0;
  // 先に × ÷ をまとめる
  const terms: number[] = [Number(t[0])];
  const signs: Operator[] = [];
  for (let i = 1; i < t.length; i += 2) {
    const op = t[i] as Operator;
    const n = Number(t[i + 1]);
    if (op === "×") terms[terms.length - 1] *= n;
    else if (op === "÷") {
      if (n === 0) return null;
      terms[terms.length - 1] /= n;
    } else {
      signs.push(op);
      terms.push(n);
    }
  }
  let v = terms[0];
  signs.forEach((op, i) => (v = op === "+" ? v + terms[i + 1] : v - terms[i + 1]));
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** 式に記号が入っているか（入っていれば途中の式も見せる） */
export const hasOperator = (expr: string): boolean => /[+−×÷]/.test(expr);

/** 式を見やすく（数に3桁ごとのカンマ、記号の前後に空き） */
export function formatExpr(expr: string): string {
  return tokens(expr)
    .map((t) => (isOp(t) ? ` ${t} ` : yenFmt.format(Number(t))))
    .join("");
}

export function keyFromHash(hash: string): string | null {
  const m = /(?:^#|&)k=([0-9a-f]{32})(?:&|$)/.exec(hash);
  return m ? m[1] : null;
}

export interface CalendarCell {
  /** YYYY-MM-DD。月の前後を埋める空きの日は null */
  date: string | null;
  day: number;
  total: number;
  count: number;
}

/** 月のカレンダー（日曜はじまり、7日ずつの行）。各日にその日の合計と件数を入れる */
export function calendarWeeks(month: string, entries: readonly Entry[]): CalendarCell[][] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const byDate = new Map<string, { total: number; count: number }>();
  for (const e of entries) {
    const t = byDate.get(e.date) ?? { total: 0, count: 0 };
    t.total += e.amount;
    t.count += 1;
    byDate.set(e.date, t);
  }
  const cells: CalendarCell[] = [];
  for (let i = 0; i < first; i++) cells.push({ date: null, day: 0, total: 0, count: 0 });
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const t = byDate.get(date);
    cells.push({ date, day: d, total: t?.total ?? 0, count: t?.count ?? 0 });
  }
  while (cells.length % 7) cells.push({ date: null, day: 0, total: 0, count: 0 });
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** カレンダーのマスに入れる短い金額（1万以上は「1.2万」） */
export function shortYen(n: number): string {
  if (n >= 100000) return `${Math.round(n / 10000)}万`;
  if (n >= 10000) return `${(Math.floor(n / 1000) / 10).toFixed(1).replace(/\.0$/, "")}万`;
  return yenFmt.format(n);
}

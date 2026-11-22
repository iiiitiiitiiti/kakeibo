import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getDb } from "./firebase";
import {
  categoryBudgetId,
  isDate,
  isMonth,
  mergeCategories,
  monthRange,
  OTHER_ID,
  parseCategoryBudgetId,
  RECENT_COUNT,
  type Budget,
  type CategoryBudget,
  type Category,
  type Entry,
  type Pay,
} from "./model";

export type LoadState = "loading" | "ready" | "denied" | "offline-timeout";

const toMillis = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : Date.now());

function toEntry(id: string, d: DocumentData, pending: boolean): Entry {
  return {
    id,
    amount: typeof d.amount === "number" ? d.amount : 0,
    categoryId: typeof d.categoryId === "string" ? d.categoryId : OTHER_ID,
    date: isDate(d.date) ? d.date : "1970-01-01",
    memo: typeof d.memo === "string" ? d.memo : "",
    addedBy: typeof d.addedBy === "string" ? d.addedBy : "",
    createdAt: toMillis(d.createdAt),
    pending,
    ...(typeof d.settled === "boolean"
      ? { settled: d.settled, paidBy: typeof d.paidBy === "string" ? d.paidBy : "" }
      : {}),
  };
}

function toCategory(id: string, d: DocumentData): Category {
  return {
    id,
    name: typeof d.name === "string" && d.name ? d.name : "（名前なし）",
    order: typeof d.order === "number" ? d.order : 999,
    hidden: d.hidden === true,
  };
}

const docToEntry = (d: QueryDocumentSnapshot): Entry =>
  toEntry(d.id, d.data({ serverTimestamps: "estimate" }), d.metadata.hasPendingWrites);

const NO_ENTRIES: Entry[] = [];

export interface NewEntry {
  amount: number;
  categoryId: string;
  date: string;
  memo: string;
  /** どの財布で払ったか。書かなければ、足すときは共通の財布、直すときは今のまま */
  pay?: Pay;
}

/** 2人で共有する家計簿を購読し、書き込み操作を返す。month は「今月」画面で見ている月 */
export function useBook(bookKey: string, month: string, me: string, onWriteError: () => void) {
  const [recent, setRecent] = useState<Entry[]>([]);
  const [monthEntries, setMonthEntries] = useState<Entry[]>([]);
  const [storedCats, setStoredCats] = useState<Category[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [categoryBudgets, setCategoryBudgets] = useState<CategoryBudget[]>([]);
  const [unsettled, setUnsettled] = useState<Entry[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  /** 保存先の今の中身を一度でも受け取ったか（手元の写しだけではない） */
  const [synced, setSynced] = useState(false);
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);

  const refs = useMemo(() => {
    const db = getDb();
    return {
      db,
      entries: collection(db, "books", bookKey, "entries"),
      categories: collection(db, "books", bookKey, "categories"),
      budgets: collection(db, "books", bookKey, "budgets"),
      catBudgets: collection(db, "books", bookKey, "catBudgets"),
    };
  }, [bookKey]);

  useEffect(() => {
    let gotData = false;
    // 10秒たっても手元の写しすら出ないときだけ、つながらない旨を出す
    const timer = window.setTimeout(() => {
      if (!gotData) setState((s) => (s === "loading" ? "offline-timeout" : s));
    }, 10000);
    const fail = (e: { code?: string }) => {
      window.clearTimeout(timer);
      setState(e.code === "permission-denied" ? "denied" : "offline-timeout");
    };

    // 届いたかどうか（送信待ち）の変化も受け取る
    const unRecent = onSnapshot(
      query(refs.entries, orderBy("createdAt", "desc"), limit(RECENT_COUNT)),
      { includeMetadataChanges: true },
      (snap) => {
        gotData = true;
        window.clearTimeout(timer);
        setRecent(snap.docs.map(docToEntry));
        setState("ready");
        if (!snap.metadata.fromCache) setSynced(true);
      },
      fail,
    );
    const unCats = onSnapshot(
      refs.categories,
      (snap) => setStoredCats(snap.docs.map((d) => toCategory(d.id, d.data()))),
      fail,
    );
    const unBudgets = onSnapshot(
      refs.budgets,
      (snap) =>
        setBudgets(
          snap.docs
            .filter((d) => isMonth(d.id))
            .map((d) => ({ month: d.id, amount: typeof d.get("amount") === "number" ? d.get("amount") : 0 })),
        ),
      fail,
    );
    // カテゴリごとの予算は読めなくても家計簿そのものは使えるので、読めないときは「予算なし」として続ける
    const unCatBudgets = onSnapshot(
      refs.catBudgets,
      (snap) =>
        setCategoryBudgets(
          snap.docs.flatMap((d) => {
            const id = parseCategoryBudgetId(d.id);
            const amount: unknown = d.get("amount");
            return id && typeof amount === "number" ? [{ ...id, amount }] : [];
          }),
        ),
      (e) => console.error("カテゴリごとの予算を読めませんでした", e),
    );
    // 未精算は月をまたいで残るので、月の記録とは別に全部を追う。読めなくても家計簿は使える
    const unUnsettled = onSnapshot(
      query(refs.entries, where("settled", "==", false)),
      { includeMetadataChanges: true },
      (snap) => setUnsettled(snap.docs.map(docToEntry)),
      (e) => console.error("未精算の記録を読めませんでした", e),
    );
    return () => {
      window.clearTimeout(timer);
      unRecent();
      unCats();
      unBudgets();
      unCatBudgets();
      unUnsettled();
    };
  }, [refs]);

  useEffect(() => {
    const [from, to] = monthRange(month);
    setMonthEntries([]);
    setLoadedMonth(null);
    return onSnapshot(
      query(refs.entries, where("date", ">=", from), where("date", "<=", to)),
      { includeMetadataChanges: true },
      (snap) => {
        setMonthEntries(snap.docs.map(docToEntry));
        // 手元の写しが空なだけでは「記録なし」と決めない（電波が無い所で、見たことのない月を開いたとき）。
        // 一度読み終えた月は、あとで電波が切れても読み終えたままにする
        setLoadedMonth((prev) => (snap.metadata.fromCache && snap.empty && prev !== month ? null : month));
      },
      (e) => console.error("その月の記録を読めませんでした", e),
    );
  }, [refs, month]);

  const categories = useMemo(() => mergeCategories(storedCats), [storedCats]);

  /** 書き込みは待たずに画面へ出す。保存先に断られたときだけ知らせる */
  const guard = (p: Promise<unknown>) => {
    p.catch((e: unknown) => {
      console.error("保存できませんでした", e);
      onWriteError();
    });
  };

  const actions = useMemo(
    () => ({
      add(e: NewEntry): string {
        const ref = doc(refs.entries);
        guard(
          setDoc(ref, {
            amount: e.amount,
            categoryId: e.categoryId,
            date: e.date,
            memo: e.memo,
            addedBy: me,
            createdAt: serverTimestamp(),
            ...(e.pay && e.pay !== "shared" ? { paidBy: me, settled: e.pay === "settled" } : {}),
          }),
        );
        return ref.id;
      },
      /** paidBy は、自分の財布で払ったことにするときの払った人（前からそうなら元の人のまま渡す） */
      update(id: string, e: NewEntry, paidBy: string) {
        guard(
          updateDoc(doc(refs.entries, id), {
            amount: e.amount,
            categoryId: e.categoryId,
            date: e.date,
            memo: e.memo,
            updatedAt: serverTimestamp(),
            ...(e.pay === undefined
              ? {}
              : e.pay === "shared"
                ? { paidBy: deleteField(), settled: deleteField() }
                : { paidBy, settled: e.pay === "settled" }),
          }),
        );
      },
      /** 未精算の記録をまとめて精算済みにする（false で未精算に戻す） */
      setSettled(ids: readonly string[], settled: boolean) {
        if (ids.length === 0) return;
        const batch = writeBatch(refs.db);
        for (const id of ids) batch.update(doc(refs.entries, id), { settled, updatedAt: serverTimestamp() });
        guard(batch.commit());
      },
      remove(id: string) {
        guard(deleteDoc(doc(refs.entries, id)));
      },
      /** 消した記録を元に戻す（同じ ID・同じ中身で書き直す） */
      restore(e: Entry) {
        guard(
          setDoc(doc(refs.entries, e.id), {
            amount: e.amount,
            categoryId: e.categoryId,
            date: e.date,
            memo: e.memo,
            addedBy: e.addedBy,
            createdAt: Timestamp.fromMillis(e.createdAt),
            ...(e.settled === undefined ? {} : { paidBy: e.paidBy ?? "", settled: e.settled }),
          }),
        );
      },
      saveCategory(c: Category) {
        guard(setDoc(doc(refs.categories, c.id), { name: c.name, order: c.order, hidden: c.hidden }));
      },
      /** 2つのカテゴリの並びを入れ替える */
      swapCategories(a: Category, b: Category) {
        const batch = writeBatch(refs.db);
        batch.set(doc(refs.categories, a.id), { name: a.name, order: b.order, hidden: a.hidden });
        batch.set(doc(refs.categories, b.id), { name: b.name, order: a.order, hidden: b.hidden });
        guard(batch.commit());
      },
      addCategory(name: string, order: number): string {
        const ref = doc(refs.categories);
        guard(setDoc(ref, { name, order, hidden: false }));
        return ref.id;
      },
      /** その月から先の予算を決める。0 は「決めない」 */
      setBudget(month: string, amount: number) {
        guard(setDoc(doc(refs.budgets, month), { amount }));
      },
      /** そのカテゴリの、その月から先の予算を決める。0 は「決めない」 */
      setCategoryBudget(month: string, categoryId: string, amount: number) {
        guard(setDoc(doc(refs.catBudgets, categoryBudgetId(month, categoryId)), { amount }));
      },
    }),
    [refs, me, onWriteError],
  );

  // 月を切り替えた直後は、前の月の記録を新しい月のものとして見せない
  const monthReady = loadedMonth === month;
  return {
    state,
    synced,
    monthReady,
    recent,
    monthEntries: monthReady ? monthEntries : NO_ENTRIES,
    categories,
    budgets,
    categoryBudgets,
    unsettled,
    ...actions,
  };
}

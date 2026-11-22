import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  addMonths,
  AMOUNT_MAX,
  BUDGET_MAX,
  budgetFor,
  calendarWeeks,
  CAT_NAME_MAX,
  categoryOf,
  cleanText,
  dateLabel,
  DEFAULT_CATEGORIES,
  groupByDate,
  keyFromHash,
  localDate,
  MEMO_MAX,
  monthLabel,
  monthOf,
  nextOrder,
  PERSON_MAX,
  pushDigit,
  shortYen,
  sum,
  totalsByCategory,
  yen,
  type Category,
  type Entry,
} from "./model";
import { useBook, type NewEntry } from "./useBook";

// かいもの（同じ github.io の上）と保存場所を分けるため、名前は kakeibo: で始める
const STORE_KEY = "kakeibo:key";
const STORE_ME = "kakeibo:me";

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 保存できない環境ではその場限りで使う */
  }
};

/**
 * 鍵は URL の #k=… から取り、端末にも覚える。
 * iPhone はホーム画面に置いたアプリと Safari で保存場所が別なので、URL からは消さない。
 */
function loadKey(): string | null {
  const fromHash = keyFromHash(window.location.hash);
  if (fromHash) {
    write(STORE_KEY, fromHash);
    return fromHash;
  }
  const stored = read(STORE_KEY);
  if (stored && /^[0-9a-f]{32}$/.test(stored)) {
    window.history.replaceState(null, "", `#k=${stored}`);
    return stored;
  }
  return null;
}

export function App() {
  const [bookKey, setBookKey] = useState<string | null>(loadKey);
  const [me, setMe] = useState<string | null>(() => read(STORE_ME));

  useEffect(() => {
    const onHash = () => {
      const k = keyFromHash(window.location.hash);
      if (k) {
        write(STORE_KEY, k);
        setBookKey(k);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const saveMe = (name: string) => {
    const v = cleanText(name, PERSON_MAX);
    write(STORE_ME, v);
    setMe(v);
  };

  const useLink = (key: string) => {
    write(STORE_KEY, key);
    window.history.replaceState(null, "", `#k=${key}`);
    setBookKey(key);
  };

  if (!bookKey) return <NoKey onKey={useLink} />;
  if (me === null) return <NameSetup onDone={saveMe} />;
  return <BookScreen bookKey={bookKey} me={me} onMe={saveMe} onKey={useLink} />;
}

/* ---------- 鍵が無いとき・呼び名 ---------- */

function NoKey({ onKey, denied = false }: { onKey: (k: string) => void; denied?: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const hashPart = text.includes("#") ? text.slice(text.indexOf("#")) : `#k=${text.trim()}`;
    const key = keyFromHash(hashPart);
    if (!key) {
      setError("リンクの形が違います。届いたリンクをそのまま貼ってください");
      return;
    }
    onKey(key);
  };
  return (
    <main className="center-screen">
      <Logo />
      <h1>{denied ? "このリンクでは開けません" : "ふたりの家計簿"}</h1>
      <p>{denied ? "届いたリンクをもう一度開いてください。" : "一緒に使う人から届いたリンクを開いてください。"}</p>
      <form className="link-form" onSubmit={submit}>
        <label htmlFor="link">届いたリンクを貼る</label>
        <div className="row">
          <input id="link" value={text} onChange={(e) => setText(e.target.value)} inputMode="url" autoComplete="off" />
          <button className="btn primary" type="submit">
            開く
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

function NameSetup({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <main className="center-screen">
      <Logo />
      <h1>あなたの呼び名</h1>
      <p>記録した人として出ます。</p>
      <form
        className="link-form"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(name);
        }}
      >
        <label htmlFor="me" className="sr-only">
          呼び名
        </label>
        <div className="row">
          <input id="me" value={name} maxLength={PERSON_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            はじめる
          </button>
        </div>
        <button className="btn ghost" type="button" onClick={() => onDone("")}>
          名前なしではじめる
        </button>
      </form>
    </main>
  );
}

/* ---------- 家計簿 ---------- */

interface ToastState {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

type Tab = "record" | "month";
type DialogState =
  | { kind: "edit"; entry: Entry }
  | { kind: "menu" }
  | { kind: "budget" }
  | { kind: "categories" }
  | null;

function BookScreen({
  bookKey,
  me,
  onMe,
  onKey,
}: {
  bookKey: string;
  me: string;
  onMe: (v: string) => void;
  onKey: (k: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("record");
  const [month, setMonth] = useState(() => monthOf(localDate()));
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const showToast = useCallback((message: string, action?: ToastState["action"]) => {
    setToast({ id: Date.now(), message, action });
  }, []);
  const onWriteError = useCallback(() => showToast("保存できませんでした。電波のよい所でもう一度試してください"), [showToast]);

  const book = useBook(bookKey, month, me, onWriteError);
  const { categories } = book;
  const visible = useMemo(() => categories.filter((c) => !c.hidden), [categories]);
  const colorOf = useCallback((id: string) => colorClass(categoryOf(id, categories).id), [categories]);

  if (book.state === "denied") return <NoKey onKey={onKey} denied />;

  const removeEntry = (e: Entry) => {
    book.remove(e.id);
    showToast(`${yen(e.amount)} を消しました`, { label: "元に戻す", run: () => book.restore(e) });
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo small />
          <span>かけいぼ</span>
        </div>
        <nav className="tabs" aria-label="画面">
          <button type="button" className={tab === "record" ? "on" : ""} aria-pressed={tab === "record"} onClick={() => setTab("record")}>
            記録
          </button>
          <button
            type="button"
            className={tab === "month" ? "on" : ""}
            aria-pressed={tab === "month"}
            onClick={() => {
              setMonth(monthOf(localDate()));
              setTab("month");
            }}
          >
            今月
          </button>
        </nav>
        <button className="icon-btn" type="button" aria-label="メニュー" onClick={() => setDialog({ kind: "menu" })}>
          <MenuIcon />
        </button>
      </header>

      {book.state === "offline-timeout" && (
        <p className="banner" role="status">
          つながりません。記録は電波が戻ったときに届きます
        </p>
      )}

      {tab === "record" ? (
        <RecordTab
          categories={visible}
          allCategories={categories}
          recent={book.recent}
          colorOf={colorOf}
          flashId={flashId}
          onAdd={(e) => {
            const id = book.add(e);
            setFlashId(id);
            const cat = categoryOf(e.categoryId, categories);
            showToast(`${cat.name} ${yen(e.amount)} を記録しました`, {
              label: "取り消す",
              run: () => book.remove(id),
            });
          }}
          onOpen={(entry) => setDialog({ kind: "edit", entry })}
          onEditCategories={() => setDialog({ kind: "categories" })}
        />
      ) : (
        <MonthTab
          month={month}
          onMonth={setMonth}
          entries={book.monthEntries}
          categories={categories}
          budget={budgetFor(month, book.budgets)}
          colorOf={colorOf}
          onOpen={(entry) => setDialog({ kind: "edit", entry })}
          onBudget={() => setDialog({ kind: "budget" })}
        />
      )}

      {dialog?.kind === "edit" && (
        <EditDialog
          entry={dialog.entry}
          categories={categories}
          onClose={() => setDialog(null)}
          onSave={(e) => {
            book.update(dialog.entry.id, e);
            setDialog(null);
            showToast("直しました");
          }}
          onDelete={() => {
            removeEntry(dialog.entry);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "menu" && (
        <MenuDialog
          me={me}
          onMe={onMe}
          onClose={() => setDialog(null)}
          onToast={showToast}
          onBudget={() => setDialog({ kind: "budget" })}
          onCategories={() => setDialog({ kind: "categories" })}
        />
      )}
      {dialog?.kind === "budget" && (
        <BudgetDialog
          month={monthOf(localDate())}
          current={budgetFor(monthOf(localDate()), book.budgets)}
          onClose={() => setDialog(null)}
          onSave={(amount) => {
            book.setBudget(monthOf(localDate()), amount);
            setDialog(null);
            showToast(amount > 0 ? `予算を ${yen(amount)} にしました` : "予算を決めない設定にしました");
          }}
        />
      )}
      {dialog?.kind === "categories" && (
        <CategoryDialog
          categories={categories}
          colorOf={colorOf}
          onClose={() => setDialog(null)}
          onSave={book.saveCategory}
          onSwap={book.swapCategories}
          onAdd={(name) => book.addCategory(name, nextOrder(categories))}
        />
      )}

      {toast && <Toast key={toast.id} toast={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/** カテゴリの色。足したり並べ替えたりしてもほかの色が変わらないよう、ID から決める */
function colorClass(id: string): string {
  const i = DEFAULT_CATEGORIES.findIndex((c) => c.id === id);
  if (i >= 0) return `c${i}`;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `c${h % 8}`;
}

/* ---------- 記録 ---------- */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"] as const;

function RecordTab({
  categories,
  allCategories,
  recent,
  colorOf,
  flashId,
  onAdd,
  onOpen,
  onEditCategories,
}: {
  categories: Category[];
  allCategories: Category[];
  recent: Entry[];
  colorOf: (id: string) => string;
  flashId: string | null;
  onAdd: (e: NewEntry) => void;
  onOpen: (e: Entry) => void;
  onEditCategories: () => void;
}) {
  const [digits, setDigits] = useState("");
  const [catId, setCatId] = useState<string | null>(null);
  const [date, setDate] = useState(localDate);
  const [memo, setMemo] = useState("");
  const amount = digits ? Number(digits) : 0;
  // 選んでいたカテゴリが隠されたら選び直してもらう
  const chosen = catId && categories.some((c) => c.id === catId) ? catId : null;
  const ready = amount > 0 && chosen !== null;

  const press = (key: (typeof KEYS)[number]) => {
    if (key === "back") setDigits((d) => d.slice(0, -1));
    else setDigits((d) => pushDigit(d, key));
    navigator.vibrate?.(5);
  };

  const submit = () => {
    if (!ready || !chosen) return;
    onAdd({ amount, categoryId: chosen, date, memo: cleanText(memo, MEMO_MAX) });
    setDigits("");
    setCatId(null);
    setMemo("");
    setDate(localDate());
  };

  return (
    <main className="record">
      <section className="entry-card" aria-label="記録する">
        <output className={amount ? "amount" : "amount empty"} aria-live="polite" aria-label="金額">
          {yen(amount)}
        </output>

        <div className="cats" role="group" aria-label="カテゴリ">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`cat ${colorOf(c.id)}${chosen === c.id ? " on" : ""}`}
              aria-pressed={chosen === c.id}
              onClick={() => setCatId(chosen === c.id ? null : c.id)}
            >
              {c.name}
            </button>
          ))}
          <button type="button" className="cat add" onClick={onEditCategories} aria-label="カテゴリを足す・直す">
            ＋
          </button>
        </div>

        <div className="meta">
          <label className="date-field">
            <span className="sr-only">日付</span>
            <span className="date-text" aria-hidden="true">
              {dateLabel(date)}
            </span>
            <input
              type="date"
              value={date}
              max={localDate()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
          <label className="memo-field">
            <span className="sr-only">メモ</span>
            <input
              value={memo}
              maxLength={MEMO_MAX}
              placeholder="メモ（なくてよい）"
              onChange={(e) => setMemo(e.target.value)}
              enterKeyHint="done"
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
        </div>

        <div className="keypad" role="group" aria-label="金額を打つ">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={k === "back" ? "key back" : "key"}
              aria-label={k === "back" ? "1文字消す" : k}
              onPointerDown={(e) => {
                // 指が触れた瞬間に打つ（離すのを待つと速く打ったときに取りこぼす）
                if (e.pointerType === "mouse" && e.button !== 0) return;
                e.preventDefault();
                press(k);
              }}
              onClick={(e) => {
                // キーボード操作（Enter・Space）のときだけ click で打つ
                if (e.detail === 0) press(k);
              }}
            >
              {k === "back" ? <BackIcon /> : k}
            </button>
          ))}
        </div>

        <button className="btn primary submit" type="button" disabled={!ready} onClick={submit}>
          {amount === 0 ? "金額を打ってください" : chosen === null ? "カテゴリを選んでください" : "記録する"}
        </button>
      </section>

      <section className="recent" aria-labelledby="recent-h">
        <h2 id="recent-h">最近の記録</h2>
        {recent.length === 0 ? (
          <p className="muted">まだありません。記録するとここに出ます</p>
        ) : (
          <ul className="entries">
            {recent.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                category={categoryOf(e.categoryId, allCategories)}
                color={colorOf(e.categoryId)}
                flash={e.id === flashId}
                showDate
                onOpen={() => onOpen(e)}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function EntryRow({
  entry,
  category,
  color,
  flash,
  showDate,
  onOpen,
}: {
  entry: Entry;
  category: Category;
  color: string;
  flash?: boolean;
  showDate?: boolean;
  onOpen: () => void;
}) {
  return (
    <li className={flash ? "flash" : undefined}>
      <button type="button" className="entry" onClick={onOpen}>
        <span className={`dot ${color}`} aria-hidden="true" />
        <span className="entry-main">
          <span className="entry-cat">{category.name}</span>
          <span className="entry-sub">
            {[showDate ? dateLabel(entry.date) : "", entry.memo, entry.addedBy].filter(Boolean).join("・")}
          </span>
        </span>
        <span className="entry-amount">{yen(entry.amount)}</span>
      </button>
    </li>
  );
}

/* ---------- 今月 ---------- */

function MonthTab({
  month,
  onMonth,
  entries,
  categories,
  budget,
  colorOf,
  onOpen,
  onBudget,
}: {
  month: string;
  onMonth: (m: string) => void;
  entries: Entry[];
  categories: Category[];
  budget: number | null;
  colorOf: (id: string) => string;
  onOpen: (e: Entry) => void;
  onBudget: () => void;
}) {
  const thisMonth = monthOf(localDate());
  const today = localDate();
  const [selected, setSelected] = useState<string | null>(null);
  // 月を変えたら日の選択を外す
  const [shownMonth, setShownMonth] = useState(month);
  if (shownMonth !== month) {
    setShownMonth(month);
    setSelected(null);
  }
  const weeks = calendarWeeks(month, entries);
  const total = sum(entries);
  const totals = totalsByCategory(entries, categories);
  const days = groupByDate(selected ? entries.filter((e) => e.date === selected) : entries);
  const left = budget !== null ? budget - total : null;
  const ratio = budget ? Math.min(1, total / budget) : 0;

  return (
    <main className="month">
      <div className="month-nav">
        <button className="icon-btn" type="button" aria-label="前の月" onClick={() => onMonth(addMonths(month, -1))}>
          <ChevronIcon dir="left" />
        </button>
        <h2>{monthLabel(month)}</h2>
        <button
          className="icon-btn"
          type="button"
          aria-label="次の月"
          disabled={month >= thisMonth}
          onClick={() => onMonth(addMonths(month, 1))}
        >
          <ChevronIcon dir="right" />
        </button>
      </div>

      <section className="summary">
        {left !== null && budget !== null ? (
          <>
            <p className="summary-label">{month === thisMonth ? "今月の残り" : "残り"}</p>
            <p className={left < 0 ? "summary-big over" : "summary-big"}>{yen(left)}</p>
            <div
              className={left < 0 ? "meter over" : "meter"}
              role="meter"
              aria-label="予算のうち使った割合"
              aria-valuemin={0}
              aria-valuemax={budget}
              aria-valuenow={Math.min(total, budget)}
            >
              <span style={{ width: `${ratio * 100}%` }} />
            </div>
            <p className="summary-sub">
              予算 {yen(budget)}・使った {yen(total)}
            </p>
          </>
        ) : (
          <>
            <p className="summary-label">使った合計</p>
            <p className="summary-big">{yen(total)}</p>
            {month === thisMonth && (
              <button className="btn" type="button" onClick={onBudget}>
                月の予算を決める
              </button>
            )}
          </>
        )}
      </section>

      <section className="calendar" aria-label={`${monthLabel(month)}のカレンダー`}>
        <div className="cal-head" aria-hidden="true">
          {["日", "月", "火", "水", "木", "金", "土"].map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        {weeks.map((week, i) => (
          <div className="cal-week" key={i}>
            {week.map((c, j) =>
              c.date ? (
                <button
                  key={c.date}
                  type="button"
                  className={[
                    "cal-day",
                    c.date === today ? "today" : "",
                    c.date === selected ? "on" : "",
                    c.count ? "has" : "",
                    c.date > today ? "future" : "",
                  ].join(" ")}
                  aria-pressed={c.date === selected}
                  aria-label={`${dateLabel(c.date)} ${c.count ? `${yen(c.total)}・${c.count}件` : "記録なし"}`}
                  onClick={() => setSelected(c.date === selected ? null : c.date)}
                >
                  <span className="cal-num">{c.day}</span>
                  {c.count > 0 && <span className="cal-total">{shortYen(c.total)}</span>}
                </button>
              ) : (
                <span key={`e${j}`} className="cal-day empty" />
              ),
            )}
          </div>
        ))}
      </section>

      <section className="days" aria-labelledby="days-h">
        <div className="days-head">
          <h2 id="days-h">{selected ? "この日の記録" : "記録"}</h2>
          {selected && (
            <button className="btn small" type="button" onClick={() => setSelected(null)}>
              月の全部を見る
            </button>
          )}
        </div>
        {days.length === 0 ? (
          <p className="muted">{selected ? "この日の記録はありません" : "この月の記録はまだありません"}</p>
        ) : (
          days.map((d) => (
            <div key={d.date} className="day">
              <h3>
                <span>{dateLabel(d.date)}</span>
                <span>{yen(d.total)}</span>
              </h3>
              <ul className="entries">
                {d.entries.map((e) => (
                  <EntryRow
                    key={e.id}
                    entry={e}
                    category={categoryOf(e.categoryId, categories)}
                    color={colorOf(e.categoryId)}
                    onOpen={() => onOpen(e)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {totals.length > 0 && (
        <section className="by-cat" aria-labelledby="bycat-h">
          <h2 id="bycat-h">カテゴリ別</h2>
          <ul>
            {totals.map((t) => (
              <li key={t.category.id}>
                <span className="bar-label">{t.category.name}</span>
                <span className="bar">
                  <span className={colorOf(t.category.id)} style={{ width: `${(t.total / totals[0].total) * 100}%` }} />
                </span>
                <span className="bar-value">{yen(t.total)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/* ---------- ダイアログ ---------- */

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    // showModal は最初のボタン（閉じる）へ移るので、入力欄から始めたい画面はそこへ移し直す
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="dlg-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2 id="dlg-title">{title}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="閉じる">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** 数字だけの入力欄の中身を整数にする（全角数字・カンマ・円記号は読み飛ばす） */
const parseYen = (v: string): number => {
  const digits = v.normalize("NFKC").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
};

function EditDialog({
  entry,
  categories,
  onClose,
  onSave,
  onDelete,
}: {
  entry: Entry;
  categories: Category[];
  onClose: () => void;
  onSave: (e: NewEntry) => void;
  onDelete: () => void;
}) {
  const current = categoryOf(entry.categoryId, categories);
  const [amountText, setAmountText] = useState(String(entry.amount));
  const [catId, setCatId] = useState(current.id);
  const [date, setDate] = useState(entry.date);
  const [memo, setMemo] = useState(entry.memo);
  const amount = parseYen(amountText);
  const valid = amount >= 1 && amount <= AMOUNT_MAX;
  // 隠したカテゴリの記録でも、そのカテゴリのまま直せるようにする
  const choices = categories.filter((c) => !c.hidden || c.id === current.id);

  return (
    <Dialog title="記録を直す" onClose={onClose}>
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave({ amount, categoryId: catId, date, memo: cleanText(memo, MEMO_MAX) });
        }}
      >
        <label>
          <span>金額（円）</span>
          <input
            value={amountText}
            inputMode="numeric"
            autoComplete="off"
            onChange={(e) => setAmountText(e.target.value)}
            aria-invalid={!valid}
          />
          {!valid && <small className="error">1円から{yen(AMOUNT_MAX)}までで入れてください</small>}
        </label>
        <fieldset>
          <legend>カテゴリ</legend>
          <div className="cats">
            {choices.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`cat${catId === c.id ? " on" : ""}`}
                aria-pressed={catId === c.id}
                onClick={() => setCatId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          <span>日付</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <label>
          <span>メモ</span>
          <input value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} autoComplete="off" />
        </label>
        {entry.addedBy && <p className="muted">記録した人: {entry.addedBy}</p>}
        <div className="row end">
          <button className="btn danger-ghost" type="button" onClick={onDelete}>
            消す
          </button>
          <button className="btn primary" type="submit" disabled={!valid}>
            保存
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MenuDialog({
  me,
  onMe,
  onClose,
  onToast,
  onBudget,
  onCategories,
}: {
  me: string;
  onMe: (v: string) => void;
  onClose: () => void;
  onToast: (m: string) => void;
  onBudget: () => void;
  onCategories: () => void;
}) {
  const [name, setName] = useState(me);

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "ふたりの家計簿", url });
        return;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(url);
      onToast("リンクをコピーしました");
    } catch {
      onToast("コピーできませんでした");
    }
  };

  return (
    <Dialog title="メニュー" onClose={onClose}>
      <div className="fields">
        <button className="btn wide" type="button" onClick={onBudget}>
          月の予算
        </button>
        <button className="btn wide" type="button" onClick={onCategories}>
          カテゴリの整理
        </button>
        <button className="btn wide" type="button" onClick={share}>
          一緒に使う人へリンクを送る
        </button>
        <p className="muted small">このリンクを知っている人は家計簿を見て書けます。2人の間だけで持ってください。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onMe(name);
            onToast("呼び名を変えました");
          }}
        >
          <label>
            <span>あなたの呼び名</span>
            <div className="row">
              <input value={name} maxLength={PERSON_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              <button className="btn" type="submit" disabled={cleanText(name, PERSON_MAX) === me}>
                変える
              </button>
            </div>
          </label>
        </form>
      </div>
    </Dialog>
  );
}

function BudgetDialog({
  month,
  current,
  onClose,
  onSave,
}: {
  month: string;
  current: number | null;
  onClose: () => void;
  onSave: (amount: number) => void;
}) {
  const [text, setText] = useState(current ? String(current) : "");
  const amount = parseYen(text);
  const valid = amount <= BUDGET_MAX;
  return (
    <Dialog title="月の予算" onClose={onClose}>
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(amount);
        }}
      >
        <label>
          <span>{monthLabel(month)}から毎月（円）</span>
          <input
            value={text}
            inputMode="numeric"
            autoComplete="off"
            placeholder="例: 150000"
            onChange={(e) => setText(e.target.value)}
            aria-invalid={!valid}
            data-autofocus
          />
          {!valid && <small className="error">{yen(BUDGET_MAX)}までで入れてください</small>}
        </label>
        <p className="muted small">共通のお財布に毎月入れる額を入れると、今月の残りが出ます。空にすると予算を決めない設定になります。前の月の予算は変わりません。</p>
        <div className="row end">
          <button className="btn primary" type="submit" disabled={!valid}>
            保存
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CategoryDialog({
  categories,
  colorOf,
  onClose,
  onSave,
  onSwap,
  onAdd,
}: {
  categories: Category[];
  colorOf: (id: string) => string;
  onClose: () => void;
  onSave: (c: Category) => void;
  onSwap: (a: Category, b: Category) => void;
  onAdd: (name: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState("");
  const visibleCount = categories.filter((c) => !c.hidden).length;
  const sameName = (name: string, exceptId?: string) =>
    categories.some((c) => c.id !== exceptId && c.name === name);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = cleanText(newName, CAT_NAME_MAX);
    if (!name) return;
    const hidden = categories.find((c) => c.name === name && c.hidden);
    if (hidden) {
      onSave({ ...hidden, hidden: false });
    } else if (sameName(name)) {
      setError(`「${name}」はもうあります`);
      return;
    } else {
      onAdd(name);
    }
    setNewName("");
    setError("");
  };

  const rename = (c: Category) => {
    const name = cleanText(editName, CAT_NAME_MAX);
    if (!name || name === c.name) {
      setEditing(null);
      return;
    }
    if (sameName(name, c.id)) {
      setError(`「${name}」はもうあります`);
      return;
    }
    onSave({ ...c, name });
    setEditing(null);
    setError("");
  };

  return (
    <Dialog title="カテゴリの整理" onClose={onClose}>
      <div className="fields">
        <form onSubmit={add}>
          <label>
            <span>カテゴリを足す</span>
            <div className="row">
              <input
                value={newName}
                maxLength={CAT_NAME_MAX}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例: 趣味"
                autoComplete="off"
              />
              <button className="btn primary" type="submit" disabled={!cleanText(newName, CAT_NAME_MAX)}>
                足す
              </button>
            </div>
          </label>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <ul className="cat-list">
          {categories.map((c, i) => (
            <li key={c.id} className={c.hidden ? "hidden-cat" : undefined}>
              <span className={`dot ${colorOf(c.id)}`} aria-hidden="true" />
              {editing === c.id ? (
                <form
                  className="row grow"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename(c);
                  }}
                >
                  <input
                    value={editName}
                    maxLength={CAT_NAME_MAX}
                    onChange={(e) => setEditName(e.target.value)}
                    aria-label={`${c.name}の新しい名前`}
                    autoFocus
                  />
                  <button className="btn primary" type="submit">
                    決定
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="cat-name"
                    onClick={() => {
                      setEditing(c.id);
                      setEditName(c.name);
                    }}
                    aria-label={`${c.name}（押すと名前を変える）`}
                  >
                    {c.name}
                    {c.hidden && <small>（隠し中）</small>}
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`${c.name}を上へ`}
                    disabled={i === 0}
                    onClick={() => onSwap(c, categories[i - 1])}
                  >
                    <ChevronIcon dir="up" />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`${c.name}を下へ`}
                    disabled={i === categories.length - 1}
                    onClick={() => onSwap(c, categories[i + 1])}
                  >
                    <ChevronIcon dir="down" />
                  </button>
                  <button
                    className="btn small"
                    type="button"
                    disabled={!c.hidden && visibleCount <= 1}
                    onClick={() => onSave({ ...c, hidden: !c.hidden })}
                  >
                    {c.hidden ? "戻す" : "隠す"}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">隠したカテゴリは記録画面に出なくなります。前の記録はそのまま残ります。</p>
      </div>
    </Dialog>
  );
}

function Toast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, toast.action ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [toast, onDone]);
  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            onDone();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/* ---------- アイコン ---------- */

function Logo({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? "logo small" : "logo"} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <rect x="14" y="22" width="36" height="26" rx="5" fill="var(--accent-text)" />
      <path d="M14 28h36" stroke="var(--accent)" strokeWidth="3" />
      <circle cx="42" cy="38" r="3.5" fill="var(--accent)" />
      <path d="M20 22l18-7 3 7" fill="none" stroke="var(--accent-text)" strokeWidth="3.5" strokeLinejoin="round" />
    </svg>
  );
}

const MenuIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const BackIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-6-6z M12 9.5l5 5M17 9.5l-5 5" />
  </svg>
);
function ChevronIcon({ dir }: { dir: "left" | "right" | "up" | "down" }) {
  const d = { left: "M15 5l-7 7 7 7", right: "M9 5l7 7-7 7", up: "M5 15l7-7 7 7", down: "M5 9l7 7 7-7" }[dir];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

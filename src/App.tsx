import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  addMonths,
  AMOUNT_MAX,
  BUDGET_MAX,
  budgetFor,
  categoryBudgetsFor,
  calendarWeeks,
  CAT_NAME_MAX,
  categoryOf,
  cleanText,
  dateLabel,
  dateShort,
  DEFAULT_CATEGORIES,
  groupByDate,
  keyFromHash,
  localDate,
  MEMO_MAX,
  memoSuggestions,
  monthLabel,
  monthOf,
  nextOrder,
  paceFor,
  payOf,
  PERSON_MAX,
  calcKeyFromKeyboard,
  calcPress,
  evaluate,
  formatExpr,
  hasOperator,
  OPERATORS,
  shortYen,
  sum,
  totalsByCategory,
  unsettledByPerson,
  yen,
  type CalcKey,
  type Category,
  type Operator,
  type Entry,
  type Pay,
} from "./model";
import { useBook, type NewEntry } from "./useBook";

// かいもの（同じ github.io の上）と保存場所を分けるため、名前は kakeibo: で始める
const STORE_KEY = "kakeibo:key";
const STORE_ME = "kakeibo:me";
/** 明るい・暗いの選択。開いた瞬間に効かせるため、public/theme.js も同じ名前で読む */
const STORE_THEME = "kakeibo:theme";
const THEME_COLOR = { light: "#F8F7F3", dark: "#14181B" } as const;
type Theme = keyof typeof THEME_COLOR;

const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // 切り替えの間だけ色をなめらかに変える
  root.classList.add("theme-switching");
  window.setTimeout(() => root.classList.remove("theme-switching"), 400);
  if (theme === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

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

/** 画面のどこかで失敗しても真っ白にせず、開き直す手段を出す */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.error("画面を出せませんでした", e);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="center-screen">
        <Logo />
        <h1>うまく表示できませんでした</h1>
        <p>開き直すと直ることがあります。これまでの記録は消えていません。</p>
        <button className="btn primary" type="button" onClick={() => window.location.reload()}>
          開き直す
        </button>
      </main>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  );
}

/**
 * 今日の日付。開いたまま日をまたいでも付いていく。
 * 一度決めた値のままだと、翌日に開き直したときに前の日付で記録してしまう。
 */
function useToday(): string {
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    const check = () => setToday(localDate());
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, 30000);
    // 0時を過ぎてすぐの記録が前の日付にならないよう、日が変わる時刻にも合わせる
    let midnight = 0;
    const arm = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      midnight = window.setTimeout(() => {
        check();
        arm();
      }, next - now.getTime() + 50);
    };
    arm();
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
      window.clearTimeout(midnight);
    };
  }, []);
  return today;
}

const CLOCK_SLACK_MS = 5 * 60 * 1000;

/** 開いている間に新しく届いた記録の ID（相手が書いた分も含む）。少しの間だけ色を付けるのに使う */
function useArrivals(entries: readonly Entry[], synced: boolean): ReadonlySet<string> {
  const seen = useRef(new Set<string>());
  /** 数え始めた時刻。それまでは 0 */
  const armedAt = useRef(0);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const added = entries.filter((e) => !seen.current.has(e.id));
    for (const e of added) seen.current.add(e.id);
    // 開いた直後にまとめて届く分は数えない。1件消えて繰り上がってきた古い記録も数えない
    // （端末どうしの時計のずれを見込んで、数え始めの少し前までは新しい記録として扱う）
    const since = armedAt.current - CLOCK_SLACK_MS;
    const arrived = armedAt.current ? added.filter((e) => e.createdAt > since) : [];
    if (arrived.length) setFresh(new Set(arrived.map((e) => e.id)));
    if (synced && !armedAt.current) armedAt.current = Date.now();
  }, [entries, synced]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const t = window.setTimeout(() => setFresh(new Set()), 2000);
    return () => window.clearTimeout(t);
  }, [fresh]);
  return fresh;
}

function Root() {
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
  // 別の家計簿のリンクに替わったら、画面の状態（届いた記録の覚えなど）を作り直す
  return <BookScreen key={bookKey} bookKey={bookKey} me={me} onMe={saveMe} onKey={useLink} />;
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
  /** 2行目に小さく出す補足 */
  sub?: string;
  action?: { label: string; run: () => void };
}

type Tab = "record" | "month";
type DialogState =
  | { kind: "edit"; entry: Entry }
  | { kind: "unsettled" }
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
  const today = useToday();
  const thisMonth = monthOf(today);
  const [tab, setTab] = useState<Tab>("record");
  // 今月以外を見ているときだけ持つ。持っていなければ今月（月が変わっても付いていく）
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  const month = pickedMonth ?? thisMonth;
  // カレンダーの「この日に記録する」で選んだ日。上の「記録」から開いたときは持たない（今日で始める）
  const [startDate, setStartDate] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // 閉じるときは下へ引っ込む動きを見せてから外す
  const [closing, setClosing] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // メニューから予算の画面へ、のように続けて開くときの次の画面。今の画面を引っ込めてから出す
  // （いきなり入れ替えると、今の画面が動きなしで消え、後ろの暗がりも一度消えてちらつく）
  const [queued, setQueued] = useState<NonNullable<DialogState> | null>(null);
  const [swappedIn, setSwappedIn] = useState(false);
  const openDialog = (d: NonNullable<DialogState>) => {
    if (dialog) {
      setQueued(d);
      setClosing(true);
      return;
    }
    // 続けて開いたときも戻り先が最初に押した場所になるよう、何も開いていないときだけ覚える
    opener.current = document.activeElement as HTMLElement | null;
    setClosing(false);
    setSwappedIn(false);
    setDialog(d);
  };
  const closeDialog = useCallback(() => {
    setQueued(null);
    setClosing(true);
  }, []);
  const dialogCtx = useMemo(
    () => ({
      closing,
      swapOut: closing && queued !== null,
      swapIn: swappedIn,
      onClosed: () => {
        setClosing(false);
        setDialog(queued);
        setQueued(null);
        setSwappedIn(queued !== null);
      },
    }),
    [closing, queued, swappedIn],
  );
  // 閉じ終わって画面から外れたあとに、開く前に押した場所へ戻す（開いている間は外へ移れない）
  useEffect(() => {
    if (dialog) return;
    const el = opener.current;
    opener.current = null;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
  }, [dialog]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!flashId) return;
    // 色を付け終えたら外す（残すと、画面を切り替えるたびに同じ行が光り直す）
    const t = window.setTimeout(() => setFlashId(null), 2000);
    return () => window.clearTimeout(t);
  }, [flashId]);
  // 画面を切り替えたときに、進んだ向きから入ってくるように見せる
  const [enter, setEnter] = useState<"" | "from-left" | "from-right">("");

  const showToast = useCallback((message: string, action?: ToastState["action"], sub?: string) => {
    setToast({ id: Date.now(), message, sub, action });
  }, []);
  const clearToast = useCallback(() => setToast(null), []);
  const onWriteError = useCallback(() => showToast("保存できませんでした。電波のよい所でもう一度試してください"), [showToast]);

  const book = useBook(bookKey, month, me, onWriteError);
  const { categories } = book;
  const visible = useMemo(() => categories.filter((c) => !c.hidden), [categories]);
  const colorOf = useCallback((id: string) => colorClass(categoryOf(id, categories).id), [categories]);
  const arrivals = useArrivals(book.recent, book.synced);
  const isFresh = (id: string) => id === flashId || arrivals.has(id);
  const budget = budgetFor(month, book.budgets);
  // 隠しているカテゴリの予算は使わない（設定の画面に出ないので、直せないまま赤くなるのを防ぐ）
  const catBudgetsOf = (m: string) => {
    const map = categoryBudgetsFor(m, book.categoryBudgets);
    for (const c of categories) if (c.hidden) map.delete(c.id);
    return map;
  };
  const catBudgets = catBudgetsOf(month);

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
          <button
            type="button"
            className={tab === "record" ? "on" : ""}
            aria-pressed={tab === "record"}
            onClick={() => {
              // 記録画面では今月の合計を追う（記録した直後に今月の残りを知らせるため）
              setPickedMonth(null);
              if (tab !== "record") {
                setStartDate(null);
                setEnter("from-left");
              }
              setTab("record");
            }}
          >
            記録
          </button>
          <button
            type="button"
            className={tab === "month" ? "on" : ""}
            aria-pressed={tab === "month"}
            onClick={() => {
              setPickedMonth(null);
              if (tab !== "month") setEnter("from-right");
              setTab("month");
            }}
          >
            今月
          </button>
        </nav>
        <button className="icon-btn" type="button" aria-label="メニュー" onClick={() => openDialog({ kind: "menu" })}>
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
          memoSource={book.monthEntries}
          loading={book.state === "loading"}
          today={today}
          startDate={startDate}
          enter={enter}
          colorOf={colorOf}
          isFresh={isFresh}
          onAdd={(e) => {
            // 残りは、この記録が合計に入る前の値から引いて出す
            const known = book.monthReady && month === thisMonth && monthOf(e.date) === thisMonth;
            const cat = categoryOf(e.categoryId, categories);
            const left = known && budget !== null ? budget - sum(book.monthEntries) - e.amount : null;
            const catBudget = known ? (catBudgets.get(cat.id) ?? null) : null;
            const catLeft =
              catBudget !== null
                ? catBudget -
                  sum(book.monthEntries.filter((x) => categoryOf(x.categoryId, categories).id === cat.id)) -
                  e.amount
                : null;
            const id = book.add(e);
            setFlashId(id);
            // 1行しか出せないので、超えた知らせを先に、次にそのカテゴリの残りを出す
            const note =
              catLeft !== null && catLeft < 0
                ? `${cat.name}の予算を ${yen(-catLeft)} 超えています`
                : left !== null && left < 0
                  ? `今月の予算を ${yen(-left)} 超えています`
                  : catLeft !== null
                    ? `${cat.name}の残り ${yen(catLeft)}`
                    : left !== null
                      ? `今月の残り ${yen(left)}`
                      : undefined;
            showToast(
              `${cat.name} ${yen(e.amount)} を${e.pay === "unsettled" ? "未精算で" : ""}記録`,
              { label: "取り消す", run: () => book.remove(id) },
              note,
            );
          }}
          onOpen={(entry) => openDialog({ kind: "edit", entry })}
          onEditCategories={() => openDialog({ kind: "categories" })}
        />
      ) : (
        <MonthTab
          month={month}
          onMonth={(m) => setPickedMonth(m === thisMonth ? null : m)}
          today={today}
          enter={enter}
          ready={book.monthReady}
          entries={book.monthEntries}
          categories={categories}
          budget={budget}
          catBudgets={catBudgets}
          unsettledTotal={sum(book.unsettled)}
          colorOf={colorOf}
          isFresh={isFresh}
          onOpen={(entry) => openDialog({ kind: "edit", entry })}
          onBudget={() => openDialog({ kind: "budget" })}
          onUnsettled={() => openDialog({ kind: "unsettled" })}
          onRecordOn={(d) => {
            setStartDate(d);
            setPickedMonth(null);
            setEnter("from-left");
            setTab("record");
            // 下まで送った位置のまま切り替えると、金額の欄が画面の外になる
            window.scrollTo(0, 0);
          }}
        />
      )}

      <DialogContext.Provider value={dialogCtx}>
        {dialog?.kind === "edit" && (
          <EditDialog
            entry={dialog.entry}
            categories={categories}
            me={me}
            onClose={() => closeDialog()}
            onSave={(e) => {
              book.update(dialog.entry.id, e, payerOf(dialog.entry));
              closeDialog();
              showToast("直しました");
            }}
            onDelete={() => {
              removeEntry(dialog.entry);
              closeDialog();
            }}
          />
        )}
        {dialog?.kind === "unsettled" && (
          <UnsettledDialog
            entries={book.unsettled}
            categories={categories}
            colorOf={colorOf}
            onClose={() => closeDialog()}
            onSettle={(list) => {
              const ids = list.map((e) => e.id);
              book.setSettled(ids, true);
              // お知らせと「元に戻す」は開いた画面の下に隠れるので、閉じてから出す
              closeDialog();
              showToast(`${yen(sum(list))} を精算済みにしました`, {
                label: "元に戻す",
                run: () => book.setSettled(ids, false),
              });
            }}
          />
        )}
        {dialog?.kind === "menu" && (
          <MenuDialog
            me={me}
            onMe={onMe}
            onClose={() => closeDialog()}
            onToast={showToast}
            onUnsettled={() => openDialog({ kind: "unsettled" })}
            onBudget={() => openDialog({ kind: "budget" })}
            onCategories={() => openDialog({ kind: "categories" })}
          />
        )}
        {dialog?.kind === "budget" && (
          <BudgetDialog
            month={thisMonth}
            current={budgetFor(thisMonth, book.budgets)}
            categories={visible}
            currentByCategory={catBudgetsOf(thisMonth)}
            colorOf={colorOf}
            onClose={() => closeDialog()}
            onSave={(amount, changed) => {
              if (amount !== null) book.setBudget(thisMonth, amount);
              for (const c of changed) book.setCategoryBudget(thisMonth, c.id, c.amount);
              closeDialog();
              if (amount !== null) showToast(amount > 0 ? `予算を ${yen(amount)} にしました` : "予算を決めない設定にしました");
              else if (changed.length > 0) showToast("カテゴリの予算を保存しました");
            }}
          />
        )}
        {dialog?.kind === "categories" && (
          <CategoryDialog
            categories={categories}
            colorOf={colorOf}
            onClose={() => closeDialog()}
            onSave={book.saveCategory}
            onSwap={book.swapCategories}
            onAdd={(name) => book.addCategory(name, nextOrder(categories))}
          />
        )}
      </DialogContext.Provider>

      {toast && <Toast key={toast.id} toast={toast} onDone={clearToast} />}
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

/** 電卓のキーの並び（4列）。「=」は2行ぶん、「0」は2列ぶんの高さ・幅を取る */
const KEYS: readonly CalcKey[] = ["C", "÷", "×", "back", "7", "8", "9", "−", "4", "5", "6", "+", "1", "2", "3", "=", "0", "00"];
const KEY_LABEL: Partial<Record<CalcKey, string>> = {
  C: "全部消す",
  back: "1文字消す",
  "÷": "割る",
  "×": "掛ける",
  "−": "引く",
  "+": "足す",
  "=": "計算する",
};

function keyClass(k: CalcKey): string {
  if (k === "=") return "key op eq";
  if (k === "0") return "key wide";
  if (k === "C" || k === "back") return "key fn";
  if (OPERATORS.includes(k as Operator)) return "key op";
  return "key";
}

/** プルダウンの最後に置く「カテゴリを足す・直す」の値（カテゴリの ID とは重ならない） */
const EDIT_CATEGORIES = "__edit__";

function RecordTab({
  categories,
  allCategories,
  recent,
  memoSource,
  loading,
  today,
  startDate,
  enter,
  colorOf,
  isFresh,
  onAdd,
  onOpen,
  onEditCategories,
}: {
  categories: Category[];
  allCategories: Category[];
  recent: Entry[];
  memoSource: Entry[];
  loading: boolean;
  today: string;
  /** カレンダーで選んでから開いたときの日付。無ければ今日で始める */
  startDate: string | null;
  enter: string;
  colorOf: (id: string) => string;
  isFresh: (id: string) => boolean;
  onAdd: (e: NewEntry) => void;
  onOpen: (e: Entry) => void;
  onEditCategories: () => void;
}) {
  const [expr, setExpr] = useState("");
  const [catId, setCatId] = useState<string | null>(null);
  // 自分で選んだ日付だけ持つ。選んでいなければ今日（日をまたいでも付いていく）。
  // 選んだ日付はその日のうちだけ有効にする。開いたまま何日もたってから、前に選んだ日付で記録してしまわないように
  const [picked, setPicked] = useState<{ date: string; on: string } | null>(() =>
    startDate && startDate < today ? { date: startDate, on: today } : null,
  );
  const date = picked && picked.on === today ? picked.date : today;
  const pickDate = (v: string) => {
    // 端末の日付選びが上限を守らなくても、先の日付は受け取らない
    if (!v || v > today) return;
    setPicked(v === today ? null : { date: v, on: today });
  };
  const [memo, setMemo] = useState("");
  // 共通の財布でなく自分の財布で払った（あとで返してもらう）記録にするか
  const [personal, setPersonal] = useState(false);
  const value = evaluate(expr);
  const amount = value ?? 0;
  const amountOk = amount >= 1 && amount <= AMOUNT_MAX;
  // 選んでいたカテゴリが隠されたら選び直してもらう
  const chosen = catId && categories.some((c) => c.id === catId) ? catId : null;
  const ready = amountOk && chosen !== null;

  const suggestions = useMemo(
    () => memoSuggestions([...recent, ...memoSource], chosen),
    [recent, memoSource, chosen],
  );

  const press = (key: CalcKey) => {
    setExpr((e) => calcPress(e, key));
    navigator.vibrate?.(5);
  };

  // パソコンではキーボードの数字と記号でも打てる（入力欄や別の画面を開いている間は効かせない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLSelectElement || at instanceof HTMLTextAreaElement) return;
      if (document.querySelector("dialog[open]")) return;
      const key = calcKeyFromKeyboard(e.key);
      if (!key) return;
      e.preventDefault();
      setExpr((x) => calcPress(x, key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    if (!ready || !chosen) return;
    onAdd({
      amount,
      categoryId: chosen,
      date,
      memo: cleanText(memo, MEMO_MAX),
      ...(personal ? { pay: "unsettled" as const } : {}),
    });
    // 日付は戻さない（過去の日の分を続けて記録するため）
    setExpr("");
    setCatId(null);
    setMemo("");
    setPersonal(false);
  };

  const submitLabel =
    expr === ""
      ? "金額を打ってください"
      : value === null
        ? "計算できません（0で割っています）"
        : amount < 1
          ? "金額が0円以下です"
          : amount > AMOUNT_MAX
            ? `${yen(AMOUNT_MAX)}までにしてください`
            : chosen === null
              ? "カテゴリを選んでください"
              : "記録する";

  return (
    <main className={`record ${enter}`}>
      <section className="entry-card" aria-label="記録する">
        <div className="display">
          <p className="expr" aria-hidden={!hasOperator(expr)}>
            {hasOperator(expr) ? formatExpr(expr) : "\u00a0"}
          </p>
          <output
            className={expr === "" ? "amount empty" : amountOk ? "amount" : "amount bad"}
            aria-live="polite"
            aria-label="金額"
          >
            {value === null ? "—" : yen(amount)}
          </output>
        </div>

        <div className="pick-row">
          <label className="cat-select">
            <span className="sr-only">カテゴリ</span>
            <span className={`dot ${chosen ? colorOf(chosen) : "none"}`} aria-hidden="true" />
            <select
              value={chosen ?? ""}
              onChange={(e) => {
                if (e.target.value === EDIT_CATEGORIES) onEditCategories();
                else setCatId(e.target.value || null);
              }}
            >
              <option value="" disabled>
                カテゴリ
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={EDIT_CATEGORIES}>＋ カテゴリを足す・直す</option>
            </select>
          </label>
          <label className={date === today ? "date-field" : "date-field other"}>
            <span className="sr-only">日付</span>
            <span className="date-text full" aria-hidden="true">
              {dateLabel(date, today)}
            </span>
            <span className="date-text short" aria-hidden="true">
              {dateShort(date, today)}
            </span>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => pickDate(e.target.value)}
            />
          </label>
        </div>

        <div className="memo-row">
        <label className="memo-field">
          <span className="sr-only">メモ</span>
          <input
            value={memo}
            maxLength={MEMO_MAX}
            placeholder="メモ(店名など)"
            list="memo-suggestions"
            autoComplete="off"
            onChange={(e) => setMemo(e.target.value)}
            enterKeyHint="done"
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <datalist id="memo-suggestions">
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
          <button
            type="button"
            className={personal ? "pay-toggle on" : "pay-toggle"}
            aria-pressed={personal}
            onClick={() => setPersonal((v) => !v)}
          >
            自分で払った
          </button>
        </div>

        <div className="keypad" role="group" aria-label="電卓">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={keyClass(k)}
              aria-label={KEY_LABEL[k] ?? k}
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
          {submitLabel}
        </button>
      </section>

      <section className="recent" aria-labelledby="recent-h">
        <h2 id="recent-h">最近の記録</h2>
        {recent.length === 0 ? (
          <p className="muted">{loading ? "読み込んでいます…" : "まだありません。記録するとここに出ます"}</p>
        ) : (
          <ul className="entries">
            {recent.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                category={categoryOf(e.categoryId, allCategories)}
                color={colorOf(e.categoryId)}
                flash={isFresh(e.id)}
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
          <span className="entry-cat">
            {category.name}
            {entry.settled === false && <span className="unsettled-tag">未精算</span>}
            {entry.pending && <span className="pending">送信待ち</span>}
          </span>
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
  today,
  enter,
  ready,
  entries,
  categories,
  budget,
  catBudgets,
  unsettledTotal,
  colorOf,
  isFresh,
  onOpen,
  onBudget,
  onUnsettled,
  onRecordOn,
}: {
  month: string;
  onMonth: (m: string) => void;
  today: string;
  enter: string;
  /** その月の記録を読み終えたか */
  ready: boolean;
  entries: Entry[];
  categories: Category[];
  budget: number | null;
  /** カテゴリの ID → その月の予算（決めているものだけ） */
  catBudgets: ReadonlyMap<string, number>;
  /** 未精算の合計（月をまたいだ全部）。0 なら入口を出さない */
  unsettledTotal: number;
  colorOf: (id: string) => string;
  isFresh: (id: string) => boolean;
  onOpen: (e: Entry) => void;
  onBudget: () => void;
  onUnsettled: () => void;
  onRecordOn: (date: string) => void;
}) {
  const thisMonth = monthOf(today);
  const [selected, setSelected] = useState<string | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  // 月を変えたら日の選択と開いた内訳を戻し、進んだ向きから入ってくるように見せる
  const [shownMonth, setShownMonth] = useState(month);
  const [slide, setSlide] = useState("");
  if (shownMonth !== month) {
    setSlide(month < shownMonth ? "from-left" : "from-right");
    setShownMonth(month);
    setSelected(null);
    setOpenCat(null);
  }
  const weeks = calendarWeeks(month, entries);
  const total = sum(entries);
  const totals = totalsByCategory(entries, categories);
  const topTotal = Math.max(1, ...totals.map((t) => t.total));
  // 月の記録を全部並べることはしない。カレンダーで選んだ日の分だけ出す（2026-11-22 ユーザー依頼）
  const dayEntries = selected ? (groupByDate(entries.filter((e) => e.date === selected))[0]?.entries ?? []) : [];
  const daysRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // 選んだ日の記録はカレンダーの下に出るので、画面の外なら見える所まで送る
    if (selected) daysRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const left = budget !== null ? budget - total : null;
  const ratio = budget ? Math.min(1, total / budget) : 0;
  const pace = left !== null ? paceFor(month, today, left) : null;
  // 読み終える前の ¥0 を「まだ使っていない」と読み違えないよう、数字は出さない
  const shown = (n: number) => (ready ? yen(n) : "…");

  return (
    <main className={`month ${enter}`}>
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

      <div className={`month-body ${slide}`} key={month}>
      <section className="summary">
        {left !== null && budget !== null ? (
          <>
            <p className="summary-label">{month === thisMonth ? "今月の残り" : "残り"}</p>
            <p className={left < 0 ? "summary-big over" : "summary-big"}>{shown(left)}</p>
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
              予算 {yen(budget)}・使った {shown(total)}
            </p>
            {pace && (
              // 読み終える前も1行ぶんの場所を取っておき、出たときに下がずれないようにする
              <p className="summary-pace">
                {!ready ? (
                  "\u00a0"
                ) : left > 0 ? (
                  <>
                    月末まで{pace.daysLeft}日・1日あたり <strong>{yen(pace.perDay)}</strong>
                  </>
                ) : (
                  `月末まで${pace.daysLeft}日`
                )}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="summary-label">使った合計</p>
            <p className="summary-big">{shown(total)}</p>
            {month === thisMonth && (
              <button className="btn" type="button" onClick={onBudget}>
                月の予算を決める
              </button>
            )}
          </>
        )}
      </section>

      {unsettledTotal > 0 && (
        <button className="unsettled-link" type="button" onClick={onUnsettled}>
          <span>未精算</span>
          <strong>{yen(unsettledTotal)}</strong>
          <ChevronIcon dir="right" />
        </button>
      )}

      {/* 記録が届く前から場所だけ置いておき、届いたら開く（下のカレンダーが急に飛ばないように） */}
      <div className={totals.length > 0 ? "fold open by-cat-fold" : "fold by-cat-fold"} inert={totals.length === 0}>
        <section className="by-cat" aria-labelledby="bycat-h">
          <h2 id="bycat-h">カテゴリ別</h2>
          {/* 予算のある行の棒は「予算のうち使った割合」。無い行は一番多いカテゴリとの比で、見分けが付くよう薄い地を敷かない */}
          <ul className={totals.some((t) => catBudgets.has(t.category.id)) ? "mixed" : undefined}>
            {totals.map((t) => {
              const open = openCat === t.category.id;
              const limit = catBudgets.get(t.category.id) ?? null;
              const over = limit !== null && t.total > limit;
              return (
                <li key={t.category.id}>
                  <button
                    type="button"
                    className={over ? "cat-total over" : "cat-total"}
                    aria-expanded={open}
                    onClick={() => setOpenCat(open ? null : t.category.id)}
                  >
                    <span className="bar-label">{t.category.name}</span>
                    <span className={limit !== null ? "bar of-budget" : "bar"}>
                      <span
                        className={over ? "over" : colorOf(t.category.id)}
                        style={{ width: `${(limit !== null ? Math.min(1, t.total / limit) : t.total / topTotal) * 100}%` }}
                      />
                    </span>
                    <span className="bar-value">{yen(t.total)}</span>
                    <ChevronIcon dir="down" />
                    {limit !== null && (
                      <span className="cat-budget">
                        予算 {yen(limit)}・{over ? `${yen(t.total - limit)} 超え` : `残り ${yen(limit - t.total)}`}
                      </span>
                    )}
                  </button>
                  <div className={open ? "fold open" : "fold"} inert={!open}>
                    <ul className="entries inner">
                      {entries
                        .filter((e) => categoryOf(e.categoryId, categories).id === t.category.id)
                        .sort((x, y) => (x.date === y.date ? y.createdAt - x.createdAt : x.date < y.date ? 1 : -1))
                        .map((e) => (
                          <EntryRow
                            key={e.id}
                            entry={e}
                            category={t.category}
                            color={colorOf(e.categoryId)}
                            showDate
                            onOpen={() => onOpen(e)}
                          />
                        ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

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

      <section className="days" aria-label="選んだ日の記録" ref={daysRef}>
        {!selected ? (
          <p className="muted days-hint">日付を押すと、その日の記録が出ます</p>
        ) : (
          <>
            <div className="days-head">
              <h2>{dateLabel(selected, today)}</h2>
              {dayEntries.length > 0 && <span>{yen(sum(dayEntries))}</span>}
            </div>
            {selected <= today && (
              <button className="btn wide day-add" type="button" onClick={() => onRecordOn(selected)}>
                この日に記録する
              </button>
            )}
            {dayEntries.length === 0 ? (
              <p className="muted">{ready ? "この日の記録はありません" : "読み込んでいます…"}</p>
            ) : (
              <ul className="entries">
                {dayEntries.map((e) => (
                  <EntryRow
                    key={e.id}
                    entry={e}
                    category={categoryOf(e.categoryId, categories)}
                    color={colorOf(e.categoryId)}
                    flash={isFresh(e.id)}
                    onOpen={() => onOpen(e)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      </div>
    </main>
  );
}

/**
 * 自分の財布で払ったことにするときの「払った人」。もう決まっていればその人、まだなら記録を書いた人。
 * 相手が付け忘れた記録をこちらで直しても、返す相手が入れ替わらないようにする
 */
const payerOf = (e: Entry): string => (e.settled !== undefined ? (e.paidBy ?? "") : e.addedBy);

/* ---------- ダイアログ ---------- */

/** 閉じる動きの最中かどうかと、動きが終わったときに呼ぶもの。BookScreen が渡す */
const DialogContext = createContext<{
  closing: boolean;
  /** 次の画面へ移るために閉じている（後ろの暗がりは残す） */
  swapOut: boolean;
  /** 前の画面から移ってきた（後ろの暗がりはもう出ている） */
  swapIn: boolean;
  onClosed: () => void;
}>({
  closing: false,
  swapOut: false,
  swapIn: false,
  onClosed: () => {},
});
/** 閉じる動きの長さ（styles.css の .sheet.closing と揃える） */
const SHEET_CLOSE_MS = 220;

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { closing, swapOut, swapIn, onClosed } = useContext(DialogContext);
  // 描く前に開く。描いたあとだと、前の画面から移るときに暗がりの無い1コマが挟まる
  useLayoutEffect(() => {
    ref.current?.showModal();
    // showModal は最初のボタン（閉じる）へ移るので、入力欄から始めたい画面はそこへ移し直す。
    // 指で使う端末では移さない。開く動きの途中でキーボードが出て、画面が押し上げられるため
    if (window.matchMedia?.("(pointer: fine)").matches) {
      ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
  }, []);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(onClosed, SHEET_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [closing, onClosed]);
  return (
    <dialog
      ref={ref}
      className={["sheet", closing ? "closing" : "", swapOut ? "swap-out" : "", swapIn ? "swap-in" : ""]
        .filter(Boolean)
        .join(" ")}
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
  me,
  onClose,
  onSave,
  onDelete,
}: {
  entry: Entry;
  categories: Category[];
  me: string;
  onClose: () => void;
  onSave: (e: NewEntry) => void;
  onDelete: () => void;
}) {
  const current = categoryOf(entry.categoryId, categories);
  const [amountText, setAmountText] = useState(String(entry.amount));
  const [catId, setCatId] = useState(current.id);
  const [date, setDate] = useState(entry.date);
  const [memo, setMemo] = useState(entry.memo);
  const [pay, setPay] = useState<Pay>(payOf(entry));
  // 相手の記録は相手の名前で、自分の記録は「自分で」と書く
  const payer = payerOf(entry);
  const who = payer === me ? "自分で払った" : `${payer || "名前なし"}が払った`;
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
          if (!valid) return;
          onSave({
            amount,
            categoryId: catId,
            date,
            memo: cleanText(memo, MEMO_MAX),
            // 変えたときだけ書く
            ...(pay !== payOf(entry) ? { pay } : {}),
          });
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
        <label>
          <span>カテゴリ</span>
          <select value={catId} onChange={(e) => setCatId(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>日付</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <label>
          <span>メモ</span>
          <input value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} autoComplete="off" />
        </label>
        <label>
          <span>払った財布</span>
          <select value={pay} onChange={(e) => setPay(e.target.value as Pay)}>
            <option value="shared">共通の財布</option>
            <option value="unsettled">{who}・未精算</option>
            <option value="settled">{who}・精算済み</option>
          </select>
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

/** 自分の財布で払って、まだ共通の財布から返していない記録。払った人ごとに並べる */
function UnsettledDialog({
  entries,
  categories,
  colorOf,
  onClose,
  onSettle,
}: {
  entries: Entry[];
  categories: Category[];
  colorOf: (id: string) => string;
  onClose: () => void;
  onSettle: (entries: Entry[]) => void;
}) {
  const people = unsettledByPerson(entries);
  return (
    <Dialog title="未精算" onClose={onClose}>
      <div className="fields">
        {people.length === 0 && <p className="muted">未精算の記録はありません</p>}
        {people.map((p) => (
          <section key={p.name} className="unsettled-person">
            <h3>
              <span>{p.name || "名前なし"}に返す</span>
              <span>{yen(p.total)}</span>
            </h3>
            <ul className="entries">
              {p.entries.map((e) => (
                <li key={e.id} className="unsettled-row">
                  <span className={`dot ${colorOf(e.categoryId)}`} aria-hidden="true" />
                  <span className="entry-main">
                    <span className="entry-cat">{categoryOf(e.categoryId, categories).name}</span>
                    <span className="entry-sub">{[dateLabel(e.date), e.memo].filter(Boolean).join("・")}</span>
                  </span>
                  <span className="entry-amount">{yen(e.amount)}</span>
                  <button className="btn small" type="button" onClick={() => onSettle([e])}>
                    精算した
                  </button>
                </li>
              ))}
            </ul>
            {p.entries.length > 1 && (
              <button className="btn primary wide" type="button" onClick={() => onSettle(p.entries)}>
                {yen(p.total)} をまとめて精算した
              </button>
            )}
          </section>
        ))}
        <p className="muted small">
          記録画面で「自分で払った」を選んだ記録です。共通の財布から返したら「精算した」を押します。
        </p>
      </div>
    </Dialog>
  );
}

function MenuDialog({
  me,
  onMe,
  onClose,
  onToast,
  onUnsettled,
  onBudget,
  onCategories,
}: {
  me: string;
  onMe: (v: string) => void;
  onClose: () => void;
  onToast: (m: string) => void;
  onUnsettled: () => void;
  onBudget: () => void;
  onCategories: () => void;
}) {
  const [name, setName] = useState(me);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const pickTheme = (t: Theme) => {
    applyTheme(t);
    write(STORE_THEME, t);
    setTheme(t);
  };
  // ホーム画面から開いているときは、置き方の案内を出さない
  const installed =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

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
        <button className="btn wide" type="button" onClick={onUnsettled}>
          未精算
        </button>
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
        {!installed && (
          <p className="muted small">
            {/iPhone|iPad/.test(navigator.userAgent)
              ? "Safari の共有ボタンから「ホーム画面に追加」を選ぶと、アプリのように開けます。LINE などの中で開いたときは、先に Safari で開き直してください。"
              : "ブラウザのメニューから「ホーム画面に追加」を選ぶと、アプリのように開けます。"}
          </p>
        )}
        <div className="choice" role="group" aria-label="画面の明るさ">
          <span>画面の色</span>
          <div className="seg">
            <button type="button" className={theme === "light" ? "on" : ""} aria-pressed={theme === "light"} onClick={() => pickTheme("light")}>
              明るい
            </button>
            <button type="button" className={theme === "dark" ? "on" : ""} aria-pressed={theme === "dark"} onClick={() => pickTheme("dark")}>
              暗い
            </button>
          </div>
        </div>
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
  categories,
  currentByCategory,
  colorOf,
  onClose,
  onSave,
}: {
  month: string;
  current: number | null;
  /** 隠していないカテゴリ */
  categories: Category[];
  currentByCategory: ReadonlyMap<string, number>;
  colorOf: (id: string) => string;
  onClose: () => void;
  /** amount は変えたときだけ（変えていなければ null）。changed は額を変えたカテゴリだけ。0 は「決めない」 */
  onSave: (amount: number | null, changed: { id: string; amount: number }[]) => void;
}) {
  // 比べる相手は、開いた時点の額に固める。開いている間に予算が届いたり相手が変えたりしても、
  // 自分が触っていない欄を、欄に残った古い値で上書きしないため
  const [base] = useState(() => ({ amount: current ?? 0, byCategory: new Map(currentByCategory) }));
  const [text, setText] = useState(base.amount ? String(base.amount) : "");
  const [catText, setCatText] = useState<Record<string, string>>(() =>
    Object.fromEntries([...base.byCategory].map(([id, v]) => [id, String(v)])),
  );
  const amount = parseYen(text);
  const valid = amount <= BUDGET_MAX;
  const catAmount = (id: string) => parseYen(catText[id] ?? "");
  const catsValid = categories.every((c) => catAmount(c.id) <= BUDGET_MAX);
  return (
    <Dialog title="月の予算" onClose={onClose}>
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || !catsValid) return;
          // 開いた時点で効いていた額（前の月から引き継いだ分を含む）と比べ、変えた分だけ書く
          const changed = categories
            .map((c) => ({ id: c.id, amount: catAmount(c.id) }))
            .filter((c) => c.amount !== (base.byCategory.get(c.id) ?? 0));
          onSave(amount !== base.amount ? amount : null, changed);
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
        <fieldset className="cat-budgets">
          <legend>カテゴリごと（円）</legend>
          <p className="muted small">決めたいカテゴリだけ入れます。超えると「今月」のカテゴリ別が赤くなります。</p>
          {categories.map((c) => {
            const ok = catAmount(c.id) <= BUDGET_MAX;
            return (
              <label key={c.id} className="cat-budget-row">
                <span className={`dot ${colorOf(c.id)}`} aria-hidden="true" />
                <span className="cat-budget-name">{c.name}</span>
                <input
                  value={catText[c.id] ?? ""}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="決めない"
                  aria-invalid={!ok}
                  onChange={(e) => setCatText((t) => ({ ...t, [c.id]: e.target.value }))}
                />
              </label>
            );
          })}
          {!catsValid && <small className="error">{yen(BUDGET_MAX)}までで入れてください</small>}
        </fieldset>
        <div className="row end">
          <button className="btn primary" type="submit" disabled={!valid || !catsValid}>
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

/** 消える動きの長さ（styles.css の .toast.leaving と揃える） */
const TOAST_LEAVE_MS = 220;

function Toast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLeaving(true), toast.action ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(onDone, TOAST_LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving, onDone]);
  return (
    <div className={leaving ? "toast leaving" : "toast"} role="status">
      <span className="toast-text">
        <span>{toast.message}</span>
        {toast.sub && <small>{toast.sub}</small>}
      </span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            setLeaving(true);
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

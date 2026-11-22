/*
 * 暗い表示を選んでいる人には、最初の描画の前に暗い色を当てる。
 * 画面を作るスクリプトより先に動かさないと、開くたびに一瞬だけ明るい画面が見えてしまう。
 * 名前（kakeibo:theme）と色は src/App.tsx の STORE_THEME・THEME_COLOR と揃える。
 */
(function () {
  try {
    if (localStorage.getItem("kakeibo:theme") !== "dark") return;
    document.documentElement.dataset.theme = "dark";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#14181B");
  } catch (e) {
    /* 保存を読めない環境では明るい表示のまま */
  }
})();

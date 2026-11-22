# かけいぼ

ふたりで同じ家計簿を見て書く、スマホ向けのウェブアプリ。

- 公開先: https://iiiitiiitiiti.github.io/kakeibo/ （使うには一緒に使う人から届いたリンクが要る）
- 設計: [docs/DESIGN.md](docs/DESIGN.md)

## 開発

```bash
npm ci
npm test
npm run build && npm run preview
```

main に push すると GitHub Actions が GitHub Pages に出す。

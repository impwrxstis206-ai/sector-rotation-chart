# sector-rotation-chart

東証の業種別ETF（TOPIX-17, NEXT FUNDS 1617〜1633）と半導体ETF（200A, 2644）について、
任意の日時を基準点（0%）にした **TOPIX比の相対強度** を折れ線で並べ、セクターローテーションを可視化する。

```
RS(t) = (P(t) / P₀) ÷ (B(t) / B₀) − 1     B = 1306（TOPIX連動ETF）
```

## 構成

| パス | 役割 |
| --- | --- |
| `config/tickers.json` | 銘柄リスト。ここを編集すれば銘柄の追加・削除ができる（`semi: true` で強調表示対象） |
| `scripts/fetch.py` | yfinance で 30分足 / 60分足 / 日足 を取得し `data/*.json` を出力 |
| `data/` | 取得データ（GitHub Actions が commit）。30分足は過去分を蓄積していく |
| `web/` | 画面（素の HTML/JS + ECharts）。RS はブラウザ側で計算 |
| `.github/workflows/update-data.yml` | 取引時間中30分ごとに取得 → commit → GitHub Pages へデプロイ |

## データ仕様

- `data/{30m,60m,1d}.json` … `{ updated_at, interval, t: [unix秒...], tickers: { code: { c: [終値...], filled: [bool...] } } }`
  - 全銘柄で時刻軸 `t` を共有（ファイルサイズ削減のため、仕様書の例から変更）
  - 約定の無い足は前の足の終値で補完し `filled: true`（日中足で「出来高0かつ高値=安値」を約定なしと判定）
  - 上場前など値の無い部分は `null`
- 30分足: Yahoo の制限で約60営業日分しか取れないため、既存データにマージして蓄積
- 60分足: 約2年分を毎回置き換え
- 日足: 調整後終値（`auto_adjust=True`）を毎回全期間置き換え（配当落ちで過去値が変わるため）
- 取得失敗した銘柄・足種は前回データを保持

## ローカルで動かす

```sh
pip install -r requirements.txt
python scripts/fetch.py            # data/*.json を更新
python -m http.server 8765         # リポジトリのルートで
# → http://localhost:8765/web/ を開く
```

`?interval=1d&mode=pct` のように URL で初期表示を指定できる。

## GitHub への公開手順

1. GitHub でリポジトリを作成して push（`main` ブランチ）
2. Settings → Pages → Build and deployment → Source を **GitHub Actions** にする
3. Actions タブで `update-data` を **Run workflow** で1回手動実行 → Pages の URL が発行される

以降は平日の取引時間中に自動更新される（GitHub の cron は数分〜十数分遅れることがある）。

## 注意

- yfinance は非公式 API。仕様変更・レート制限（特にクラウドの IP から）で取得できなくなることがある。Actions のログを確認すること
- Yahoo のデータは遅延あり。業種ETFの一部は出来高が薄く、短期足は指数から乖離・停滞しやすい
- 「今日の寄り」は当日最初の足（30分足なら 9:00〜9:30）の**終値**を基準にする
- 60日間リポジトリに動きが無いと scheduled workflow は止まる（データ commit が続く限り問題なし）
- GitHub Pages は無料プランでは公開 URL になる

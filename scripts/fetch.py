"""yfinance で業種別ETFの30分足/60分足/日足を取得し、data/*.json を出力する。

- 30分足は Yahoo の仕様で約60日分しか取れないため、既存JSONとマージして蓄積する
- 60分足・日足は毎回取れる範囲を丸ごと置き換える（日足は調整後終値なので過去値も変わるため）
- 約定の無い足は前の足の終値で補完し、filled フラグを立てる
- 取得に失敗した銘柄は前回データを保持する

使い方: python scripts/fetch.py [--intervals 30m,60m,1d]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "tickers.json"
DATA_DIR = ROOT / "data"
TZ = "Asia/Tokyo"

# interval -> (取得期間, 調整後終値を使うか, 既存データに蓄積するか)
# 取得期間が int の場合は「今日から N 日前」を開始日として指定する。
# 60分足を period="730d" にすると上場が新しい銘柄(200A等)で Yahoo が範囲外エラーを返すため。
# 30分足は period="60d" のほうが（営業日ベースで）長く取れるので period のまま。
INTERVALS = {
    "30m": ("60d", False, True),
    "60m": (729, False, False),
    "1d": ("max", True, False),
}
RETRIES = 3

log = logging.getLogger("fetch")


def load_codes() -> tuple[list[str], str]:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    codes = [cfg["benchmark"]["code"]] + [t["code"] for t in cfg["tickers"]]
    return codes, cfg.get("suffix", ".T")


def download(codes: list[str], suffix: str, interval: str) -> dict[str, pd.Series]:
    """銘柄ごとの終値 Series（JST, 約定なしは除外）を返す。取れなかった銘柄は含まない。"""
    period, adjust, _ = INTERVALS[interval]
    symbols = [c + suffix for c in codes]
    if isinstance(period, int):
        span = {"start": (pd.Timestamp.now(tz=TZ) - pd.Timedelta(days=period)).strftime("%Y-%m-%d")}
    else:
        span = {"period": period}
    df = None
    for attempt in range(1, RETRIES + 1):
        try:
            df = yf.download(
                symbols, interval=interval, auto_adjust=adjust,
                group_by="ticker", progress=False, threads=True, **span,
            )
            if df is not None and not df.empty:
                break
            log.warning("%s: 空のデータ (試行 %d/%d)", interval, attempt, RETRIES)
        except Exception as e:  # yfinance は非公式APIなので何が飛んでくるか分からない
            log.warning("%s: 取得失敗 (試行 %d/%d): %s", interval, attempt, RETRIES, e)
        time.sleep(5 * attempt)
    if df is None or df.empty:
        return {}

    idx = df.index
    idx = idx.tz_localize(TZ) if idx.tz is None else idx.tz_convert(TZ)
    df.index = idx

    out: dict[str, pd.Series] = {}
    for code, sym in zip(codes, symbols):
        if sym not in df.columns.get_level_values(0):
            log.warning("%s: %s の列なし", interval, sym)
            continue
        sub = df[sym]
        close = sub["Close"].copy()
        # 日中足で出来高0かつ値幅0の足は約定なしとみなす（Yahooは前値を入れてくることがある）。
        # 60分足の09:00足は値が動いていても出来高0で返るため、出来高だけでは判定しない
        if interval != "1d" and {"Volume", "High", "Low"} <= set(sub.columns):
            close[(sub["Volume"].fillna(0) <= 0) & (sub["High"] == sub["Low"])] = float("nan")
        close = close.dropna()
        if close.empty:
            log.warning("%s: %s のデータが空", interval, sym)
            continue
        out[code] = close
    return out


def load_existing(path: Path) -> dict[str, pd.Series]:
    """既存JSONから補完前（実際に約定のあった足のみ）の Series を復元する。"""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("%s の読み込み失敗: %s", path.name, e)
        return {}
    t = pd.to_datetime(data["t"], unit="s", utc=True).tz_convert(TZ)
    out = {}
    for code, d in data["tickers"].items():
        s = pd.Series(d["c"], index=t, dtype="float64")
        s[pd.Series(d["filled"], index=t).astype(bool).values] = float("nan")
        out[code] = s.dropna()
    return out


def merge(old: dict[str, pd.Series], new: dict[str, pd.Series], accumulate: bool) -> dict[str, pd.Series]:
    merged = dict(old)
    for code, s in new.items():
        if accumulate and code in old:
            s = pd.concat([old[code], s])
            s = s[~s.index.duplicated(keep="last")].sort_index()
        merged[code] = s
    return merged


def build_json(series: dict[str, pd.Series], codes: list[str], interval: str) -> dict:
    df = pd.DataFrame({c: series[c] for c in codes if c in series}).sort_index()
    filled = df.isna() & df.ffill().notna()
    df = df.ffill()
    tickers = {}
    for c in df.columns:
        tickers[c] = {
            "c": [None if pd.isna(v) else round(float(v), 2) for v in df[c]],
            "filled": [bool(v) for v in filled[c]],
        }
    return {
        "updated_at": pd.Timestamp.now(tz=TZ).isoformat(timespec="seconds"),
        "interval": interval,
        "t": [int(ts.timestamp()) for ts in df.index],
        "tickers": tickers,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--intervals", default=",".join(INTERVALS))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    codes, suffix = load_codes()
    DATA_DIR.mkdir(exist_ok=True)
    ok = 0
    for interval in args.intervals.split(","):
        path = DATA_DIR / f"{interval}.json"
        new = download(codes, suffix, interval)
        if not new:
            log.error("%s: 全銘柄の取得に失敗。前回データを保持します", interval)
            continue
        missing = [c for c in codes if c not in new]
        if missing:
            log.warning("%s: 取得できなかった銘柄（前回データを保持）: %s", interval, missing)
        series = merge(load_existing(path), new, INTERVALS[interval][2])
        out = build_json(series, codes, interval)
        path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        log.info("%s: %d 本 x %d 銘柄 -> %s", interval, len(out["t"]), len(out["tickers"]), path.name)
        ok += 1
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

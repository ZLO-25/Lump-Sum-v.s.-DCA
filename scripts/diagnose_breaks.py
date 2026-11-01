"""
診斷工具：列出每個「單日大跳動」前後的原始收盤價、還原價、分割與配息事件，
用來判斷跳動是「股票分割」「除權息」還是「Yahoo 資料錯誤」。
用法：python scripts/diagnose_breaks.py [代號 ...]
"""
import json, sys
from pathlib import Path
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent

def symbols():
    if len(sys.argv) > 1:
        return sys.argv[1:]
    cfg = json.loads((ROOT / "scripts" / "tickers.json").read_text(encoding="utf-8"))
    return [t["symbol"] for g in cfg["groups"] for t in g["tickers"]]

pd.set_option("display.width", 200)
for sym in symbols():
    tw = sym.endswith(".TW") or sym.endswith(".TWO")
    h = yf.Ticker(sym).history(period="max", auto_adjust=False, actions=True)
    if h.empty:
        print(f"### {sym}: 無資料"); continue
    h.index = pd.to_datetime(h.index).tz_localize(None).normalize()
    thr = 0.25 if tw else 0.40
    out = []
    for col in ["Close", "Adj Close"]:
        r = h[col].pct_change()
        for d, v in r[r.abs() > thr].items():
            out.append((d, col, v))
    splits = h[h["Stock Splits"] != 0]["Stock Splits"]
    if not out and splits.empty:
        continue
    print(f"\n### {sym}  ({h.index[0].date()} ~ {h.index[-1].date()})")
    print("分割事件:", ", ".join(f"{d.date()} x{v:g}" for d, v in splits.items()) or "無")
    for d, col, v in out:
        print(f"-- {col} 在 {d.date()} 變動 {v:+.1%}")
        i = h.index.get_loc(d)
        w = h.iloc[max(0, i - 3): i + 3][["Close", "Adj Close", "Dividends", "Stock Splits"]].copy()
        w["Adj/Close"] = w["Adj Close"] / w["Close"]
        print(w.to_string())
    for d, v in splits.items():
        i = h.index.get_loc(d)
        w = h.iloc[max(0, i - 2): i + 2][["Close", "Adj Close", "Stock Splits"]].copy()
        print(f"-- 分割 {d.date()} x{v:g} 前後")
        print(w.to_string())

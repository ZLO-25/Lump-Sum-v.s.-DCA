"""
下載歷史價格並輸出成靜態 JSON，給 GitHub Pages 上的網頁直接讀取。

為什麼需要這支程式？
  GitHub Pages 只能放「靜態檔案」，沒有後端伺服器可以即時呼叫 yfinance；
  瀏覽器也不能直接連 Yahoo Finance（CORS 限制）。
  所以改成：GitHub Actions 每天跑一次這支程式 → 把價格存成 JSON → 一起部署。

用法：
  pip install -r scripts/requirements.txt
  python scripts/fetch_data.py
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
TICKERS_FILE = ROOT / "scripts" / "tickers.json"
OUT_DIR = ROOT / "data" / "prices"
MANIFEST = ROOT / "data" / "manifest.json"


def safe_name(symbol: str) -> str:
    """^GSPC -> _GSPC，避免檔名出現特殊字元"""
    return "".join(c if c.isalnum() or c in "-." else "_" for c in symbol)


def round_sig(x: float, sig: int = 7) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return round(x, sig - int(math.floor(math.log10(abs(x)))) - 1)


def fetch(symbol: str) -> pd.Series | None:
    # auto_adjust=False 才會同時拿到 Close 與 Adj Close；
    # Adj Close = 還原權息價，把配息再投入的效果算進去，回測才公平。
    df = yf.download(symbol, period="max", auto_adjust=False, progress=False, threads=False)
    if df is None or df.empty:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    col = "Adj Close" if "Adj Close" in df.columns else "Close"
    s = df[col].dropna()
    s = s[s > 0]
    s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
    s = s[~s.index.duplicated(keep="last")].sort_index()
    return s if len(s) > 10 else None


def main() -> int:
    config = json.loads(TICKERS_FILE.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    old_manifest = {}
    if MANIFEST.exists():
        for g in json.loads(MANIFEST.read_text(encoding="utf-8")).get("groups", []):
            for t in g["tickers"]:
                old_manifest[t["symbol"]] = t

    groups_out, ok, failed = [], 0, []
    for group in config["groups"]:
        tickers_out = []
        for t in group["tickers"]:
            sym = t["symbol"]
            file = f"prices/{safe_name(sym)}.json"
            try:
                s = fetch(sym)
            except Exception as e:  # 網路錯誤等
                print(f"  ! {sym}: {e}", file=sys.stderr)
                s = None

            if s is None:
                failed.append(sym)
                # 抓失敗就沿用上一次的資料（如果有），網站不會因為某天 Yahoo 出狀況而壞掉
                if sym in old_manifest and (ROOT / "data" / file).exists():
                    tickers_out.append(old_manifest[sym])
                continue

            # 簡單的資料品質檢查：單日漲跌超過 ±60% 通常是資料錯誤（或極端個股事件），印出來人工確認
            jumps = s.pct_change().abs()
            for d, v in jumps[jumps > 0.6].items():
                print(f"  ? {sym} {d.date()} 單日變動 {v:+.0%}，請確認資料是否正確")

            payload = {
                "symbol": sym,
                "dates": [d.strftime("%Y-%m-%d") for d in s.index],
                "close": [round_sig(float(v)) for v in s.values],
            }
            (ROOT / "data" / file).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            tickers_out.append({
                **t,
                "file": file,
                "currency": "TWD" if sym.endswith(".TW") or sym == "^TWII" else "USD",
                "start": payload["dates"][0],
                "end": payload["dates"][-1],
                "rows": len(payload["dates"]),
            })
            ok += 1
            print(f"  ✓ {sym:10s} {payload['dates'][0]} ~ {payload['dates'][-1]} ({len(s)} 筆)")
        groups_out.append({"name": group["name"], "tickers": tickers_out})

    manifest = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": "Yahoo Finance（透過 yfinance，Adj Close 還原權息價）",
        "groups": groups_out,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n完成：成功 {ok} 檔，失敗 {len(failed)} 檔 {failed if failed else ''}")
    # 全部失敗才回傳錯誤碼（讓 Actions 顯示紅燈）
    return 1 if ok == 0 else 0


if __name__ == "__main__":
    sys.exit(main())

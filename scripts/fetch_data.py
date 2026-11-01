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

ROOT = Path(__file__).resolve().parent.parent
TICKERS_FILE = ROOT / "scripts" / "tickers.json"
OUT_DIR = ROOT / "data" / "prices"
MANIFEST = ROOT / "data" / "manifest.json"


def safe_name(symbol: str) -> str:
    """^GSPC -> _GSPC，避免檔名出現特殊字元"""
    return "".join(c if c.isalnum() or c in "-." else "_" for c in symbol)


def currency_of(symbol: str) -> str:
    if symbol.endswith(".TW") or symbol == "^TWII":
        return "TWD"
    if symbol.endswith(".HK") or symbol == "^HSI":
        return "HKD"
    return "USD"


def daily_limit(d) -> float:
    """台股單日漲跌幅上限：2015-06-01 起 ±10%，之前 ±7%"""
    return 0.10 if d >= pd.Timestamp("2015-06-01") else 0.07


def repair_limit_breaks(symbol: str, s: pd.Series, splits: pd.Series | None = None):
    """
    台股有每日漲跌幅限制（2015/6 前 ±7%，之後 ±10%），單日變動超過 ±25% 一定不是真的漲跌，
    而是 Yahoo 在「分割 / 除權（配股）」的還原上出錯。逐一判斷每個斷層屬於哪一種，再用正確比例修正：

      跳動比例 j = 當天價格 ÷ 前一天價格
      修正方式 = 斷層前的價格整段乘上 f，修正後當天報酬 = j ÷ f − 1（必須落在漲跌幅限制內）

      ┌ 附近 3 個交易日內有分割/配股事件（比例 r）
      │   j ≈ 1/r → 事件沒有往前還原          → f = 1/r
      │   j ≈ r   → 事件被反方向還原           → f = r
      ├ 沒有事件，但 j ≈ 1/N（N 為整數，誤差 ≤ 3%）
      │   → 之後的「1 拆 N」分割只還原到一半  → f = 1/N（例如 0050 的 1 拆 4）
      └ 都不符合 → 單純資料斷層，無法得知真實漲跌 → f = j（當天報酬視為 0）

    用分割比例修正（而不是一律把當天報酬設為 0）可以保留當天真實的漲跌。
    回傳 (修正後序列, [(日期, 原始跳動, 判斷, 修正後當天報酬)])
    """
    fixes = []
    if not (symbol.endswith(".TW") or symbol.endswith(".TWO")):
        return s, fixes
    s = s.copy()
    if splits is None:
        splits = pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    events = splits[splits > 0]
    for _ in range(20):  # 最多修 20 個斷層
        r = s.pct_change()
        bad = r[r.abs() > 0.25]
        if bad.empty:
            break
        d = bad.index[0]
        i = s.index.get_loc(d)
        j = float(s.iloc[i] / s.iloc[i - 1])
        lim = daily_limit(d)
        best = None  # (誤差, f, 判斷)

        def consider(f, label, tol):
            nonlocal best
            err = abs(j / f - 1)
            if err <= tol and (best is None or err < best[0]):
                best = (err, f, label)

        lo, hi = s.index[max(0, i - 3)], s.index[min(len(s) - 1, i + 3)]
        for ed, ratio in events[(events.index >= lo) & (events.index <= hi)].items():
            consider(1 / ratio, f"{ed.date()} 配股/分割 ×{ratio:g} 沒有往前還原", lim)
            consider(ratio, f"{ed.date()} 配股/分割 ×{ratio:g} 被反方向還原", lim)
        if best is None:
            for n in range(2, 51):
                consider(1 / n, f"之後的 1 拆 {n} 分割只還原到這一天為止", 0.03)
                consider(n, f"之後的 {n} 合 1 只還原到這一天為止", 0.03)
        if best is None:
            best = (0.0, j, "無對應的分割/配股事件 → 資料斷層，當天報酬視為 0")
        _, f, label = best
        s.iloc[:i] = s.iloc[:i] * f
        fixes.append((d.date(), j - 1, label, j / f - 1))
    return s, fixes


def round_sig(x: float, sig: int = 7) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return round(x, sig - int(math.floor(math.log10(abs(x)))) - 1)


def fetch(symbol: str):
    """回傳 (還原權息價序列, 分割/配股事件序列)"""
    import yfinance as yf  # 放在這裡，讓單元測試不需要安裝 yfinance

    # auto_adjust=False 才會同時拿到 Close 與 Adj Close；
    # Adj Close = 還原權息價，把配息再投入的效果算進去，回測才公平。
    # actions=True 會附上 Stock Splits（分割 / 台股配股）欄位，用來判斷價格斷層的原因。
    df = yf.Ticker(symbol).history(period="max", auto_adjust=False, actions=True)
    if df is None or df.empty:
        return None, None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    df = df[~df.index.duplicated(keep="last")].sort_index()
    col = "Adj Close" if "Adj Close" in df.columns else "Close"
    s = df[col].dropna()
    s = s[s > 0]
    splits = df["Stock Splits"] if "Stock Splits" in df.columns else None
    return (s, splits) if len(s) > 10 else (None, None)


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
                s, splits = fetch(sym)
            except Exception as e:  # 網路錯誤等
                print(f"  ! {sym}: {e}", file=sys.stderr)
                s, splits = None, None

            if s is None:
                failed.append(sym)
                # 抓失敗就沿用上一次的資料（如果有），網站不會因為某天 Yahoo 出狀況而壞掉
                if sym in old_manifest and (ROOT / "data" / file).exists():
                    tickers_out.append(old_manifest[sym])
                continue

            # 資料品質檢查
            s, fixes = repair_limit_breaks(sym, s, splits)
            for d, v, label, after in fixes:
                print(f"  ! {sym} {d} 單日變動 {v:+.1%} 超過漲跌幅限制：{label}；校正後當天 {after:+.2%}")
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
                "currency": currency_of(sym),
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

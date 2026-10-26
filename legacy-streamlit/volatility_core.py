import yfinance as yf
import pandas as pd
import numpy as np
from tabulate import tabulate
import argparse

def analyze_volatility(ticker, thresholds=[3, 5, 10, 15]):
    try:
        # 1. 獲取歷史日K線資料
        df = yf.download(ticker, period="max", auto_adjust=False, progress=False)
        if df.empty:
            return {"error": f"找不到 {ticker} 的歷史資料，可能無效或已下市。"}

        # 2. 單日波動：計算每日漲跌幅百分比
        close = df['Adj Close'] if 'Adj Close' in df.columns else df.get('Close')
        if close is None:
            return {"error": f"資料格式錯誤：找不到收盤價欄位。"}
        if isinstance(close, pd.DataFrame):
            close = close.iloc[:, 0]
            
        close = close.dropna()
        if close.empty:
            return {"error": f"{ticker} 無有效的收盤價。"}

        daily_returns = close.pct_change() * 100
        daily_returns = daily_returns.dropna()

        # 3. 閾值事件統計
        stats = {"股票代號": ticker, "資料天數": len(daily_returns)}
        for t in thresholds:
            stats[f"漲幅 >= {t}% (次)"] = (daily_returns >= t).sum()
            stats[f"跌幅 >= {t}% (次)"] = (daily_returns <= -t).sum()

        # 4. 連續波段計算
        # 標記漲跌方向：>0 為 1, <0 為 -1, ==0 為 0
        direction = pd.Series(0, index=daily_returns.index, name='direction')
        direction[daily_returns > 0] = 1
        direction[daily_returns < 0] = -1

        # 使用 shift 計算方向改變的位置，累積加總作為分群依據 (streak_id)
        streak_id = (direction != direction.shift()).cumsum()

        # 分群計算連續天數與累積漲跌幅
        streaks = daily_returns.groupby([direction, streak_id]).agg(
            days='count',
            cumulative_return=lambda x: ((1 + x/100).prod() - 1) * 100
        ).reset_index(level=0)

        # 找出連續上漲 (direction == 1)
        up_streaks = streaks[streaks['direction'] == 1]
        if not up_streaks.empty:
            max_up_days_idx = up_streaks['days'].idxmax()
            max_up_days = up_streaks.loc[max_up_days_idx, 'days']
            max_up_cum_ret = up_streaks.loc[max_up_days_idx, 'cumulative_return']
        else:
            max_up_days = 0
            max_up_cum_ret = 0.0

        # 找出連續下跌 (direction == -1)
        down_streaks = streaks[streaks['direction'] == -1]
        if not down_streaks.empty:
            max_down_days_idx = down_streaks['days'].idxmax()
            max_down_days = down_streaks.loc[max_down_days_idx, 'days']
            max_down_cum_ret = down_streaks.loc[max_down_days_idx, 'cumulative_return']
        else:
            max_down_days = 0
            max_down_cum_ret = 0.0

        stats["歷史最長連漲 (天)"] = max_up_days
        stats["連漲累積漲幅 (%)"] = round(max_up_cum_ret, 2)
        stats["歷史最長連跌 (天)"] = max_down_days
        stats["連跌累積跌幅 (%)"] = round(max_down_cum_ret, 2)

        # 5. 新增風險指標
        # (1) 最大回撤 (MDD)
        roll_max = close.cummax()
        drawdown = (close / roll_max) - 1.0
        mdd = drawdown.min() * 100

        # (2) 年化波動率 (Annualized Volatility)
        ann_vol = daily_returns.std() * np.sqrt(252)

        # (3) 索提諾比率 (Sortino Ratio)
        downside_returns = daily_returns[daily_returns < 0]
        downside_std = downside_returns.std()
        if downside_std > 0:
            sortino = (daily_returns.mean() / downside_std) * np.sqrt(252)
        else:
            sortino = np.nan

        stats["最大回撤(%)"] = round(mdd, 2)
        stats["年化波動率(%)"] = round(ann_vol, 2)
        stats["索提諾比率"] = round(sortino, 2)
        stats["_drawdown"] = drawdown

        return stats

    except Exception as e:
        return {"error": f"處理 {ticker} 時發生錯誤: {str(e)}"}

def main():
    parser = argparse.ArgumentParser(description="股票歷史日K線波動回測")
    parser.add_argument("--tickers", nargs='+', default=["NVDA", "2330.TW"], help="目標股票代號")
    parser.add_argument("--thresholds", type=float, nargs='+', default=[3, 5, 10, 15], help="漲跌幅百分比閾值")
    args = parser.parse_args()

    results = []
    errors = []

    print(f"開始分析目標股票: {', '.join(args.tickers)}")
    print(f"分析閾值: {args.thresholds}%")
    print("-" * 50)

    for ticker in args.tickers:
        print(f"正在分析 {ticker}...")
        res = analyze_volatility(ticker, args.thresholds)
        if "error" in res:
            errors.append(res["error"])
        else:
            res.pop("_drawdown", None)
            results.append(res)

    print("\n" + "="*80)
    print("波動回測統計結果")
    print("="*80)

    if results:
        df_results = pd.DataFrame(results)
        table_str = tabulate(df_results, headers='keys', tablefmt='pipe', showindex=False)
        print(table_str)
        with open("volatility_test_results.md", "w", encoding="utf-8") as f:
            f.write("# 波動回測測試結果 (NVDA, 2330.TW)\n\n")
            f.write(table_str)
            if errors:
                f.write("\n\n## 錯誤報告\n")
                for err in errors:
                    f.write(f"- {err}\n")

if __name__ == "__main__":
    main()

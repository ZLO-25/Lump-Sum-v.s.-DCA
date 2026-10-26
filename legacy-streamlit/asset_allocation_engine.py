import pandas as pd
import yfinance as yf
import plotly.graph_objects as go
import streamlit as st
import numpy as np

def run_asset_allocation_backtest(initial_capital, assets_df, start_date_str, end_date_str, rebalance_freq, enable_withdrawal, withdrawal_amount, withdrawal_freq):
    tickers = assets_df['標的代號'].tolist()
    weights = (assets_df['配置比例(%)'] / 100.0).tolist()
    
    # 1. 抓取資料
    with st.spinner("正在下載並對齊歷史資料..."):
        data = yf.download(tickers, start=start_date_str, end=end_date_str, auto_adjust=False, progress=False)
        if data.empty:
            st.error("找不到歷史資料")
            return None, None, None
            
        if 'Adj Close' in data.columns:
            df_prices = data['Adj Close']
        elif 'Close' in data.columns:
            df_prices = data['Close']
        else:
            st.error("無法取得收盤價資料")
            return None, None, None
            
        if isinstance(df_prices, pd.Series): # 若只有單一標的
            df_prices = df_prices.to_frame(tickers[0])
            
        # 移除有任何標的缺漏資料的日子 (確保回測齊頭平等)
        df_prices = df_prices.dropna(how='any')
        
        if df_prices.empty:
            st.error("⚠️ 找不到所有標的共同存在的日期區間！這通常是因為你選擇的開始日期早於某些 ETF/股票的上市日期。請調整開始日期或更換標的。")
            return None, None, None
            
    actual_start_date = df_prices.index[0]
    st.info(f"✅ 回測實際開始日期：**{actual_start_date.strftime('%Y-%m-%d')}** (基於所有標的皆有歷史報價的第一天)")
    
    dates = df_prices.index
    portfolio_history = []
    annual_summary = []
    
    # 初始化
    current_shares = np.array([(initial_capital * w) / df_prices[t].iloc[0] for t, w in zip(tickers, weights)])
    prev_date = dates[0]
    bankrupt = False
    
    year_start_prices = df_prices.iloc[0].values
    year_withdrawal_total = 0
    total_withdrawn_overall = 0
    
    with st.spinner("正在進行逐日回測計算..."):
        for i, current_date in enumerate(dates):
            if bankrupt:
                portfolio_history.append({'Date': current_date, 'Total_Value': 0})
                continue
                
            current_prices = df_prices.iloc[i].values
            current_values = current_shares * current_prices
            total_value = np.sum(current_values)
            
            # 再平衡邏輯 (買低賣高)
            do_rebalance = False
            if rebalance_freq == "每年 (年底)" and current_date.year != prev_date.year:
                do_rebalance = True
            elif rebalance_freq == "每季" and (current_date.month - 1) // 3 != (prev_date.month - 1) // 3:
                do_rebalance = True
            elif rebalance_freq == "每月" and current_date.month != prev_date.month:
                do_rebalance = True
                
            if do_rebalance:
                # 重新計算所需股數
                current_shares = np.array([(total_value * w) / p for w, p in zip(weights, current_prices)])
                current_values = current_shares * current_prices
                
            # 提領邏輯 (等比例賣出)
            withdrawn_today = 0
            do_withdraw = False
            if enable_withdrawal:
                if withdrawal_freq == "每年" and current_date.year != prev_date.year:
                    do_withdraw = True
                elif withdrawal_freq == "每月" and current_date.month != prev_date.month:
                    do_withdraw = True
                    
                if do_withdraw:
                    if total_value <= withdrawal_amount:
                        bankrupt = True
                        withdrawn_today = total_value
                        total_value = 0
                        current_shares = np.zeros_like(current_shares)
                    else:
                        sell_ratio = withdrawal_amount / total_value
                        current_shares = current_shares * (1 - sell_ratio)
                        total_value -= withdrawal_amount
                        withdrawn_today = withdrawal_amount
                    
                    year_withdrawal_total += withdrawn_today
                    total_withdrawn_overall += withdrawn_today
                    
            portfolio_history.append({'Date': current_date, 'Total_Value': total_value})
            
            # 年度報表結算 (該年的最後一個交易日)
            is_last_day_of_year = False
            if i == len(dates) - 1:
                is_last_day_of_year = True
            elif current_date.year != dates[i+1].year:
                is_last_day_of_year = True
                
            if is_last_day_of_year:
                if not bankrupt:
                    asset_returns = (current_prices / year_start_prices - 1) * 100
                else:
                    asset_returns = np.zeros_like(current_prices)
                    
                row = {'年份': str(current_date.year)}
                for t_idx, ticker in enumerate(tickers):
                    # 依據附件表格格式
                    row[f'{ticker} 標的報酬(%)'] = asset_returns[t_idx] if not bankrupt else 0.0
                    row[f'{ticker} 帳戶金額'] = current_shares[t_idx] * current_prices[t_idx] if not bankrupt else 0.0
                    
                row['年底總金額 (提領前)'] = total_value + withdrawn_today if (do_withdraw and not bankrupt) else total_value
                row['當年提款合計'] = year_withdrawal_total
                row['最終餘額'] = total_value
                
                annual_summary.append(row)
                
                if i < len(dates) - 1:
                    year_start_prices = df_prices.iloc[i+1].values
                year_withdrawal_total = 0
                
            prev_date = current_date
            
    df_history = pd.DataFrame(portfolio_history).set_index('Date')
    df_summary = pd.DataFrame(annual_summary)
    
    # 計算 CAGR
    days_elapsed = (dates[-1] - dates[0]).days
    years = max(days_elapsed / 365.25, 1 / 365.25)
    final_val = df_history['Total_Value'].iloc[-1]
    
    if final_val > 0:
        cagr = ((final_val / initial_capital) ** (1 / years) - 1) * 100
    else:
        cagr = -100.0
        
    metrics = {
        "final_value": final_val,
        "total_withdrawn": total_withdrawn_overall,
        "cagr": cagr,
        "bankrupt": bankrupt
    }
    
    return df_history, df_summary, metrics

import pandas as pd
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots

def calculate_metrics(df_equity, df_trades, initial_capital):
    if df_equity.empty:
        return {}
        
    final_equity = df_equity['Equity'].iloc[-1]
    total_return = (final_equity / initial_capital - 1) * 100
    
    # CAGR
    days = (df_equity['Date'].iloc[-1] - df_equity['Date'].iloc[0]).days
    years = max(days / 365.25, 1 / 365.25)
    cagr = ((final_equity / initial_capital) ** (1 / years) - 1) * 100 if final_equity > 0 else -100
    
    # Drawdown
    roll_max = df_equity['Equity'].cummax()
    drawdown = (df_equity['Equity'] - roll_max) / roll_max * 100
    max_drawdown = drawdown.min()
    
    # Trade metrics
    if not df_trades.empty:
        winning_trades = df_trades[df_trades['淨利 (PnL)'] > 0]
        losing_trades = df_trades[df_trades['淨利 (PnL)'] <= 0]
        
        win_rate = (len(winning_trades) / len(df_trades)) * 100
        gross_profit = winning_trades['淨利 (PnL)'].sum()
        gross_loss = abs(losing_trades['淨利 (PnL)'].sum())
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float('inf')
        
        avg_trade = df_trades['淨利 (PnL)'].mean()
    else:
        win_rate = 0
        profit_factor = 0
        avg_trade = 0
        
    # Sharpe Ratio (Daily approx, Risk Free = 0)
    daily_returns = df_equity['Equity'].pct_change().dropna()
    if len(daily_returns) > 0 and daily_returns.std() > 0:
        sharpe = (daily_returns.mean() / daily_returns.std()) * np.sqrt(252)
    else:
        sharpe = 0
        
    return {
        "初始資金": initial_capital,
        "最終淨值": final_equity,
        "總報酬率 (%)": total_return,
        "年化報酬率 (CAGR %)": cagr,
        "最大回檔 (MDD %)": max_drawdown,
        "夏普值 (Sharpe)": sharpe,
        "勝率 (%)": win_rate,
        "獲利因子": profit_factor,
        "總交易次數": len(df_trades),
        "平均單筆損益": avg_trade
    }

def run_algo_backtest(df, script_code, initial_capital, commission_pct, slippage_abs, sizing_type, sizing_value):
    df_signal = df.copy()
    
    # 建立沙盒環境執行腳本
    local_vars = {'df': df_signal, 'pd': pd, 'np': np}
    try:
        exec(script_code, {}, local_vars)
    except Exception as e:
        return None, None, None, None, f"程式碼語法錯誤或執行失敗:\n{str(e)}"
        
    df_signal = local_vars['df']
    if 'Signal' not in df_signal.columns:
        return None, None, None, None, "錯誤: 腳本執行後找不到 'Signal' 欄位！請在程式中加上 df['Signal'] = ..."
        
    # 開始回測
    signals = df_signal['Signal'].fillna(0).values
    opens = df_signal['Open'].values
    closes = df_signal['Close'].values
    dates = df_signal.index
    n = len(df_signal)
    
    cash = initial_capital
    position_qty = 0
    entry_price = 0
    entry_date = None
    entry_comm = 0
    
    equity_curve = [{'Date': dates[0], 'Equity': initial_capital, 'Benchmark': initial_capital}]
    trades = []
    
    for i in range(1, n):
        target_signal = signals[i-1] # 根據昨天收盤後的訊號，決定今天的動作
        current_signal = np.sign(position_qty) if position_qty != 0 else 0
        
        if target_signal != current_signal:
            # 1. 關閉既有部位 (出場)
            if position_qty != 0:
                exec_price = opens[i]
                exec_price = exec_price - slippage_abs if position_qty > 0 else exec_price + slippage_abs
                
                trade_value = abs(position_qty) * exec_price
                comm = trade_value * (commission_pct / 100.0)
                
                if position_qty > 0: # 多單平倉
                    cash += trade_value - comm
                    pnl = (exec_price - entry_price) * position_qty - comm - entry_comm
                else: # 空單平倉
                    cash -= (trade_value + comm)
                    pnl = (entry_price - exec_price) * abs(position_qty) - comm - entry_comm
                    
                trades.append({
                    'Type': '多單 (Long)' if position_qty > 0 else '空單 (Short)',
                    '進場時間': entry_date,
                    '進場價格': entry_price,
                    '出場時間': dates[i],
                    '出場價格': exec_price,
                    '數量': abs(position_qty),
                    '淨利 (PnL)': pnl,
                    '報酬率 (%)': (pnl / (abs(position_qty) * entry_price)) * 100 if entry_price > 0 else 0
                })
                position_qty = 0
                
            # 2. 開啟新部位 (進場)
            if target_signal != 0:
                exec_price = opens[i]
                exec_price = exec_price + slippage_abs if target_signal > 0 else exec_price - slippage_abs
                
                # 計算部位規模
                if sizing_type == "動態 All-in (剩餘資金)":
                    trade_value = cash
                    qty = trade_value / exec_price if exec_price > 0 else 0
                elif sizing_type == "固定資金比例 (%)":
                    trade_value = cash * (sizing_value / 100.0)
                    qty = trade_value / exec_price if exec_price > 0 else 0
                elif sizing_type == "固定投資金額":
                    trade_value = sizing_value
                    qty = trade_value / exec_price if exec_price > 0 else 0
                elif sizing_type == "固定交易數量 (股/口)":
                    qty = sizing_value
                    trade_value = qty * exec_price
                else:
                    qty = 0
                    trade_value = 0
                    
                if qty > 0:
                    comm = trade_value * (commission_pct / 100.0)
                    if target_signal > 0:
                        cash -= (trade_value + comm)
                        position_qty = qty
                    else:
                        cash += (trade_value - comm)
                        position_qty = -qty
                        
                    entry_price = exec_price
                    entry_date = dates[i]
                    entry_comm = comm
                
        # 每日市值結算 (Mark-to-Market)
        if position_qty > 0:
            equity = cash + position_qty * closes[i]
        elif position_qty < 0:
            equity = cash - abs(position_qty) * closes[i]
        else:
            equity = cash
            
        benchmark = initial_capital * (closes[i] / closes[0]) if closes[0] > 0 else initial_capital
        equity_curve.append({'Date': dates[i], 'Equity': equity, 'Benchmark': benchmark})
        
    df_equity = pd.DataFrame(equity_curve)
    df_trades = pd.DataFrame(trades)
    
    # 產生帶有買賣點的圖表資料
    df_signal['Buy_Marker'] = np.where((df_signal['Signal'] == 1) & (df_signal['Signal'].shift(1) != 1), df_signal['Low'] * 0.99, np.nan)
    df_signal['Sell_Marker'] = np.where((df_signal['Signal'] == -1) & (df_signal['Signal'].shift(1) != -1), df_signal['High'] * 1.01, np.nan)
    df_signal['Flat_Marker'] = np.where((df_signal['Signal'] == 0) & (df_signal['Signal'].shift(1) != 0), df_signal['Close'], np.nan)

    metrics = calculate_metrics(df_equity, df_trades, initial_capital)
    
    return df_equity, df_trades, metrics, df_signal, None

def plot_algo_charts(df_signal, df_equity, ticker):
    # 雙層圖表：上方K線與訊號，下方權益曲線
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, 
                        vertical_spacing=0.05, row_heights=[0.6, 0.4])
    
    # K線圖
    fig.add_trace(go.Candlestick(x=df_signal.index,
                                 open=df_signal['Open'], high=df_signal['High'],
                                 low=df_signal['Low'], close=df_signal['Close'],
                                 name='K線'), row=1, col=1)
                                 
    # 畫出指標 (如果腳本有產生這幾個常見指標)
    for col, color in zip(['SMA20', 'SMA60', 'K', 'D'], ['blue', 'orange', 'red', 'green']):
        if col in df_signal.columns:
            fig.add_trace(go.Scatter(x=df_signal.index, y=df_signal[col], mode='lines', name=col, line=dict(color=color, width=1)), row=1, col=1)
            
    # 買賣標記
    fig.add_trace(go.Scatter(x=df_signal.index, y=df_signal['Buy_Marker'], mode='markers',
                             marker=dict(symbol='triangle-up', size=12, color='green'), name='買進做多'), row=1, col=1)
    fig.add_trace(go.Scatter(x=df_signal.index, y=df_signal['Sell_Marker'], mode='markers',
                             marker=dict(symbol='triangle-down', size=12, color='red'), name='放空'), row=1, col=1)
    fig.add_trace(go.Scatter(x=df_signal.index, y=df_signal['Flat_Marker'], mode='markers',
                             marker=dict(symbol='x', size=10, color='gray'), name='平倉空手'), row=1, col=1)

    # 權益曲線
    fig.add_trace(go.Scatter(x=df_equity['Date'], y=df_equity['Equity'], mode='lines', name='策略淨值', line=dict(color='purple', width=2)), row=2, col=1)
    fig.add_trace(go.Scatter(x=df_equity['Date'], y=df_equity['Benchmark'], mode='lines', name='Buy & Hold (基準)', line=dict(color='gray', width=1, dash='dash')), row=2, col=1)
    
    fig.update_layout(height=1200, margin=dict(l=0, r=0, t=30, b=0), hovermode="x unified",
                      xaxis_rangeslider_visible=False, xaxis2_rangeslider_visible=True,
                      legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                      
    return fig

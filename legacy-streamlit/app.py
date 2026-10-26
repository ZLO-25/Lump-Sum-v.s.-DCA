import streamlit as st
import yfinance as yf
import pandas as pd
import plotly.graph_objects as go
from datetime import datetime, date
from asset_allocation_engine import run_asset_allocation_backtest
from tradingview_engine import render_tradingview_dashboard
from volatility_engine import render_volatility_backtest

# 頁面設定
st.set_page_config(page_title="All-in v.s DCA", page_icon="📈", layout="wide")

# 歷史重大股災高低點
HISTORICAL_EVENTS = {
    "--- 自訂開始日期 ---": None,
    "📉 2022 升息前高點 (2022-01-03)": date(2022, 1, 3),
    "📈 2022 熊市反轉低點 (2022-10-12)": date(2022, 10, 12),
    "📉 2020 新冠疫情高點 (2020-02-19)": date(2020, 2, 19),
    "📈 2020 新冠疫情低點 (2020-03-23)": date(2020, 3, 23),
    "📉 2007 金融海嘯高點 (2007-10-09)": date(2007, 10, 9),
    "📈 2009 金融海嘯低點 (2009-03-09)": date(2009, 3, 9),
    "📉 2000 網路泡沫高點 (2000-03-24)": date(2000, 3, 24),
    "📈 2002 網路泡沫低點 (2002-10-09)": date(2002, 10, 9),
    "📉 1929 經濟大蕭條高點 (1929-09-03)": date(1929, 9, 3),
    "📈 1932 經濟大蕭條低點 (1932-07-08)": date(1932, 7, 8),
}

# --- 側邊欄導航 ---
app_mode = st.sidebar.radio(
    "選擇功能", 
    ["📈 All-in v.s DCA", "💼 資產配置", "📊 多區塊看盤軟體", "⚡ 波動回測"], 
    label_visibility="collapsed",
    key="main_app_mode_radio"
)
st.sidebar.markdown("---")

# --- 輔助函式 ---
def color_returns(val):
    """將 DataFrame 中的負數標記為紅色，正數標記為綠色"""
    if isinstance(val, (int, float)):
        if val < 0:
            return 'color: #ff4b4b; font-weight: bold;'
        elif val > 0:
            return 'color: #09ab3b;'
    return ''

def apply_style(df_style):
    if hasattr(df_style, 'map'):
        return df_style.map(color_returns)
    else:
        return df_style.applymap(color_returns)

# ==========================================
# 模組 1：All-in v.s DCA
# ==========================================
def render_lump_sum_vs_dca():
    st.subheader("📈 All-in v.s DCA 投資策略回測")
    st.markdown("比較「單筆投入」與「定期定額」在不同市場情境下的績效表現，圖表支援互動式縮放與數值查看！")
    
    with st.expander("ℹ️ 使用說明與 DCA 計算邏輯", expanded=False):
        st.markdown("""
        **💡 簡易使用說明：**
        1. 於左側設定**股票代號**（支援多筆，用空格隔開，例如 `SPY QQQ 0050.TW`）。
        2. 設定**總投資金額**與**回測時間區間**（可利用下拉選單快速載入歷史股災日）。
        3. 選擇 DCA 的**投入頻率**，點擊「執行回測」查看折線圖與表格。
    
        **📊 定期定額 (DCA) 是怎麼計算的？**
        - 你可以自行設定 **「DCA 買進區間 (月)」** 以及 **「DCA 分批次數」**。預設是從開始日期起算的 1 年內，平分成 12 次買進。
        - 假設你投資 120 萬，設定 12 個月分 12 次買，每個月就會拿 10 萬出來買該標的。
        - **圖表上的資產價值** = 「手中尚未投入的剩餘現金」 + 「已買入股票的當下市值」。
        - 如果回測時間長於你的 DCA 買進區間，代表買完後就一直持有到結束。這能最真實地反映總資產變化差異！
        """)
        
    st.sidebar.header("⚙️ 設定參數")
    tickers_input = st.sidebar.text_input("股票代號 (支援多個，以空格分隔)", "SPY QQQ")
    total_investment = st.sidebar.number_input("總投資金額 ($)", min_value=1000.0, value=1000000.0, step=10000.0)
    
    selected_event = st.sidebar.selectbox("歷史重大事件快速選擇", list(HISTORICAL_EVENTS.keys()))
    default_start_date = HISTORICAL_EVENTS[selected_event] if HISTORICAL_EVENTS[selected_event] else date(2018, 1, 1)
    
    start_date = st.sidebar.date_input("開始日期", default_start_date)
    end_date = st.sidebar.date_input("結束日期", date.today())
    
    st.sidebar.markdown("---")
    st.sidebar.subheader("📅 DCA 買進設定")
    dca_months = st.sidebar.number_input("DCA 買進區間 (個月)", min_value=1, value=12, step=1)
    dca_n_installments = st.sidebar.number_input("DCA 分批次數", min_value=1, value=12, step=1)
    
    if st.sidebar.button("🚀 執行回測", use_container_width=True, type="primary"):
        tickers = [t.strip() for t in tickers_input.replace(',', ' ').split() if t.strip()]
        if not tickers:
            st.error("請填寫至少一個股票代號！")
            st.stop()
            
        start_date_str = start_date.strftime('%Y-%m-%d')
        end_date_str = end_date.strftime('%Y-%m-%d')
        
        with st.spinner("正在下載資料與計算中，請稍候..."):
            fig = go.Figure()
            annual_data_rows = []
            total_summary = []
            colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2']
            has_plotted = False
            
            for i, ticker in enumerate(tickers):
                data = yf.download(ticker, start=start_date_str, end=end_date_str, auto_adjust=False, progress=False)
                if data.empty:
                    st.warning(f"找不到 {ticker} 的歷史資料。")
                    continue
                    
                prices = data['Adj Close'] if 'Adj Close' in data.columns else data.get('Close')
                if prices is None: continue
                if isinstance(prices, pd.DataFrame): prices = prices.iloc[:, 0]
                    
                prices = prices.dropna()
                if prices.empty: continue
                    
                days_elapsed = (prices.index[-1] - prices.index[0]).days
                years = max(days_elapsed / 365.25, 1/365.25)
                
                # Lump Sum
                ls_shares = total_investment / prices.iloc[0]
                ls_portfolio_value = ls_shares * prices
                ls_ret = (ls_portfolio_value.iloc[-1] / total_investment - 1) * 100
                ls_cagr = ((ls_portfolio_value.iloc[-1] / total_investment) ** (1 / years) - 1) * 100 if ls_portfolio_value.iloc[-1] > 0 else 0
                
                # DCA
                prices_naive_index = prices.index.tz_localize(None)
                target_dca_end = prices_naive_index[0] + pd.DateOffset(months=dca_months)
                ideal_dates = pd.date_range(start=prices_naive_index[0], end=target_dca_end, periods=dca_n_installments)
                
                real_investment_dates = []
                for ideal_date in ideal_dates:
                    idx = prices_naive_index.searchsorted(ideal_date)
                    if idx < len(prices_naive_index):
                        real_investment_dates.append(prices.index[idx])
                
                from collections import Counter
                date_counts = Counter(real_investment_dates)
                
                inv_per_period = total_investment / dca_n_installments
                dca_shares = 0
                dca_cash = total_investment
                dca_portfolio_value = []
                
                for d, p in prices.items():
                    if d in date_counts:
                        times_to_invest = date_counts[d]
                        dca_cash -= inv_per_period * times_to_invest
                        dca_shares += (inv_per_period * times_to_invest) / p
                    dca_portfolio_value.append(dca_cash + (dca_shares * p))
                    
                dca_portfolio_value = pd.Series(dca_portfolio_value, index=prices.index)
                dca_ret = (dca_portfolio_value.iloc[-1] / total_investment - 1) * 100
                dca_cagr = ((dca_portfolio_value.iloc[-1] / total_investment) ** (1 / years) - 1) * 100 if dca_portfolio_value.iloc[-1] > 0 else 0
                
                c = colors[i % len(colors)]
                fig.add_trace(go.Scatter(x=ls_portfolio_value.index, y=ls_portfolio_value, mode='lines', 
                                         name=f'{ticker} 單筆投入', line=dict(color=c, width=2), hovertemplate='%{y:$,.0f}'))
                fig.add_trace(go.Scatter(x=dca_portfolio_value.index, y=dca_portfolio_value, mode='lines', 
                                         name=f'{ticker} 定期定額', line=dict(color=c, width=2, dash='dash'), hovertemplate='%{y:$,.0f}'))
                has_plotted = True
                
                ls_yearly = ls_portfolio_value.groupby(ls_portfolio_value.index.year).last()
                ls_ann_ret = ls_yearly.pct_change() * 100
                if len(ls_ann_ret) > 0: ls_ann_ret.iloc[0] = (ls_yearly.iloc[0] / total_investment - 1) * 100
                
                dca_yearly = dca_portfolio_value.groupby(dca_portfolio_value.index.year).last()
                dca_ann_ret = dca_yearly.pct_change() * 100
                if len(dca_ann_ret) > 0: dca_ann_ret.iloc[0] = (dca_yearly.iloc[0] / total_investment - 1) * 100
                
                for y in ls_ann_ret.index:
                    annual_data_rows.append({
                        '年度': str(y), '股票代號': ticker, '單筆投入 (%)': ls_ann_ret.loc[y], '定期定額 (%)': dca_ann_ret.loc[y]
                    })
                    
                total_summary.append({
                    '股票代號': ticker, 'Lump Sum 總報酬': ls_ret, 'DCA 總報酬': dca_ret,
                    'Lump Sum 年化': ls_cagr, 'DCA 年化': dca_cagr
                })
                
            if has_plotted:
                fig.add_hline(y=total_investment, line_dash="dot", line_color="gray", annotation_text="Initial Capital ($)")
                fig.update_layout(hovermode="x unified", height=550, margin=dict(l=0, r=0, t=30, b=0),
                                  legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                st.plotly_chart(fig, use_container_width=True)
                st.divider()
                
                col1, col2 = st.columns([1, 1])
                with col1:
                    st.subheader("🎯 績效總結")
                    df_summary = pd.DataFrame(total_summary)
                    styled_summary = apply_style(df_summary.style.format("{:+.2f}%", subset=['Lump Sum 總報酬', 'DCA 總報酬', 'Lump Sum 年化', 'DCA 年化']))
                    st.dataframe(styled_summary, use_container_width=True, hide_index=True)
                                 
                with col2:
                    st.subheader("📅 歷年報酬率明細")
                    df_annual = pd.DataFrame(annual_data_rows)
                    styled_annual = apply_style(df_annual.style.format("{:+.2f}%", subset=['單筆投入 (%)', '定期定額 (%)']))
                    st.dataframe(styled_annual, use_container_width=True, hide_index=True)
            else:
                st.error("未能產生圖表，請檢查股票代碼是否正確。")

# ==========================================
# 模組 2：資產配置
# ==========================================
def render_asset_allocation():
    st.subheader("💼 資產配置")
    st.markdown("自由配置股票與債券比例，設定動態再平衡與提領計畫，進行全面的壓力測試！")
    
    with st.expander("ℹ️ 關於資產配置與提領機制", expanded=False):
        st.markdown("""
        **💡 運作原理：**
        1. **自由配比**：支援多檔股票、債券 ETF (例如 60% SPY + 40% BND)。系統會將總資金依比例初始投入。
        2. **再平衡 (Rebalancing)**：當市場波動造成資產比例偏離時，系統會在設定的時間（如每年底）自動「賣高買低」，讓投資組合回到你設定的目標比例。
        3. **提領機制 (Withdrawal)**：模擬退休金提領情境。到達提領日（如每年底）時，系統會等比例賣出資產變現。如果遇到崩盤導致本金不足提領，就會面臨**「破產」**。
        4. **報表呈現**：下方的表格精準重現了經典理財書籍中的「資產壓力測試表」，你可以清楚看到提領與餘額變化的全貌。
        """)
        
    st.sidebar.header("⚙️ 設定參數")
    initial_capital = st.sidebar.number_input("期初資金 ($)", min_value=1000.0, value=1000000.0, step=10000.0)
    
    selected_event = st.sidebar.selectbox("歷史重大事件快速選擇", list(HISTORICAL_EVENTS.keys()), key="aa_event")
    default_start_date = HISTORICAL_EVENTS[selected_event] if HISTORICAL_EVENTS[selected_event] else date(2000, 1, 1)
    
    start_date = st.sidebar.date_input("開始日期", default_start_date, key="aa_start")
    end_date = st.sidebar.date_input("結束日期", date.today(), key="aa_end")
    
    st.sidebar.markdown("---")
    st.sidebar.subheader("📊 資產配置")
    
    default_assets = pd.DataFrame({
        "標的代號": ["SPY", "BND"],
        "配置比例(%)": [60.0, 40.0]
    })
    
    # 比例選單選項 (0% ~ 100%，以 5% 為級距)
    proportion_options = [float(x) for x in range(0, 105, 5)]
    
    edited_assets = st.sidebar.data_editor(
        default_assets, 
        num_rows="dynamic", 
        hide_index=True,
        column_config={
            "配置比例(%)": st.column_config.SelectboxColumn(
                "配置比例(%)",
                help="下拉選擇此標的的佔比",
                options=proportion_options,
                required=True
            )
        }
    )
    
    total_weight = edited_assets["配置比例(%)"].sum()
    if abs(total_weight - 100.0) > 0.01:
        st.sidebar.error(f"目前總比例為 {total_weight:.1f}%，請調整至剛好 100% 才能進行回測！")
        return
        
    st.sidebar.markdown("---")
    st.sidebar.subheader("🔄 再平衡設定")
    rebalance_freq = st.sidebar.selectbox("再平衡頻率", ["不進行", "每年 (年底)", "每季", "每月"], index=1)
    
    st.sidebar.markdown("---")
    st.sidebar.subheader("💸 提領設定")
    enable_withdrawal = st.sidebar.checkbox("啟用提領機制", value=False)
    if enable_withdrawal:
        withdrawal_amount = st.sidebar.number_input("每次提款金額 ($)", min_value=0.0, value=12000.0, step=1000.0)
        withdrawal_freq = st.sidebar.selectbox("提領頻率", ["每年", "每月"])
    else:
        withdrawal_amount = 0.0
        withdrawal_freq = "每年"
        
    if st.sidebar.button("🚀 執行資產配置回測", use_container_width=True, type="primary"):
        df_history, df_summary, metrics = run_asset_allocation_backtest(
            initial_capital, edited_assets, 
            start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d'),
            rebalance_freq, enable_withdrawal, withdrawal_amount, withdrawal_freq
        )
        
        if df_history is not None and not df_history.empty:
            # 繪製圖表
            fig = go.Figure()
            fig.add_trace(go.Scatter(x=df_history.index, y=df_history['Total_Value'], mode='lines', 
                                     name='投資組合總價值', line=dict(color='#1f77b4', width=2),
                                     hovertemplate='日期: %{x}<br>總值: %{y:$,.0f}'))
            
            fig.add_hline(y=initial_capital, line_dash="dot", line_color="gray", annotation_text="Initial Capital ($)")
            
            if metrics["bankrupt"]:
                # 在破產的日期畫一條垂直紅線
                bankrupt_date = df_history[df_history['Total_Value'] == 0].index[0]
                fig.add_vline(x=bankrupt_date, line_dash="dash", line_color="red", annotation_text="💥 破產點")
            
            fig.update_layout(hovermode="x unified", height=450, margin=dict(l=0, r=0, t=30, b=0),
                              legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig, use_container_width=True)
            
            # 顯示主要數據面板
            col1, col2, col3, col4 = st.columns(4)
            col1.metric("初始資金", f"${initial_capital:,.0f}")
            col2.metric("期末最終餘額", f"${metrics['final_value']:,.0f}" if not metrics["bankrupt"] else "破產歸零")
            col3.metric("總提款合計", f"${metrics['total_withdrawn']:,.0f}")
            col4.metric("年化報酬率 (CAGR)", f"{metrics['cagr']:+.2f}%" if not metrics["bankrupt"] else "N/A")
            
            if metrics["bankrupt"]:
                st.error("⚠️ 警告：在此提領設定下，資金已經枯竭（破產）！")
                
            st.divider()
            
            # 顯示表格
            st.subheader("📊 年度投資壓力測試表")
            
            # 調整欄位格式
            format_dict = {'當年提款合計': '${:,.0f}', '年底總金額 (提領前)': '${:,.0f}', '最終餘額': '${:,.0f}'}
            for t in edited_assets['標的代號']:
                format_dict[f'{t} 標的報酬(%)'] = '{:+.2f}%'
                format_dict[f'{t} 帳戶金額'] = '${:,.0f}'
                
            styled_summary = apply_style(df_summary.style.format(format_dict))
            st.dataframe(styled_summary, use_container_width=True, hide_index=True)


# --- 路由控制 ---
show_footer = True
if app_mode == "📈 All-in v.s DCA":
    render_lump_sum_vs_dca()
elif app_mode == "💼 資產配置":
    render_asset_allocation()
elif app_mode == "⚡ 波動回測":
    render_volatility_backtest()
else:
    render_tradingview_dashboard()
    show_footer = False

if show_footer:
    st.markdown("---")
    st.caption("🚀 部署提示：這是一個 Streamlit App，你可以搭配資料夾內的 `Dockerfile` 直接部署至 GCP Cloud Run。")


import streamlit as st
import pandas as pd
from volatility_core import analyze_volatility

def color_returns(val):
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

def render_volatility_backtest():
    st.subheader("⚡ 歷史日 K 線波動回測")
    st.markdown("統計特定股票在歷史期間內，單日漲跌幅達到預設閾值的次數，並計算歷史最長的連續上漲與連續下跌波段表現。")
    
    with st.expander("ℹ️ 關於波動回測與連續波段", expanded=False):
        st.markdown("""
        **💡 計算邏輯與專有名詞說明：**
        1. **單日波動統計**：統計上市以來，單日漲跌幅達到設定閾值的總天數。觀察重點：次數越多代表「股性」越活潑（或暴躁），適合短線或動能交易者；次數極少則代表股性溫吞。
        2. **連續波段計算**：找出歷史上「最長連續上漲/下跌」的天數與累積幅度。觀察重點：可藉此評估該股票在極端情緒下的慣性，例如崩盤時通常會連殺幾天才見底。
        3. **最大回撤 (MDD)**：從歷史高點跌至最低點的最大跌幅百分比。觀察重點：這是衡量「抱股最痛程度」的核心指標，負值越大代表抗跌能力越弱。
        4. **年化波動率 (Annualized Volatility)**：衡量每日報酬率跳動幅度的標準差，並年化處理。觀察重點：數值越高代表價格震盪越劇烈，潛在風險與報酬皆較高。
        5. **索提諾比率 (Sortino Ratio)**：類似夏普值，但**只懲罰下檔風險（下跌波動）**。觀察重點：數值越高，代表該股票在承受相同「下跌風險」下，能換取更多的超額報酬，是絕佳的抗震指標！
        """)
        
    st.sidebar.header("⚙️ 設定參數")
    tickers_input = st.sidebar.text_input("股票代號 (支援多個，以空格分隔)", "NVDA TSLA 2330.TW")
    
    st.sidebar.markdown("---")
    st.sidebar.subheader("🎯 波動閾值設定 (%)")
    st.sidebar.caption("設定 4 個您想關注的單日漲跌幅百分比")
    
    col_t1, col_t2 = st.sidebar.columns(2)
    with col_t1:
        t1 = st.number_input("閾值 1", value=3.0, step=1.0)
        t3 = st.number_input("閾值 3", value=10.0, step=1.0)
    with col_t2:
        t2 = st.number_input("閾值 2", value=5.0, step=1.0)
        t4 = st.number_input("閾值 4", value=15.0, step=1.0)
        
    thresholds = sorted([t1, t2, t3, t4])
    
    if st.sidebar.button("🚀 執行波動回測", use_container_width=True, type="primary"):
        tickers = [t.strip() for t in tickers_input.replace(',', ' ').split() if t.strip()]
        if not tickers:
            st.error("請填寫至少一個股票代號！")
            st.stop()
            
        with st.spinner("正在下載歷史資料並計算波動性，請稍候..."):
            results = []
            for ticker in tickers:
                res = analyze_volatility(ticker, thresholds)
                if "error" in res:
                    st.warning(res["error"])
                else:
                    results.append(res)
                    
            if results:
                # 提取並移除 _drawdown 避免顯示在表格中
                drawdowns = {res["股票代號"]: res.pop("_drawdown", None) for res in results}
                
                df_results = pd.DataFrame(results)
                
                # 顯示表格
                st.subheader("📊 波動回測與波段統計結果")
                
                # 格式化數值欄位
                format_dict = {}
                format_dict["連漲累積漲幅 (%)"] = '{:+.2f}%'
                format_dict["連跌累積跌幅 (%)"] = '{:+.2f}%'
                format_dict["最大回撤(%)"] = '{:.2f}%'
                format_dict["年化波動率(%)"] = '{:.2f}%'
                format_dict["索提諾比率"] = '{:.2f}'
                
                styled_results = apply_style(df_results.style.format(format_dict))
                
                # 新增：為漲跌幅次數欄位加上明確的背景顏色區隔
                up_cols = [c for c in df_results.columns if "漲幅" in c and "(次)" in c]
                down_cols = [c for c in df_results.columns if "跌幅" in c and "(次)" in c]
                
                def bg_up(s):
                    return ['background-color: rgba(9, 171, 59, 0.15); color: #09ab3b;'] * len(s)
                def bg_down(s):
                    return ['background-color: rgba(255, 75, 75, 0.15); color: #ff4b4b;'] * len(s)
                def text_red(s):
                    return ['color: #ff4b4b; font-weight: bold;'] * len(s)
                    
                if up_cols:
                    styled_results = styled_results.apply(bg_up, subset=up_cols, axis=0)
                if down_cols:
                    styled_results = styled_results.apply(bg_down, subset=down_cols, axis=0)
                    
                red_cols = [c for c in df_results.columns if c in ["歷史最長連跌 (天)", "最大回撤(%)"]]
                if red_cols:
                    styled_results = styled_results.apply(text_red, subset=red_cols, axis=0)
                
                st.dataframe(styled_results, use_container_width=True, hide_index=True)
                
                # 將結果視覺化：取出閾值次數做成長條圖
                st.divider()
                st.subheader("📈 波動頻率比較 (達標次數)")
                
                # 準備畫圖資料
                plot_data = []
                for _, row in df_results.iterrows():
                    ticker = row["股票代號"]
                    for t in thresholds:
                        plot_data.append({"股票": ticker, "事件": f"漲 >= {t}%", "次數": row[f"漲幅 >= {t} (%)" if f"漲幅 >= {t} (%)" in row else f"漲幅 >= {t}% (次)"], "方向": "上漲"})
                        plot_data.append({"股票": ticker, "事件": f"跌 >= {t}%", "次數": row[f"跌幅 >= {t} (%)" if f"跌幅 >= {t} (%)" in row else f"跌幅 >= {t}% (次)"], "方向": "下跌"})
                
                df_plot = pd.DataFrame(plot_data)
                
                # 利用 plotly 畫出直方圖
                import plotly.express as px
                fig = px.bar(df_plot, x="事件", y="次數", color="股票", barmode="group",
                             color_discrete_sequence=px.colors.qualitative.Set2)
                fig.update_layout(height=400, margin=dict(l=0, r=0, t=30, b=0))
                st.plotly_chart(fig, use_container_width=True)
                
                # 繪製水下權益曲線圖 (Underwater Chart)
                st.divider()
                st.subheader("🌊 水下權益曲線圖 (Underwater Chart)")
                import plotly.graph_objects as go
                fig_dd = go.Figure()
                
                for ticker, dd_series in drawdowns.items():
                    if dd_series is not None:
                        dd_percent = dd_series * 100
                        fig_dd.add_trace(go.Scatter(
                            x=dd_percent.index, 
                            y=dd_percent, 
                            mode='lines', 
                            name=ticker,
                            fill='tozeroy',
                            hovertemplate='%{x}<br>回撤: %{y:.2f}%'
                        ))
                
                fig_dd.update_layout(
                    height=400, 
                    margin=dict(l=0, r=0, t=30, b=0),
                    yaxis_title='回撤幅度 (%)',
                    hovermode="x unified"
                )
                st.plotly_chart(fig_dd, use_container_width=True)
            else:
                st.error("未能成功分析任何股票，請檢查代碼是否正確。")

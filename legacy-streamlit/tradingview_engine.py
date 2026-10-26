import streamlit as st
import streamlit.components.v1 as components
import os
import json
import traceback

try:
    from google.cloud import storage
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False

# 設定檔儲存路徑
CONFIG_FILE = os.path.join(os.path.dirname(__file__), "tradingview_groups.json")

# 預設群組
DEFAULT_GROUPS = {
    "前20大市值美股": ["NASDAQ:AAPL", "NASDAQ:MSFT", "NASDAQ:NVDA", "NASDAQ:GOOGL", "NASDAQ:AMZN", "NASDAQ:META", "NYSE:TSM", "NYSE:BRK.B", "NYSE:LLY", "NASDAQ:AVGO", "NYSE:V", "NYSE:JPM", "NYSE:XOM", "NYSE:MA", "NYSE:UNH", "NYSE:PG", "NYSE:JNJ", "NYSE:HD", "NASDAQ:TSLA"],
    "美股熱門科技": ["NASDAQ:NVDA", "NASDAQ:AAPL", "NASDAQ:MSFT", "NASDAQ:GOOGL", "NASDAQ:AMZN", "NASDAQ:META", "NASDAQ:TSLA", "NASDAQ:AMD", "NASDAQ:AVGO", "NYSE:TSM", "NASDAQ:NFLX"],
    "台股精選": ["TWSE:2330", "TWSE:2454", "TWSE:2317", "TWSE:2308", "TWSE:2881", "TWSE:2882", "TWSE:2891", "TWSE:2603", "TWSE:2886", "TWSE:2412"],
    "加密貨幣": ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT", "BINANCE:BNBUSDT", "BINANCE:XRPUSDT", "BINANCE:DOGEUSDT"]
}

def load_groups():
    storage_mode = os.environ.get("STORAGE_MODE", "local").lower()
    gcs_bucket_name = os.environ.get("GCS_BUCKET_NAME", "")
    gcs_blob_name = os.environ.get("GCS_BLOB_NAME", "tradingview_groups.json")

    if storage_mode == "gcs" and gcs_bucket_name and GCS_AVAILABLE:
        try:
            client = storage.Client()
            bucket = client.bucket(gcs_bucket_name)
            blob = bucket.blob(gcs_blob_name)
            if blob.exists():
                data = blob.download_as_text(encoding="utf-8")
                return json.loads(data)
            else:
                # 第一次執行：若 Bucket 中沒有檔案，主動將本地備援或預設值寫入 Bucket 完成初始化
                groups_to_save = DEFAULT_GROUPS.copy()
                if os.path.exists(CONFIG_FILE):
                    try:
                        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                            groups_to_save = json.load(f)
                    except: pass
                
                blob.upload_from_string(
                    json.dumps(groups_to_save, ensure_ascii=False, indent=4), 
                    content_type="application/json"
                )
                return groups_to_save
        except Exception as e:
            print(f"GCS load failed: {e}")
            pass # Fallback to local if GCS fails or doesn't exist yet

    # 本地備援模式 (Local Fallback)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
            
    return DEFAULT_GROUPS.copy()

def save_groups(groups):
    storage_mode = os.environ.get("STORAGE_MODE", "local").lower()
    gcs_bucket_name = os.environ.get("GCS_BUCKET_NAME", "")
    gcs_blob_name = os.environ.get("GCS_BLOB_NAME", "tradingview_groups.json")

    # 嘗試寫入 GCS
    if storage_mode == "gcs" and gcs_bucket_name and GCS_AVAILABLE:
        try:
            client = storage.Client()
            bucket = client.bucket(gcs_bucket_name)
            blob = bucket.blob(gcs_blob_name)
            blob.upload_from_string(
                json.dumps(groups, ensure_ascii=False, indent=4), 
                content_type="application/json"
            )
            return # 成功寫入 GCS 後返回
        except Exception as e:
            st.sidebar.warning(f"寫入雲端儲存失敗，降級至本地端: {str(e)}")

    # 本地備援模式寫入 (Local Fallback)
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(groups, f, ensure_ascii=False, indent=4)
    except Exception as e:
        st.sidebar.error(f"儲存設定檔失敗: {str(e)}")

def render_tradingview_dashboard():
    # 注入滿版全螢幕 CSS
    st.markdown("""
        <style>
            .block-container {
                padding-top: 3.5rem !important;
                padding-bottom: 0 !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
                max-width: 100% !important;
            }
            div[data-testid="stHtml"] {
                height: calc(100vh - 4.5rem) !important;
            }
            iframe {
                height: calc(100vh - 4.5rem) !important;
            }
        </style>
    """, unsafe_allow_html=True)
    
    st.sidebar.header("📊 看盤軟體設定")
    
    groups = load_groups()
    
    # 選擇目前要觀看的群組
    group_names = list(groups.keys())
    if not group_names:
        groups = DEFAULT_GROUPS.copy()
        group_names = list(groups.keys())
        save_groups(groups)
        
    selected_group_name = st.sidebar.selectbox("標的群組", group_names)
    current_symbols = groups[selected_group_name]
    
    # 其他設定
    col_g1, col_g2 = st.sidebar.columns(2)
    with col_g1:
        grid_size_str = st.selectbox("網格佈局", ["2x2 (4格)", "3x3 (9格)", "4x4 (16格)"], index=2)
        grid_size = int(grid_size_str[0])
    with col_g2:
        interval_choice = st.selectbox("時間週期", ["日K (D)", "週K (W)", "月K (M)"], index=1)
        timeframe_map = {"日K (D)": "D", "週K (W)": "W", "月K (M)": "M"}
        timeframe = timeframe_map[interval_choice]
        
    interval_time_str = st.sidebar.selectbox(
        "自動輪播時間", 
        ["暫停輪播", "10 秒", "15 秒", "20 秒", "25 秒", "30 秒", "35 秒", "40 秒", "1 分鐘", "1.5 分鐘", "2 分鐘", "3 分鐘", "5 分鐘"], 
        index=5
    )
    interval_time_map = {
        "暫停輪播": 0, "10 秒": 10000, "15 秒": 15000, "20 秒": 20000, "25 秒": 25000, "30 秒": 30000, 
        "35 秒": 35000, "40 秒": 40000, "1 分鐘": 60000, "1.5 分鐘": 90000, "2 分鐘": 120000, 
        "3 分鐘": 180000, "5 分鐘": 300000
    }
    interval_time = interval_time_map[interval_time_str]
    
    st.sidebar.markdown("---")
    
    # 群組管理
    with st.sidebar.expander("🛠️ 管理群組與標的"):
        st.caption("每行輸入一個標的代號 (例如: NASDAQ:NVDA)")
        
        # 編輯現有群組
        edit_group_name = st.selectbox("選擇要編輯的群組", group_names, key="edit_group")
        current_symbols_text = "\n".join(groups[edit_group_name])
        new_symbols_text = st.text_area(f"編輯「{edit_group_name}」內容", value=current_symbols_text, height=150)
        
        if st.button("💾 儲存標的清單"):
            symbols_list = [s.strip() for s in new_symbols_text.split("\n") if s.strip()]
            groups[edit_group_name] = symbols_list
            save_groups(groups)
            st.success("儲存成功！")
            st.rerun()
            
        st.divider()
        
        # 新增群組
        new_group_name = st.text_input("新增群組名稱")
        if st.button("➕ 新增群組"):
            if new_group_name and new_group_name not in groups:
                groups[new_group_name] = ["NASDAQ:AAPL"]
                save_groups(groups)
                st.success(f"已新增群組：{new_group_name}")
                st.rerun()
                
        # 刪除群組
        if st.button("🗑️ 刪除目前群組", type="primary"):
            if len(groups) > 1:
                del groups[edit_group_name]
                save_groups(groups)
                st.success("刪除成功！")
                st.rerun()
            else:
                st.error("請至少保留一個群組！")
    
    # 準備注入給 HTML 的 JSON 設定
    config_data = {
        "symbols": current_symbols,
        "gridSize": grid_size,
        "intervalTime": interval_time,
        "timeframe": timeframe
    }
    
    # 讀取本地的 HTML 模板檔案
    html_file_path = os.path.join(os.path.dirname(__file__), "tradingview_dashboard_template.html")
    try:
        with open(html_file_path, "r", encoding="utf-8") as f:
            html_data = f.read()
            
        # 注入設定
        html_data = html_data.replace("{{CONFIG}}", json.dumps(config_data))
            
        # 使用 components.html 渲染 HTML，設定固定高度為 1200 像素以容納整個畫面
        components.html(html_data, height=1200, scrolling=False)
        
    except FileNotFoundError:
        st.error(f"找不到檔案：{html_file_path}，請確保該檔案存在於專案目錄中。")

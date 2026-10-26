// ============================================================
// engine.js — 所有回測計算（純函式，不碰畫面）
// 瀏覽器與 Node.js（單元測試）都能直接 import。
//
// 資料格式（series）：
//   { symbol, dates: ["YYYY-MM-DD", ...], close: [number, ...] }
//   close 是「還原權息後收盤價」(Adjusted Close)，已把股息再投入算進去。
// ============================================================

const DAY_MS = 86400000;

// ---------- 日期工具 ----------

/** "YYYY-MM-DD" -> 自 1970-01-01 起的天數（UTC，整數） */
export function toDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 天數 -> "YYYY-MM-DD" */
export function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function daysInMonth(y, m) {
  // m: 1-12
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 日期加 k 個月；月底自動夾住（1/31 + 1 個月 = 2/28 或 2/29） */
export function addMonths(iso, k) {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** 第一個 >= target 的索引（二分搜尋） */
export function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 第一個 > target 的索引 */
export function upperBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 把 series 切到 [start, end]（含頭含尾），並附上天數陣列 */
export function sliceSeries(series, start, end) {
  const days = series.days || series.dates.map(toDay);
  series.days = days; // 快取，避免重算
  const i0 = start ? lowerBound(days, toDay(start)) : 0;
  const i1 = (end ? upperBound(days, toDay(end)) : days.length) - 1;
  if (i1 < i0) return { dates: [], close: [], days: [] };
  return {
    symbol: series.symbol,
    dates: series.dates.slice(i0, i1 + 1),
    close: series.close.slice(i0, i1 + 1),
    days: days.slice(i0, i1 + 1),
  };
}

// ---------- 績效指標 ----------

/** 期間年數（以日曆天計算） */
export function yearsBetween(day0, day1) {
  return Math.max((day1 - day0) / 365.25, 1 / 365.25);
}

/** 年化報酬率 CAGR = (期末 / 期初)^(1/年數) - 1 */
export function cagr(startValue, endValue, years) {
  if (startValue <= 0 || endValue <= 0) return -1;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

/** 最大回撤：從歷史最高點往下跌最深的幅度（回傳負數，例如 -0.34） */
export function maxDrawdown(values, dates) {
  let peak = -Infinity, peakIdx = 0, mdd = 0, from = 0, to = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) { peak = values[i]; peakIdx = i; }
    const dd = peak > 0 ? values[i] / peak - 1 : 0;
    if (dd < mdd) { mdd = dd; from = peakIdx; to = i; }
  }
  return {
    mdd,
    peakDate: dates ? dates[from] : from,
    troughDate: dates ? dates[to] : to,
  };
}

/** 回撤序列（每天距離歷史高點跌了多少） */
export function drawdownSeries(values) {
  let peak = -Infinity;
  return values.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? v / peak - 1 : 0;
  });
}

/** 依年份取每年最後一天的值，計算逐年報酬 */
export function annualReturns(dates, values, startValue) {
  const rows = [];
  let prev = startValue;
  for (let i = 0; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    const isLast = i === dates.length - 1 || dates[i + 1].slice(0, 4) !== y;
    if (isLast) {
      rows.push({ year: y, endValue: values[i], ret: values[i] / prev - 1 });
      prev = values[i];
    }
  }
  return rows;
}

// ---------- 模組 1：單筆投入 vs 定期定額 ----------

/**
 * 產生 DCA 的「目標扣款日」。
 * 第 k 筆（k = 0..n-1）落在 start + k × (months / n) 個月。
 * 例：12 個月分 12 次 → 第 0,1,...,11 個月各買一次（間隔剛好 1 個月）。
 *
 * ※ 原版用 pd.date_range(start, start+12個月, periods=12)，
 *   會把最後一筆放在第 12 個月，間隔變成 12/11 ≈ 1.09 個月，
 *   實際花了 12 個月才買完、而且每筆都比設定晚一點。這裡已修正。
 */
export function dcaSchedule(startIso, months, count) {
  const out = [];
  if (months % count === 0) {
    const step = months / count;
    for (let k = 0; k < count; k++) out.push(addMonths(startIso, k * step));
  } else {
    // 不能整除時，用日曆天平均分配
    const d0 = toDay(startIso);
    const total = toDay(addMonths(startIso, months)) - d0;
    for (let k = 0; k < count; k++) out.push(fromDay(d0 + Math.round((k * total) / count)));
  }
  return out;
}

/** 現金在 days 天內的成長倍數（年利率 y，日複利換算） */
function cashGrowth(yieldRate, days) {
  return yieldRate ? Math.pow(1 + yieldRate, days / 365) : 1;
}

/** 把目標扣款日對應到「當天或之後第一個交易日」的索引；超出資料範圍的回傳 -1 */
function mapScheduleToIndex(schedule, days, fromIdx = 0, toIdx = days.length - 1) {
  return schedule.map((iso) => {
    const idx = lowerBound(days, toDay(iso));
    return idx >= fromIdx && idx <= toIdx ? idx : -1;
  });
}

/**
 * 單筆投入 vs 定期定額 回測
 * @param series  還原收盤價序列
 * @param opts    { amount, start, end, dcaMonths, dcaCount, cashYield }
 *   cashYield：尚未投入的現金年利率（例如 0.015 = 1.5%），預設 0
 */
export function lumpSumVsDca(series, opts) {
  const { amount, start, end, dcaMonths, dcaCount } = opts;
  const cashYield = opts.cashYield || 0;
  const s = sliceSeries(series, start, end);
  const n = s.close.length;
  if (n < 2) return { error: "所選期間內的交易日少於 2 天，無法回測。" };

  const { dates, close: px, days } = s;

  // --- 單筆投入：第一天全部買進，之後抱著不動 ---
  const lsShares = amount / px[0];
  const lsValue = px.map((p) => lsShares * p);

  // --- 定期定額：依扣款日分批買，沒投入的錢留在現金 ---
  const schedule = dcaSchedule(dates[0], dcaMonths, dcaCount);
  const idxs = mapScheduleToIndex(schedule, days);
  const buyCountAt = new Map();
  let skipped = 0;
  idxs.forEach((idx) => {
    if (idx < 0) skipped++;
    else buyCountAt.set(idx, (buyCountAt.get(idx) || 0) + 1);
  });

  const per = amount / dcaCount;
  let cash = amount, shares = 0, invested = 0;
  const dcaValue = new Array(n), dcaInvested = new Array(n), buys = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) cash *= cashGrowth(cashYield, days[i] - days[i - 1]);
    const k = buyCountAt.get(i);
    if (k) {
      const spend = per * k;
      cash -= spend;
      shares += spend / px[i];
      invested += spend;
      buys.push({ date: dates[i], price: px[i], amount: spend, shares: spend / px[i], times: k });
    }
    dcaValue[i] = cash + shares * px[i];
    dcaInvested[i] = invested;
  }

  const years = yearsBetween(days[0], days[n - 1]);
  const summarize = (values) => {
    const final = values[n - 1];
    const dd = maxDrawdown(values, dates);
    return {
      final,
      totalReturn: final / amount - 1,
      cagr: cagr(amount, final, years),
      mdd: dd.mdd,
      mddPeak: dd.peakDate,
      mddTrough: dd.troughDate,
    };
  };

  // DCA 平均成本 vs 扣款日平均價格（教學用：平均成本是「調和平均」，一定 ≤ 算術平均）
  const avgCost = shares > 0 ? invested / shares : null;
  const avgPrice = buys.length
    ? buys.reduce((a, b) => a + b.price * b.times, 0) / buys.reduce((a, b) => a + b.times, 0)
    : null;

  // 平均有多少比例的資金在市場內（時間加權）
  let inMarket = 0;
  for (let i = 1; i < n; i++) inMarket += (dcaInvested[i - 1] / amount) * (days[i] - days[i - 1]);
  const avgExposure = inMarket / Math.max(days[n - 1] - days[0], 1);

  const lsAnnual = annualReturns(dates, lsValue, amount);
  const dcaAnnual = annualReturns(dates, dcaValue, amount);

  return {
    symbol: series.symbol,
    dates,
    price: px,
    lsValue,
    dcaValue,
    dcaInvested,
    buys,
    schedule,
    skipped,
    actualStart: dates[0],
    actualEnd: dates[n - 1],
    years,
    ls: summarize(lsValue),
    dca: { ...summarize(dcaValue), avgCost, avgPrice, avgExposure, finalCash: cash },
    annual: lsAnnual.map((r, i) => ({ year: r.year, ls: r.ret, dca: dcaAnnual[i].ret })),
  };
}

/**
 * 只算「期末價值」的快速版 DCA（給滾動勝率分析用，一次要算上百個起點）。
 * 結果與 lumpSumVsDca 逐日模擬完全相同（現金複利可以分段相乘）。
 */
function dcaEndValueFast(days, px, startIdx, endIdx, amount, dcaMonths, dcaCount, cashYield, startIso) {
  const schedule = dcaSchedule(startIso, dcaMonths, dcaCount);
  const idxs = mapScheduleToIndex(schedule, days, startIdx, endIdx);
  const per = amount / dcaCount;
  let cash = amount, shares = 0, lastDay = days[startIdx];
  // idxs 已按時間排序
  for (const idx of idxs) {
    if (idx < 0) continue;
    cash *= cashGrowth(cashYield, days[idx] - lastDay);
    lastDay = days[idx];
    cash -= per;
    shares += per / px[idx];
  }
  cash *= cashGrowth(cashYield, days[endIdx] - lastDay);
  return cash + shares * px[endIdx];
}

/**
 * 滾動起點勝率分析：
 * 「如果我在過去每一個月的月初拿到這筆錢，持有 horizonMonths 個月後，
 *   單筆投入和定期定額誰的期末資產比較多？」
 * 用來回答「單筆投入贏的機率有多高」，避免只看一個起點就下結論。
 */
export function rollingComparison(series, opts) {
  const { amount, horizonMonths, dcaMonths, dcaCount } = opts;
  const cashYield = opts.cashYield || 0;
  const s = sliceSeries(series, opts.from, opts.to || null);
  const full = series; // 期末可以超出 to（to 只限制起點）
  const days = full.days || full.dates.map(toDay);
  full.days = days;
  const px = full.close;
  const lastDay = days[days.length - 1];

  const rows = [];
  let prevMonth = "";
  for (let j = 0; j < s.dates.length; j++) {
    const ym = s.dates[j].slice(0, 7);
    if (ym === prevMonth) continue; // 只取每個月第一個交易日
    prevMonth = ym;
    const startIso = s.dates[j];
    const targetEnd = toDay(addMonths(startIso, horizonMonths));
    if (targetEnd > lastDay) break;
    const startIdx = lowerBound(days, toDay(startIso));
    const endIdx = upperBound(days, targetEnd) - 1;
    if (endIdx <= startIdx) continue;
    const ls = (amount * px[endIdx]) / px[startIdx];
    const dca = dcaEndValueFast(days, px, startIdx, endIdx, amount, dcaMonths, dcaCount, cashYield, startIso);
    rows.push({ start: startIso, end: full.dates[endIdx], ls, dca, diff: ls / dca - 1 });
  }

  if (!rows.length) return { rows, error: "資料長度不足以涵蓋任何一個完整的持有期間，請縮短持有期間或換更長歷史的標的。" };

  const lsWins = rows.filter((r) => r.ls > r.dca).length;
  const diffs = rows.map((r) => r.diff).sort((a, b) => a - b);
  const q = (p) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.round(p * (diffs.length - 1))))];
  return {
    rows,
    count: rows.length,
    lsWinRate: lsWins / rows.length,
    medianDiff: q(0.5),
    p10Diff: q(0.1),
    p90Diff: q(0.9),
    best: rows.reduce((a, b) => (b.diff > a.diff ? b : a)),
    worst: rows.reduce((a, b) => (b.diff < a.diff ? b : a)),
  };
}

// ---------- 模組 2：資產配置（再平衡 + 提領） ----------

function periodKey(iso, freq) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  if (freq === "year") return y;
  if (freq === "quarter") return y * 4 + Math.floor((m - 1) / 3);
  if (freq === "month") return y * 12 + m;
  return null;
}

/** 多檔標的取「全部都有報價」的共同交易日（等同 pandas dropna(how='any')） */
export function alignSeries(seriesList, start, end) {
  const maps = seriesList.map((s) => {
    const m = new Map();
    s.dates.forEach((d, i) => m.set(d, s.close[i]));
    return m;
  });
  const base = sliceSeries(seriesList[0], start, end);
  const dates = [], prices = [];
  for (const d of base.dates) {
    const row = maps.map((m) => m.get(d));
    if (row.every((v) => v != null && v > 0)) { dates.push(d); prices.push(row); }
  }
  return { dates, prices };
}

/**
 * 資產配置回測
 * opts: { capital, start, end, weights:[0.6,0.4], rebalance:'none'|'year'|'quarter'|'month',
 *         withdraw:{ enabled, amount, freq:'year'|'month', inflation } }
 *
 * 執行順序（每個交易日）：
 *   1. 用今天收盤價計算資產價值
 *   2. 若進入新的再平衡週期 → 依目標比例重新分配
 *   3. 若進入新的提領週期 → 等比例賣出提領金額（不夠就「破產」）
 */
export function assetAllocation(seriesList, opts) {
  const { capital, start, end, weights, rebalance = "year" } = opts;
  const wd = opts.withdraw || { enabled: false };
  const { dates, prices } = alignSeries(seriesList, start, end);
  const n = dates.length;
  if (n < 2) {
    return { error: "找不到所有標的共同存在的交易日。通常是開始日期早於某檔 ETF 的上市日，請調整開始日期或更換標的。" };
  }
  const k = weights.length;
  let shares = weights.map((w, j) => (capital * w) / prices[0][j]);
  const total = (i) => shares.reduce((a, sh, j) => a + sh * prices[i][j], 0);

  const values = new Array(n);
  const twr = new Array(n); // 時間加權報酬指數（排除提領影響，衡量「投資組合本身」的表現）
  values[0] = capital; twr[0] = 1;
  let prevAfter = capital;
  let bankrupt = false, bankruptDate = null, totalWithdrawn = 0, yearWithdrawn = 0;
  const startYear = +dates[0].slice(0, 4);
  const annual = [];
  let yearStartPx = prices[0].slice(), yearStartTwr = 1;

  for (let i = 0; i < n; i++) {
    let v = total(i);
    if (i > 0) {
      twr[i] = bankrupt || prevAfter <= 0 ? twr[i - 1] : twr[i - 1] * (v / prevAfter);

      if (!bankrupt && rebalance !== "none" && periodKey(dates[i], rebalance) !== periodKey(dates[i - 1], rebalance)) {
        shares = weights.map((w, j) => (v * w) / prices[i][j]);
      }
      if (!bankrupt && wd.enabled && periodKey(dates[i], wd.freq) !== periodKey(dates[i - 1], wd.freq)) {
        const yearsIn = +dates[i].slice(0, 4) - startYear;
        const amt = wd.amount * Math.pow(1 + (wd.inflation || 0), yearsIn);
        if (v <= amt) {
          totalWithdrawn += v; yearWithdrawn += v;
          shares = shares.map(() => 0);
          v = 0; bankrupt = true; bankruptDate = dates[i];
        } else {
          const keep = 1 - amt / v;
          shares = shares.map((sh) => sh * keep);
          v -= amt; totalWithdrawn += amt; yearWithdrawn += amt;
        }
      }
    }
    values[i] = v;
    prevAfter = v;

    const isYearEnd = i === n - 1 || dates[i + 1].slice(0, 4) !== dates[i].slice(0, 4);
    if (isYearEnd) {
      const row = { year: dates[i].slice(0, 4), assets: [], endValue: v, withdrawn: yearWithdrawn, portfolioRet: twr[i] / yearStartTwr - 1 };
      for (let j = 0; j < k; j++) {
        // 標的報酬：上一年最後收盤 → 今年最後收盤（第一年從開始日起算）
        row.assets.push({ ret: prices[i][j] / yearStartPx[j] - 1, value: shares[j] * prices[i][j] });
      }
      annual.push(row);
      yearStartPx = prices[i].slice();
      yearStartTwr = twr[i];
      yearWithdrawn = 0;
    }
  }

  const days0 = toDay(dates[0]), days1 = toDay(dates[n - 1]);
  const years = yearsBetween(days0, days1);
  const dd = maxDrawdown(twr, dates);
  return {
    dates, values, twr, annual, years,
    actualStart: dates[0], actualEnd: dates[n - 1],
    final: values[n - 1],
    totalWithdrawn,
    bankrupt, bankruptDate,
    twrCagr: cagr(1, twr[n - 1], years),
    mdd: dd.mdd, mddPeak: dd.peakDate, mddTrough: dd.troughDate,
  };
}

// ---------- 模組 3：波動與風險統計 ----------

/**
 * 單一標的的波動統計
 * - 單日漲跌幅達到各閾值的天數
 * - 歷史最長連漲 / 連跌（平盤日會中斷連續）
 * - 最大回撤、年化波動率、索提諾比率、CAGR
 */
export function volatilityStats(series, thresholds, start, end) {
  const s = sliceSeries(series, start, end);
  const n = s.close.length;
  if (n < 3) return { error: `${series.symbol} 資料不足。` };
  const { dates, close: px, days } = s;

  const r = [];
  for (let i = 1; i < n; i++) r.push(px[i] / px[i - 1] - 1);

  const counts = thresholds.map((t) => ({
    t,
    up: r.filter((x) => x * 100 >= t).length,
    down: r.filter((x) => x * 100 <= -t).length,
  }));

  // 連續上漲 / 下跌
  const streak = (sign) => {
    let best = { days: 0, ret: 0, from: null, to: null };
    let len = 0, prod = 1, from = 0;
    for (let i = 0; i < r.length; i++) {
      if (Math.sign(r[i]) === sign) {
        if (len === 0) { from = i; prod = 1; }
        len++; prod *= 1 + r[i];
        if (len > best.days) best = { days: len, ret: prod - 1, from: dates[from], to: dates[i + 1] };
      } else len = 0;
    }
    return best;
  };

  const years = yearsBetween(days[0], days[n - 1]);
  const perYear = r.length / years; // 每年實際交易日數（股票約 252，加密貨幣約 365）
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  // 下檔標準差：只把「負報酬」算進去，正報酬視為 0（目標報酬 = 0）
  const dsd = Math.sqrt(r.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / r.length);
  const dd = maxDrawdown(px, dates);

  return {
    symbol: series.symbol,
    start: dates[0], end: dates[n - 1],
    days: r.length,
    counts,
    maxUp: streak(1),
    maxDown: streak(-1),
    mdd: dd.mdd, mddPeak: dd.peakDate, mddTrough: dd.troughDate,
    annVol: sd * Math.sqrt(perYear),
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(perYear) : null,
    cagr: cagr(px[0], px[n - 1], years),
    perYear,
    drawdown: { dates, values: drawdownSeries(px) },
  };
}

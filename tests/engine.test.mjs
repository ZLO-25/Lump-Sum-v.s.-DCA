// 執行：node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths, dcaSchedule, lumpSumVsDca, rollingComparison,
  assetAllocation, volatilityStats, maxDrawdown, toDay, fromDay,
} from "../assets/js/engine.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

/** 產生每個平日都有報價的序列 */
function makeSeries(startIso, n, priceFn, symbol = "TEST") {
  const dates = [], px = [];
  let d = toDay(startIso);
  while (dates.length < n) {
    const dow = new Date(d * 86400000).getUTCDay();
    if (dow !== 0 && dow !== 6) { dates.push(fromDay(d)); px.push(priceFn(dates.length - 1)); }
    d++;
  }
  return { symbol, dates, close: px };
}

test("addMonths 月底夾住", () => {
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2023-01-31", 1), "2023-02-28");
  assert.equal(addMonths("2023-11-15", 3), "2024-02-15");
});

test("DCA 12 個月分 12 次 → 每月同一天、最後一筆在第 11 個月", () => {
  const s = dcaSchedule("2020-01-02", 12, 12);
  assert.equal(s.length, 12);
  assert.equal(s[1], "2020-02-02");
  assert.equal(s[11], "2020-12-02");
});

test("價格不變時，單筆與定期定額結果相同", () => {
  const ser = makeSeries("2020-01-01", 600, () => 100);
  const r = lumpSumVsDca(ser, { amount: 1200, start: "2020-01-01", end: "2022-12-31", dcaMonths: 12, dcaCount: 12 });
  close(r.ls.final, 1200);
  close(r.dca.final, 1200);
  assert.equal(r.buys.length, 12);
  assert.equal(r.skipped, 0);
});

test("手算案例：價格 10 → 20 一次跳升", () => {
  // 前 30 個交易日價格 10，之後 20。單筆：100 股 × 20 = 2000。
  const ser = makeSeries("2021-01-04", 300, (i) => (i < 30 ? 10 : 20));
  const r = lumpSumVsDca(ser, { amount: 1000, start: "2021-01-04", end: "2022-12-31", dcaMonths: 4, dcaCount: 2 });
  close(r.ls.final, 2000);
  // DCA（4 個月分 2 次）：第 1 筆 500 在 10 元（50 股）；第 2 筆在 3/4（第 43 個交易日 > 30）以 20 元買 25 股 → 75 股 × 20 = 1500
  close(r.dca.final, 1500);
  close(r.dca.avgCost, 1000 / 75);
  close(r.dca.avgPrice, 15);
  assert.ok(r.dca.avgCost < r.dca.avgPrice, "平均成本（調和平均）應小於平均價格（算術平均）");
});

test("扣款日超出資料範圍時保留現金並回報 skipped", () => {
  const ser = makeSeries("2021-01-04", 40, () => 50);
  const r = lumpSumVsDca(ser, { amount: 1200, start: "2021-01-04", end: "2021-12-31", dcaMonths: 12, dcaCount: 12 });
  assert.equal(r.skipped, 10);
  close(r.dca.final, 1200);
  close(r.dca.finalCash, 1000);
});

test("現金利率：逐日模擬與快速版（滾動分析）結果一致", () => {
  const ser = makeSeries("2010-01-01", 3000, (i) => 100 * Math.exp(0.0003 * i + 0.05 * Math.sin(i / 17)));
  const opts = { amount: 100000, dcaMonths: 12, dcaCount: 12, cashYield: 0.03 };
  const roll = rollingComparison(ser, { ...opts, horizonMonths: 36, from: "2010-01-01" });
  assert.ok(roll.count > 50);
  for (const row of [roll.rows[0], roll.rows[17], roll.rows[roll.rows.length - 1]]) {
    const full = lumpSumVsDca(ser, { ...opts, start: row.start, end: row.end });
    close(full.ls.final, row.ls, 1e-9);
    close(full.dca.final, row.dca, 1e-9);
  }
});

test("持續上漲的市場：單筆投入勝率 100%", () => {
  const ser = makeSeries("2000-01-03", 4000, (i) => 100 * Math.pow(1.0004, i));
  const roll = rollingComparison(ser, { amount: 1, dcaMonths: 12, dcaCount: 12, horizonMonths: 60, from: "2000-01-01" });
  assert.equal(roll.lsWinRate, 1);
});

test("最大回撤", () => {
  const { mdd } = maxDrawdown([100, 120, 60, 90, 130, 65]);
  close(mdd, -0.5);
});

test("資產配置：單一資產、不提領 → 等於持有該資產", () => {
  const ser = makeSeries("2015-01-01", 1500, (i) => 50 + i * 0.1);
  const r = assetAllocation([ser], { capital: 1000, weights: [1], rebalance: "year", start: "2015-01-01", end: "2030-01-01" });
  close(r.final, (1000 * ser.close.at(-1)) / ser.close[0]);
  // 逐年標的報酬連乘 = 總報酬
  const prod = r.annual.reduce((a, row) => a * (1 + row.assets[0].ret), 1);
  close(prod, ser.close.at(-1) / ser.close[0]);
});

test("資產配置：再平衡讓比例回到目標", () => {
  const a = makeSeries("2015-01-01", 800, (i) => 100 * Math.pow(1.001, i), "A");
  const b = makeSeries("2015-01-01", 800, () => 100, "B");
  const r = assetAllocation([a, b], { capital: 1000, weights: [0.5, 0.5], rebalance: "year", start: "2015-01-01", end: "2030-01-01" });
  // 2016 第一個交易日再平衡後，兩邊價值應相等 → 檢查 2016 年底 B 的價值 = 再平衡當天總值的一半
  const i = r.dates.indexOf(r.dates.find((d) => d.startsWith("2016")));
  const row2016 = r.annual.find((x) => x.year === "2016");
  close(row2016.assets[1].value, r.values[i] / 2);
});

test("資產配置：提領導致破產", () => {
  const ser = makeSeries("2015-01-01", 1500, () => 10);
  const r = assetAllocation([ser], { capital: 1000, weights: [1], rebalance: "none", start: "2015-01-01", end: "2030-01-01",
    withdraw: { enabled: true, amount: 300, freq: "year" } });
  // 2016、2017、2018 年初各提 300 → 剩 100；2019 年初不夠提 → 破產
  assert.equal(r.bankrupt, true);
  close(r.totalWithdrawn, 1000);
  assert.ok(r.bankruptDate.startsWith("2019"));
});

test("波動統計：計數、連漲、索提諾", () => {
  const prices = [100, 104, 108.16, 103.9, 104, 98, 99];
  const ser = makeSeries("2020-01-01", prices.length, (i) => prices[i]);
  const v = volatilityStats(ser, [3, 5]);
  assert.equal(v.counts[0].up, 2);   // +4%, +4%
  assert.equal(v.counts[0].down, 2); // -3.94%, -5.77%
  assert.equal(v.counts[1].down, 1);
  assert.equal(v.maxUp.days, 2);
  close(v.maxUp.ret, 0.0816, 1e-6);
});

test("每年買在最高 / 最低點：上漲市場中最低點 ≥ 年初 ≥ 最高點", async () => {
  const { yearlyTimingTest } = await import("../assets/js/engine.js");
  const ser = makeSeries("2000-01-03", 2600, (i) => 100 * Math.pow(1.0004, i) * (1 + 0.05 * Math.sin(i / 9)));
  const r = yearlyTimingTest(ser, { amount: 1000, fromYear: 2000, toYear: 2008 });
  assert.equal(r.years, 9);
  close(r.invested, 9000);
  assert.ok(r.best >= r.first && r.first >= r.worst);
  // 手算：價格固定 → 三者相同 = 投入金額
  const flat = makeSeries("2000-01-03", 800, () => 50);
  const f = yearlyTimingTest(flat, { amount: 100, fromYear: 2000, toYear: 2002 });
  close(f.worst, f.invested); close(f.best, f.invested);
});

test("管理金鑰：用密碼加密後只有正確密碼能解開", async () => {
  const { encryptSecret, decryptSecret, validateConfig } = await import("../assets/js/admin.js");
  const blob = await encryptSecret("github_pat_example123", "correct horse", 1000);
  assert.ok(!JSON.stringify(blob).includes("github_pat"), "密文不應包含明文 Token");
  assert.equal(await decryptSecret(blob, "correct horse"), "github_pat_example123");
  assert.equal(await decryptSecret(blob, "wrong"), null);
  assert.throws(() => validateConfig({ groups: [{ name: "a", tickers: [{ symbol: "SPY" }, { symbol: "SPY" }] }] }), /重複/);
  assert.throws(() => validateConfig({ groups: [{ name: "a", tickers: [{ symbol: "BAD SYM" }] }] }), /格式/);
  validateConfig({ groups: [{ name: "a", tickers: [{ symbol: "0050.TW" }, { symbol: "^GSPC" }, { symbol: "6488.TWO" }, { symbol: "BRK-B" }] }] });
});

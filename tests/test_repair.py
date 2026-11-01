"""執行：python -m unittest discover -s tests -p 'test_*.py'
用 Yahoo 實際出現過的斷層數字（2026-11 診斷結果）檢查台股資料校正規則。"""
import sys, unittest
from pathlib import Path
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from fetch_data import repair_limit_breaks  # noqa: E402


def ser(pairs):
    return pd.Series([v for _, v in pairs], index=pd.to_datetime([d for d, _ in pairs]))


class RepairTest(unittest.TestCase):
    def test_partial_split_0050(self):
        # 0050：2025 年 1 拆 4，Yahoo 只還原到 2014-01-02 → 前面要剛好 ÷4，保留當天真實的 -0.26%
        s = ser([("2013-12-30", 58.8), ("2013-12-31", 58.7), ("2014-01-02", 14.6375), ("2014-01-03", 14.4625)])
        out, fixes = repair_limit_breaks("0050.TW", s)
        self.assertEqual(len(fixes), 1)
        self.assertIn("1 拆 4", fixes[0][2])
        self.assertAlmostEqual(out.iloc[1], 58.7 / 4)
        self.assertAlmostEqual(fixes[0][3], 14.6375 / (58.7 / 4) - 1)

    def test_partial_split_00631L(self):
        s = ser([("2014-12-30", 19.06), ("2014-12-31", 19.05), ("2015-01-05", 0.86909)])
        out, fixes = repair_limit_breaks("00631L.TW", s)
        self.assertIn("1 拆 22", fixes[0][2])
        self.assertAlmostEqual(out.iloc[1], 19.05 / 22)

    def test_unadjusted_stock_dividend(self):
        # 2317 1995-08-16 配股 ×1.4 沒有往前還原
        s = ser([("1995-08-14", 3.492931), ("1995-08-15", 3.569949), ("1995-08-16", 2.600364)])
        sp = pd.Series([0, 0, 1.4], index=s.index)
        out, fixes = repair_limit_breaks("2317.TW", s, sp)
        self.assertIn("沒有往前還原", fixes[0][2])
        self.assertAlmostEqual(out.iloc[1], 3.569949 / 1.4)

    def test_reversed_adjustment(self):
        # 2454 2003-08-19 配股 ×1.35，價格卻 +37% → 被反方向還原
        s = ser([("2003-08-15", 147.378632), ("2003-08-18", 147.735214), ("2003-08-19", 202.743317)])
        sp = pd.Series([0, 0, 1.35], index=s.index)
        out, fixes = repair_limit_breaks("2454.TW", s, sp)
        self.assertIn("反方向", fixes[0][2])
        self.assertAlmostEqual(out.iloc[1], 147.735214 * 1.35)

    def test_unexplained_break(self):
        # 2317 2000-01-04 ÷1.887、沒有事件、也不是整數比例 → 當天報酬 0
        s = ser([("1999-12-31", 41.392452), ("2000-01-03", 41.392452), ("2000-01-04", 21.935089)])
        out, fixes = repair_limit_breaks("2317.TW", s)
        self.assertIn("資料斷層", fixes[0][2])
        self.assertAlmostEqual(out.iloc[1], 21.935089)

    def test_us_untouched(self):
        # AAPL 2000-09-29 真的跌了 52%，非台股不處理
        s = ser([("2000-09-28", 0.955357), ("2000-09-29", 0.459821)])
        out, fixes = repair_limit_breaks("AAPL", s)
        self.assertEqual(fixes, [])
        self.assertTrue(out.equals(s))


if __name__ == "__main__":
    unittest.main()

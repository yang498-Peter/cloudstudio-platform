import unittest

from scripts.extract_floorplan import merge_positions


class MergePositionsRegressionTest(unittest.TestCase):
    def test_accepts_generator_input(self):
        values = (value for value in [0.0, 0.02, 0.21, 0.22])
        merged = merge_positions(values, 0.05)
        self.assertEqual(len(merged), 2)
        self.assertAlmostEqual(merged[0], 0.01, places=6)
        self.assertAlmostEqual(merged[1], 0.215, places=6)


if __name__ == "__main__":
    unittest.main()

"""Reference model vs. verbatim-extracted live scoring functions.

Run: python3 -m unittest -v tests/reference/test_scoring.py   (from repo root)
Needs node. Does not touch Redis/Upstash/chain; the live functions run against an
in-memory fake redis (live_harness.mjs).
"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import reference_model as ref  # noqa: E402

with open(os.path.join(HERE, "pinned_hashes.json")) as _f:
    PINNED = json.load(_f)
DIFF_REPORT = os.path.join(HERE, "last_diffs.json")


def harness(payload):
    p = subprocess.run(["node", os.path.join(HERE, "live_harness.mjs")],
                       input=json.dumps(payload), capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def live_record(history, passed, strings=False):
    return harness({"mode": "run", "cases": [
        {"fn": "recordResult", "history": history, "passed": passed, "strings": strings}]})["results"][0]


def live_current(history):
    return harness({"mode": "run", "cases": [{"fn": "currentScore", "history": history}]})["results"][0]["score"]


class TestPinnedSource(unittest.TestCase):
    def test_extracted_code_matches_pinned_hashes(self):
        d = harness({"mode": "extract"})
        self.assertEqual(d["file_sha256"], PINNED["reporter_js_sha256"], "reporter.js changed; re-verify and re-pin")
        self.assertEqual(d["recordResult"]["sha256"], PINNED["recordResult_sha256"])
        self.assertEqual(d["currentScore"]["sha256"], PINNED["currentScore_sha256"])

    def test_window_size_is_20(self):
        self.assertEqual(harness({"mode": "run", "cases": []})["window_size"], ref.WINDOW)


class TestExhaustiveSweep(unittest.TestCase):
    def test_all_total_passes_combinations(self):
        cases, keys = [], []
        for t in range(0, 21):
            for p in range(0, t + 1):
                cases.append({"fn": "currentScore", "history": [1] * p + [0] * (t - p)})
                keys.append((t, p))
        out = harness({"mode": "run", "cases": cases})["results"]
        diffs = [{"total": t, "passes": p, "live": o["score"], "ref": ref.score(p, t)}
                 for (t, p), o in zip(keys, out) if o["score"] != ref.score(p, t)]
        with open(DIFF_REPORT, "w") as f:
            json.dump({"combinations": len(keys), "diffs": diffs}, f, indent=2)
        print(f"\n[sweep] {len(keys)} combinations, {len(diffs)} diffs")
        for d in diffs:
            print("  DIFF", d)
        self.assertEqual(diffs, [])

    def test_order_independence_and_string_vs_number(self):
        # same (total,passes), different arrangements and "1"/"0" strings
        for h in ([1, 0, 1, 0, 0], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0]):
            self.assertEqual(live_current(h), ref.score_of_history(h))
        self.assertEqual(live_record([1, 0, 1], True, strings=True)["score"],
                         live_record([1, 0, 1], True, strings=False)["score"])


class TestScenarios(unittest.TestCase):
    def check_sequence(self, results):
        """Feed a sequence through live recordResult (fake redis) and the ref model in lockstep."""
        live_hist, ref_hist = [], []
        for passed in results:
            r = live_record(live_hist, passed)
            ref_hist, ref_score = ref.record(ref_hist, passed)
            self.assertEqual(r["score"], ref_score)
            self.assertEqual(r["list"], ref_hist)
            live_hist = r["list"]
        return ref_hist, ref_score

    def test_all_pass(self):
        _, s = self.check_sequence([True] * 20)
        self.assertEqual(s, 95)

    def test_all_fail(self):
        _, s = self.check_sequence([False] * 20)
        self.assertEqual(s, 5)

    def test_alternating(self):
        _, s = self.check_sequence([i % 2 == 0 for i in range(20)])
        self.assertEqual(s, 50)

    def test_over_window(self):
        # 20 failures then 25 passes: old failures must fall out of the window
        hist, s = self.check_sequence([False] * 20 + [True] * 25)
        self.assertEqual(len(hist), 20)
        self.assertEqual(s, 95)
        # 30 passes then 3 failures
        hist, s = self.check_sequence([True] * 30 + [False] * 3)
        self.assertEqual(len(hist), 20)
        self.assertEqual(sum(hist), 17)

    def test_window_exactly_full(self):
        hist, s = self.check_sequence([True] * 19 + [False])
        self.assertEqual(len(hist), 20)
        self.assertEqual(s, ref.score(19, 20))
        # the 21st result evicts exactly the oldest
        hist, _ = self.check_sequence([False] + [True] * 19 + [True])
        self.assertEqual(hist, [1] * 20)

    def test_sample_size_zero(self):
        self.assertEqual(live_current([]), 50)
        self.assertEqual(ref.score_of_history([]), 50)
        self.assertEqual(ref.score(0, 0), 50)

    def test_single_success(self):
        _, s = self.check_sequence([True])
        self.assertEqual(s, 67)

    def test_single_failure(self):
        _, s = self.check_sequence([False])
        self.assertEqual(s, 33)

    def test_rounding_half_up_cases(self):
        # exact .5 cases would expose banker's rounding; compare live vs ref on all of them
        for t in range(0, 21):
            for p in range(0, t + 1):
                exact2 = 200 * (p + 1) % (2 * (t + 2))
                if exact2 == (t + 2):  # fractional part exactly .5
                    self.assertEqual(live_current([1] * p + [0] * (t - p)), ref.score(p, t), (t, p))


class TestReferenceModelItself(unittest.TestCase):
    def test_known_values(self):
        self.assertEqual(ref.score(20, 20), 95)
        self.assertEqual(ref.score(0, 20), 5)
        self.assertEqual(ref.score(1, 1), 67)
        self.assertEqual(ref.score(0, 1), 33)
        self.assertEqual(ref.score(1, 2), 50)
        self.assertEqual(ref.score(1, 6), 25)  # 2/8 = 25 exact
        self.assertEqual(ref.score(2, 6), 38)  # 3/8 = 37.5 -> half up 38

    def test_invalid(self):
        with self.assertRaises(ValueError):
            ref.score(3, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

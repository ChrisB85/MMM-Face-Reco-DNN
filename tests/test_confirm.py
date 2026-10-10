import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
from utils.confirm import NameConfirmer  # noqa: E402


class NameConfirmerTest(unittest.TestCase):
    def test_single_wrong_frame_between_right_ones_is_dropped(self):
        # one stray frame matches the wrong person
        c = NameConfirmer(2)
        seen = [c.update(f) for f in (["alice"], ["bob"], ["alice"], ["alice"])]
        self.assertEqual(seen, [[], [], [], ["alice"]])

    def test_name_stays_while_present_and_resets_after_gap(self):
        c = NameConfirmer(2)
        seen = [c.update(f) for f in (["carol"], ["carol"], ["carol"], [], ["carol"])]
        self.assertEqual(seen, [[], ["carol"], ["carol"], [], []])

    def test_one_frame_keeps_upstream_behaviour(self):
        c = NameConfirmer(1)
        self.assertEqual(c.update(["dave", "unknown"]), ["dave", "unknown"])

    def test_duplicates_in_a_frame_count_once(self):
        c = NameConfirmer(2)
        c.update(["unknown", "unknown"])
        self.assertEqual(c.update(["unknown"]), ["unknown"])


if __name__ == "__main__":
    unittest.main()

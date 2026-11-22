from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tabroom-launcher'))
from window_visibility import Window, covered_windows, read_targets, rect


class WindowVisibilityTest(unittest.TestCase):
    target = rect(0, 25, 100, 100)
    chrome = Window(target, target, opaque=True)

    def check(self, *windows):
        return covered_windows({13: self.target}, windows)

    def test_full_cover_and_multiple_overlapping_windows(self):
        self.assertEqual(self.check(Window(rect(-4, 20, 108, 110), opaque=True), self.chrome), [13])
        self.assertEqual(self.check(Window(rect(0, 25, 60, 100), opaque=True),
                                    Window(rect(50, 25, 50, 100), opaque=True), self.chrome), [13])

    def test_partial_transparent_or_behind(self):
        self.assertEqual(self.check(Window(rect(0, 25, 99, 100), opaque=True), self.chrome), [])
        self.assertEqual(self.check(Window(self.target), self.chrome), [])
        self.assertEqual(self.check(self.chrome, Window(self.target, opaque=True)), [])

    def test_unknown_or_ambiguous_target(self):
        self.assertEqual(self.check(Window(self.target, opaque=True)), [])
        self.assertEqual(self.check(Window(self.target, opaque=True), self.chrome, self.chrome), [])

    def test_windows_uses_physical_frame_for_coverage_and_logical_bounds_for_matching(self):
        physical = rect(0, 50, 200, 200)
        chrome = Window(physical, rect(-8, 18, 116, 114), True, self.target)
        self.assertEqual(self.check(Window(self.target, opaque=True), chrome), [])
        self.assertEqual(self.check(Window(physical, opaque=True), chrome), [13])

    def test_requests_contain_only_bounded_chrome_coordinates(self):
        request = {'type': 'visibility', 'windows': [
            {'id': 13, 'left': 0, 'top': 25, 'width': 100, 'height': 100},
            {'id': 14, 'left': 0, 'top': 25, 'width': -100, 'height': 100},
        ]}
        self.assertEqual(read_targets(request), {13: self.target})

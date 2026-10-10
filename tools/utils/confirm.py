class NameConfirmer:
    """Pass on a name only after it shows up in `frames` consecutive frames.

    A single frame can match the wrong person (a stray encoding just under the
    tolerance); a real person stays in front of the camera for several frames.
    """

    def __init__(self, frames):
        self.frames = max(1, int(frames))
        self.streaks = {}

    def update(self, names):
        present = list(dict.fromkeys(names))
        self.streaks = {n: self.streaks.get(n, 0) + 1 for n in present}
        return [n for n in present if self.streaks[n] >= self.frames]

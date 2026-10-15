"""Independent reference model for the x402 Sentinel reliability score.

Written from spec.md only. Integer arithmetic throughout (no float, no round()).
"""

WINDOW = 20


def score(passes: int, total: int) -> int:
    if not (0 <= passes <= total):
        raise ValueError(f"invalid counts passes={passes} total={total}")
    d = total + 2
    # round-half-up of 100*(passes+1)/d
    return (200 * (passes + 1) + d) // (2 * d)


def score_of_history(history) -> int:
    """history: iterable of 0/1 (newest first). Read-only scoring."""
    h = [int(v) for v in history]
    return score(sum(1 for v in h if v == 1), len(h))


def record(history, passed: bool):
    """Return (new_history, score). History is newest-first, capped at WINDOW."""
    new = [1 if passed else 0] + [int(v) for v in history]
    new = new[:WINDOW]
    return new, score_of_history(new)

def median(values):
    if not values:
        raise ValueError("median of empty list")
    ordered = sorted(values)
    return ordered[len(ordered) // 2]

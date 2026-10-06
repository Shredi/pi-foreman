def total(values):
    return sum(v * v for v in values)


if __name__ == "__main__":
    print(total(range(1, 7)))

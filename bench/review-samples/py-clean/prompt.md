Add `top_words(text, n)` to `textstats/words.py`.

- It returns the `n` most frequent words of `text` (same word rules as `words`) as a list of `(word, count)` tuples, most frequent first.
- Ties are broken alphabetically.
- `n <= 0` or an empty text returns an empty list; `n` larger than the number of distinct words returns all of them.
- Add tests.

import unittest

from textstats.words import word_count, words


class WordsTest(unittest.TestCase):
    def test_words_lowercase_and_apostrophes(self):
        self.assertEqual(words("Don't PANIC, it's fine."), ["don't", "panic", "it's", "fine"])

    def test_word_count(self):
        self.assertEqual(word_count(""), 0)
        self.assertEqual(word_count("one two  three"), 3)


if __name__ == "__main__":
    unittest.main()

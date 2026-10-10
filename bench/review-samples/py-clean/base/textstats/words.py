import re

WORD = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)*")


def words(text):
    """Lower-cased words of `text`; an inner apostrophe stays part of the word."""
    return WORD.findall(text.lower())


def word_count(text):
    return len(words(text))

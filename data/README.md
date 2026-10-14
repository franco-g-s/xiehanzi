# Vendored data

## cedict.txt.gz — CC-CEDICT

Community-maintained Chinese-English dictionary, published by MDBG.
Downloaded 2026-08-19 (124,881 entries).

- Source: https://www.mdbg.net/chinese/dictionary?page=cc-cedict
- **Licence: [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)**
- Referenced works: CEDICT — Copyright (C) 1997, 1998 Paul Andrew Denisowski

Vendored unmodified. Attribution is a licence condition, hence this file.

Used only for **verification** — so an agent can check the pinyin and meaning it writes
onto a card against a real dictionary. It never authors card content on its own.

To refresh:

```bash
curl -sSL -o data/cedict.txt.gz \
  https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
```

## hsk30-charlist.txt — HSK 3.0 character standard

The official character lists, OCR'ed from the Ministry of Education PDF by Pleco.

- Source: https://github.com/elkmovie/hsk30
- **Licence: MIT** — Copyright (c) 2021 Pleco Inc. The licence text is in [`LICENSE-hsk30.txt`](LICENSE-hsk30.txt), shipped alongside as MIT requires.

Contains **two** taxonomies, and the distinction is the premise of this project:

| Section | Count | Meaning |
|---|---|---|
| 一级–七一九级汉字表 | 3,000 | characters you must **recognise** |
| 初等/中等/高等手写字表 | 1,200 | characters you must **write by hand** |

1,800 characters are recognition-only by design. The handwriting bands do not line up with
reading levels — 中等手写 draws 356 of its 400 characters from reading levels 1–3, because
handwriting deliberately lags reading.

Upstream notes the OCR is "not extensively proofread". Tests in `src/sources/hsk.test.ts`
assert the counts (3000 / 300 / 400 / 500 / 1800) so a bad re-download fails loudly.

## hsk30-wordlist.txt — HSK 3.0 vocabulary

11,092 words graded into levels 1–9, from the same Pleco extraction (**MIT**, see [`LICENSE-hsk30.txt`](LICENSE-hsk30.txt)).

Used to choose the example term shown under each practice row. Picking examples from a
dictionary instead produces real-but-useless words: 我人 and 这不 are both valid CC-CEDICT
entries built from very common characters, and both are things nobody says. A graded
vocabulary list only contains words worth knowing, and its levels let an easier word win.

Format differs from the character list: space-separated, with part-of-speech annotations
（形）and variant forms 爸爸｜爸, both stripped at parse time.

## anki-glossary.json — your own definitions (not shipped)

Optional, and deliberately not in this repository. `xiehanzi glossary` extracts the
`Hanzi`, `Definition` and `Pinyin` fields of every note in your Anki deck into this file.

When present it is preferred over CC-CEDICT for the gloss printed on a sheet. A dictionary
lists the first *substantive* sense, which is routinely not the one anyone learns first:
着 came off a real sheet as "a move in chess (Taiwan pr.)", 回 as "Hui ethnic group", 老 as
"prefix used before the surname of a person". Only the **definition** is taken from it; the
pinyin stays CC-CEDICT's, whose numbered readings can be split into syllables.

In the author's setup it is committed rather than fetched at generation time, so that a scheduled job on a
machine without Anki renders the same bytes for the same date — which is how `push` tells
an unchanged sheet from one that has been written on. It is absent here because its
definitions come from a shared community deck whose redistribution terms are unclear, so the
full extract is not shipped. A handful of its short glosses are visible on the rendered test
fixture pages and example images.

Without it, glosses come from CC-CEDICT.

To create or refresh (needs Anki running with AnkiConnect):

    node dist/cli.js glossary          # --dry-run to see what would change

## char-frequency.txt — modern usage ranks

Used to order characters within a band, most common first.

- Derived from **Jun Da's Modern Chinese Character Frequency List** (Modern subcorpus),
  https://lingua.mtsu.edu/chinese-computing/statistics/ — Copyright Jun Da.
- Only **rank and character** are reproduced. The source's pinyin, raw counts and English
  glosses are deliberately not included.
- 9,933 entries, covering 100% of the 1,200 HSK handwriting characters.

The source states no explicit licence. Only the derived ranking is vendored, with
attribution; if that ever becomes a concern, any frequency list in the same format can be
swapped in.

## Stroke data (npm dependency, not vendored)

The character outlines and stroke medians come from the
[`hanzi-writer-data`](https://github.com/chanind/hanzi-writer-data) npm package (2.0.1),
installed by `npm install` and not copied into this repository. Its README states that the
data comes from [Make Me a Hanzi](https://github.com/skishore/makemeahanzi), which
extracted it from fonts by Arphic Technology (the AR PL fonts), and that it may be
redistributed and modified under the **Arphic Public License**. The package declares
`"license": "SEE LICENSE IN ARPHICPL.TXT"` and ships the licence text as `ARPHICPL.TXT`
(Copyright (C) 1999 Arphic Technology Co., Ltd.), with translations under `APL/`.

Every rendered sheet, including the sample `docs/images/sheet.png`, draws these outlines
for the model glyph and the stroke-order filmstrip. Recall grading also
compares handwriting against the same data. The Arphic Public License covers that data, not
this program's source, which is AGPL-3.0-only.

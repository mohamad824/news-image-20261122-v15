# news-image-20261122-v15 — Sunday 22 November 2026

[![competition](https://make.fun/badge/news-image-20261122.svg)](https://make.fun/bounty/news-image-20261122)
[![rank](https://make.fun/badge/news-image-20261122/mohamad824/news-image-20261122-v15/rank.svg)](https://make.fun/bounty/news-image-20261122)
[![reward](https://make.fun/badge/news-image-20261122/mohamad824/news-image-20261122-v15/reward.svg)](https://make.fun/bounty/news-image-20261122)

One-page broadsheet summing up the world's news of **Sunday 22 November 2026** —
36 stories from the full day, all drawn in code.

**v15 = v14, more tidy and more full ("lebih rapih dan penuh", Zul 19:57 WIB 23 Nov).**
The grid is now strictly uniform: all 12 cards exactly the same height, one body
size for every card (no 8.5 px outlier — the Brussels body was reworded to fit
three lines at the standard size while keeping "Signed Saturday in Brussels",
98.5% in the chip, "€600m/year" and "car tariffs (up to 50%) gone in 5 years";
the "provisional application possibly early 2027" clause was dropped, as the
brief allowed), headlines wrap cleanly with no orphans ("Cartel boss captured;
/ 11 killed"), and every illustration is the same height. "ALSO ON — 21 MORE
STORIES" is now a balanced 3 × 7 block with level bottoms. The map's pin leader
lines were re-fanned so none cross and all 15 badges are the same size; the map
dot pattern is denser and the map fills its box, and the map and DATE CHECK boxes
now share exactly the same height, top and bottom. The region chips up top form
one dense centred band. The COP31 delegates and the Somalia embassy illustrations
were enriched so their frames feel full. Everything else from v14 is kept: the
top-2 structure, full-day content (36 stories + DATE CHECK), calm newspaper
palette (cream `#F6EEDC`, black, newspaper red `#C8102E`, navy `#0B1020`), night
scenes with bright fire and light, a data chip on all 12 grid illustrations,
the dotted map, the red summary line, full lead sentences, and complete grid bodies.

## What it shows

- **3 leads:** COP31 collapses with no deal (Antalya) · strike on a Dymer apartment block kills at least 10 · Iran claims two US Patriot radars hit in Bahrain, US denies damage (labelled CLAIM).
- **12 grid stories:** Sparta II ablaze, Peru M6.8 quake, Eisenkot asked to form Israel's government, Kryvyi Rih missiles, cartel boss captured in Sinaloa, Hong Kong votes fill all 723 seats (98.79% turnout, 5,640 voters), two tankers hit near Hormuz, 20th US MQ-1 drone claimed downed, EU–Indonesia trade deal signed Saturday in Brussels (98.5% chip, €600m/year exporter savings), Somalia orders the UAE envoy to leave, four nations press Israel on Gaza aid, Verstappen wins the Las Vegas Grand Prix.
- **21 more stories** (16–36), a numbered dotted world map ("WHERE IT HAPPENED"), a full-day DATE CHECK, and a certainty legend (CONFIRMED / CLAIM / REPORTED / PENDING).

## How it is built

`main.ts` (Node 22, no network, deterministic) renders the whole page from scratch: its own TrueType parser and rasterizer (Playfair Display Black/Bold for headlines, Barlow Condensed for labels and body — OFL fonts bundled in `fonts/`), its own PNG encoder, and every illustration drawn in code as flat vector editorial scenes. Two runs write byte-identical output.

Run it:

```sh
node main.ts   # writes /output/entry.png (1024x1024, <= 1 MiB)
```

## Palette

Calm newspaper cream `#F6EEDC`, black ink, newspaper red `#C8102E`, dark navy `#0B1020`. Colour is concentrated in dark atmospheric night illustrations with bright fire and light accents; all "THE DAY IN NUMBERS" figures are red.

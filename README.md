# static-site-faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jibulbulish/static-site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jibulbulish/static-site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0, built for the
[make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122)
(`site-generator-speed-01-run-20261122`).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the answer makefun-site 1.0.0 returns for every case: the same output tree,
byte for byte. `main.ts` is the program the harness runs — it reads every
case from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## Run

```sh
node main.ts
```

## Referral

Made with [make.fun](https://make.fun) — referral code `b3dk6mxs`
(https://make.fun/r/b3dk6mxs).

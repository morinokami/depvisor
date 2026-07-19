# Changelog

## [2.4.0](https://github.com/morinokami/depvisor/compare/v2.3.0...v2.4.0) (2026-07-19)


### Features

* adopt from-scratch vocabulary for statuses, outputs, and internals ([#124](https://github.com/morinokami/depvisor/issues/124)) ([9d41c3d](https://github.com/morinokami/depvisor/commit/9d41c3dd1ac7b30dc69e048b678a9ed7fe33a989))

## [2.3.0](https://github.com/morinokami/depvisor/compare/v2.2.0...v2.3.0) (2026-07-19)


### Features

* link the PR report footer to its Actions run ([#100](https://github.com/morinokami/depvisor/issues/100)) ([fcafd92](https://github.com/morinokami/depvisor/commit/fcafd92a8376e8c0bad6894949c5f2200fe254bc))
* skip re-review of an already-reviewed head ([#104](https://github.com/morinokami/depvisor/issues/104)) ([8f44d36](https://github.com/morinokami/depvisor/commit/8f44d36b5d5c8e4229fabe9f1eb568dd318beb42))


### Bug Fixes

* freeze package-manager configuration before model work ([#103](https://github.com/morinokami/depvisor/issues/103)) ([8669a82](https://github.com/morinokami/depvisor/commit/8669a82f56dde7ee5b21f40b2137c0bbcaa74c5b))
* freeze Package.swift and unify duplicated URL/JSON boundaries ([#109](https://github.com/morinokami/depvisor/issues/109)) ([bfde4bb](https://github.com/morinokami/depvisor/commit/bfde4bb5d4c37e8cfaac1242f0208856a0d0a59a))
* keep the pre-install credential gate dependency-free ([#119](https://github.com/morinokami/depvisor/issues/119)) ([7aa942f](https://github.com/morinokami/depvisor/commit/7aa942f49937d3206d1dc76be10a8d54a2df8f5d))
* stop the agent padding verification with no-op commands ([#105](https://github.com/morinokami/depvisor/issues/105)) ([1d82a0a](https://github.com/morinokami/depvisor/commit/1d82a0a1540bbcc758dbdda0e6407d5239498189))

## [2.2.0](https://github.com/morinokami/depvisor/compare/v2.1.0...v2.2.0) (2026-07-17)


### Features

* name the report generator with its released depvisor version ([#98](https://github.com/morinokami/depvisor/issues/98)) ([ad26d3c](https://github.com/morinokami/depvisor/commit/ad26d3cbb456b2be8424ba9373ba460ee9e3ec39))

## [2.1.0](https://github.com/morinokami/depvisor/compare/v2.0.0...v2.1.0) (2026-07-17)


### Features

* give the agent bounded read-only upstream-evidence tools ([#95](https://github.com/morinokami/depvisor/issues/95)) ([76b65af](https://github.com/morinokami/depvisor/commit/76b65af42bf322466db38f19d115d8f33bc43047))
* link backticked file mentions in the PR report to the pinned commit ([#97](https://github.com/morinokami/depvisor/issues/97)) ([e7feac3](https://github.com/morinokami/depvisor/commit/e7feac366c2d608ddb5d8ce9acfd4a1e32aeeca3))

## [2.0.0](https://github.com/morinokami/depvisor/compare/v1.5.0...v2.0.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* reinvent depvisor as an updater PR repair agent ([#85](https://github.com/morinokami/depvisor/issues/85))

### Features

* reinvent depvisor as an updater PR repair agent ([#85](https://github.com/morinokami/depvisor/issues/85)) ([a42eb96](https://github.com/morinokami/depvisor/commit/a42eb960dc142f319ccc58324c3e45ee32f95d8a))

## [1.5.0](https://github.com/morinokami/depvisor/compare/v1.4.0...v1.5.0) (2026-07-13)


### Features

* accept trailing-* prefix globs in ignore, minimum_release_age_exclude, and groups ([#75](https://github.com/morinokami/depvisor/issues/75)) ([a04c9e0](https://github.com/morinokami/depvisor/commit/a04c9e0de2d0aaa65c137681f97cfe9a96c3bfa3))
* add dry-run planning mode ([#78](https://github.com/morinokami/depvisor/issues/78)) ([e0a2c15](https://github.com/morinokami/depvisor/commit/e0a2c159b9868f85ef24baac62e6f23aab1e8f68))
* add fixer provenance labels ([#79](https://github.com/morinokami/depvisor/issues/79)) ([86f15df](https://github.com/morinokami/depvisor/commit/86f15dfdb9ca47848190d1f6e0ef2d0c49f720d4))
* comment when human commits block PR updates ([#82](https://github.com/morinokami/depvisor/issues/82)) ([5791dcc](https://github.com/morinokami/depvisor/commit/5791dcc8b5c4df8396ce33d57b03df86fe989a56))
* expose LLM usage as action outputs ([#77](https://github.com/morinokami/depvisor/issues/77)) ([e9df99e](https://github.com/morinokami/depvisor/commit/e9df99e46d6d3a54b304883976441294c3de1fed))
* refresh conflicted dependency PRs ([#81](https://github.com/morinokami/depvisor/issues/81)) ([f3e3781](https://github.com/morinokami/depvisor/commit/f3e37818abb1b11fd41f5c58c09537e534540e7a))

## [1.4.0](https://github.com/morinokami/depvisor/compare/v1.3.0...v1.4.0) (2026-07-12)


### Features

* group related packages into one PR via the groups input ([#68](https://github.com/morinokami/depvisor/issues/68)) ([9513ed4](https://github.com/morinokami/depvisor/commit/9513ed424e1cc6f3012694917d07ea76db5784f0))
* write the PR narrative in a configurable language (language input) ([#61](https://github.com/morinokami/depvisor/issues/61)) ([3cac0a0](https://github.com/morinokami/depvisor/commit/3cac0a07f019fd14a8c8c3881ca4e30e85ab1cb9))


### Bug Fixes

* deny unsupported PMs' lockfiles (yarn.lock, nub.lock) in the fixer gate ([#59](https://github.com/morinokami/depvisor/issues/59)) ([14b75bb](https://github.com/morinokami/depvisor/commit/14b75bba09327731ceb20f58aa8d337cd850c27e))

## [1.3.0](https://github.com/morinokami/depvisor/compare/v1.2.2...v1.3.0) (2026-07-10)


### Features

* apply updates deterministically and shrink the agent to fixer + digest roles ([#51](https://github.com/morinokami/depvisor/issues/51)) ([2a7ef70](https://github.com/morinokami/depvisor/commit/2a7ef70585023a3038f08c01a0001ac68be9e102))

## [1.2.2](https://github.com/morinokami/depvisor/compare/v1.2.1...v1.2.2) (2026-07-09)


### Miscellaneous

* release 1.2.2 ([203ddfc](https://github.com/morinokami/depvisor/commit/203ddfc4d0730498c48e6bc649ec43c45cdec342))

## [1.2.1](https://github.com/morinokami/depvisor/compare/v1.2.0...v1.2.1) (2026-07-09)


### Bug Fixes

* author commits as the resolvable github-actions[bot] identity ([#47](https://github.com/morinokami/depvisor/issues/47)) ([7cc7994](https://github.com/morinokami/depvisor/commit/7cc799420d829e04ea1ef133127fb91808ec9a00))

## [1.2.0](https://github.com/morinokami/depvisor/compare/v1.1.0...v1.2.0) (2026-07-08)


### Features

* open one PR per package and raise the default max_open_prs to 5 ([#44](https://github.com/morinokami/depvisor/issues/44)) ([d8bd096](https://github.com/morinokami/depvisor/commit/d8bd09606d0a0cd1c78764822b8f15197f0f89e8))

## [1.1.0](https://github.com/morinokami/depvisor/compare/v1.0.1...v1.1.0) (2026-07-08)


### Features

* update pnpm catalog-pinned dependencies via a scoped pnpm-workspace.yaml carve-out ([#42](https://github.com/morinokami/depvisor/issues/42)) ([8c7cfc0](https://github.com/morinokami/depvisor/commit/8c7cfc0839f1c7cc094dc791068a6b4cee7b6368))

## [1.0.1](https://github.com/morinokami/depvisor/compare/v1.0.0...v1.0.1) (2026-07-08)


### Bug Fixes

* scope pnpm/action-setup to depvisor's own manifest ([#36](https://github.com/morinokami/depvisor/issues/36)) ([aced08d](https://github.com/morinokami/depvisor/commit/aced08dc7a0ecaae36fa9bf5d6d54e6dc1548ad7))

## 1.0.0 (2026-07-08)


### Miscellaneous

* bootstrap release-please at v1.0.0 ([eefde0f](https://github.com/morinokami/depvisor/commit/eefde0fbc6608d4f557132830b36f06d52e91478))

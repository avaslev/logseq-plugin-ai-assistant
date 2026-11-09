# [0.8.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.7.1...v0.8.0) (2026-11-09)


### Bug Fixes

* flatten markdown lists in single-block writes and reasoning fallback ([108a847](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/108a8471261d82d00245de0d67e7cf2ba7216273))


### Features

* add insert_outline and create_page.outline for controlled page hierarchy ([f16ef07](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/f16ef07f4080087711c8dab2abe0a288048a0162))

## [0.7.1](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.7.0...v0.7.1) (2026-11-09)


### Bug Fixes

* stop truncating history and continue replies cut by the token limit (F25) ([ab44ba2](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/ab44ba21e417aaf6f9df8abaee15bbaadb9592fa))

# [0.7.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.6.0...v0.7.0) (2026-11-08)


### Features

* auto-tune tool rounds from the model context window (F25) ([bae2d2e](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/bae2d2e8821d611ab587479d10ab0c57f08ac59e))
* create_drawing tool renders Excalidraw sketches inline ([e44f824](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/e44f824842af86aa9f95e9a5811ee617b629f2b5))

# [0.6.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.5.0...v0.6.0) (2026-11-08)


### Features

* show agent progress in the answer block ([a6e9677](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/a6e9677e16dd150403de418b645398673a9aa2ac))

# [0.5.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.4.0...v0.5.0) (2026-11-06)


### Features

* render confirmations as a centered Logseq-style modal ([46a0a89](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/46a0a893280e7daa234d330fa8a9cde6fa1486b1)), closes [html/body/#app](https://github.com/html/body//issues/app)
* web search via DuckDuckGo Lite (F21) ([7041524](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/7041524cd1043370305b52419c0c7882c545e75a))

# [0.4.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.3.0...v0.4.0) (2026-11-06)


### Bug Fixes

* normalize the first block written by create_page ([74e1663](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/74e16638de5deadc8a4eb093437f5dfdc1a93926))
* replace the bare empty reply with a tool completion note ([cf32df8](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/cf32df81a9e37359e08374c79cbeb2289ab709a2))


### Features

* agent tools, skills, confirmations and input UX (F8-F10, F14-F18, F22, F23) ([e2904ad](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/e2904ad1ffff6e0033eebd3ba28f1513570b8f88))
* skill auto-selection via use_skill and create_page consent flow ([e04fc85](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/e04fc851fc3b58f11316d852369bf0f01b34b16b))

# [0.3.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.2.1...v0.3.0) (2026-11-05)


### Bug Fixes

* keep tables and code fences rendering with the assistant marker ([ef769ef](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/ef769ef101e43d98c8a893708596abd88567b122))


### Features

* slash commands with autocomplete, /compress and /remove ([b055aca](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/b055acaf0ddebf7d80a7ab4e5fe611ef93d1a62c))

## [0.2.1](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.2.0...v0.2.1) (2026-11-05)


### Bug Fixes

* render the final answer immediately by exiting edit mode ([8a8b9d9](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/8a8b9d9efb4ae858d21dfe1d8f6599e30a408625))
* search the graph via the built-in query engine and add search_tasks ([86fec12](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/86fec129830986eae22a368503cf760c884342d8))

# [0.2.0](https://github.com/avaslev/logseq-plugin-ai-assistant/compare/v0.1.0...v0.2.0) (2026-11-05)


### Bug Fixes

* keep the reply when the answer block is deleted during generation ([59a034e](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/59a034e7e456a5f8a89f26f904799590751e5f9b))


### Features

* return focus to the input bar when a session page is open ([d2b86c4](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/d2b86c4cd8de47781d98c13a1f485d2a5ccab6d0))
* write tools for the open page, robustness fixes and theme fallbacks ([41baf5d](https://github.com/avaslev/logseq-plugin-ai-assistant/commit/41baf5db9f5db78f6cdf27b062da9b4c16ded7bc))

## <small>[8.3.1](https://github.com/vitejs/vite/compare/v8.3.0...v8.3.1) (2026-09-24)</small>
### Bug Fixes

* **deps:** update all non-major dependencies ([#23482](https://github.com/vitejs/vite/issues/23482)) ([3c752c8](https://github.com/vitejs/vite/commit/3c752c8932bc0599465ba4a6d8f44aaf1e934c3d))
* **deps:** update all non-major dependencies ([#23537](https://github.com/vitejs/vite/issues/23537)) ([e8990c4](https://github.com/vitejs/vite/commit/e8990c4d6101dfaca2654ed8ab4d0574ee920248))
* **deps:** update rolldown-related dependencies ([#23483](https://github.com/vitejs/vite/issues/23483)) ([9aecbbf](https://github.com/vitejs/vite/commit/9aecbbfa5fb5da4b9981c099cb9746a9fd210806))
* handle `server.ws: false` in mergeConfig ([#23511](https://github.com/vitejs/vite/issues/23511)) ([f68c0d5](https://github.com/vitejs/vite/commit/f68c0d5a28c96555431413e3e2cbe644337b087f))
* merge `build.rolldownOptions.output.comments` correctly ([#23514](https://github.com/vitejs/vite/issues/23514)) ([4aba8d8](https://github.com/vitejs/vite/commit/4aba8d8720e82e4c5b694a4b7877755a3f84fc57))
* **optimizer:** don't skip imports whose binding starts with type ([#23540](https://github.com/vitejs/vite/issues/23540)) ([39330f4](https://github.com/vitejs/vite/commit/39330f489a0ae08923557f0ce10a307d6662a3f5))
* **optimizer:** resolve pending discovered dep processing on close before init ([#23567](https://github.com/vitejs/vite/issues/23567)) ([5f89433](https://github.com/vitejs/vite/commit/5f894339d27882fedc86bf6b1076fa6d92e404f3))
* **server:** avoid reinitializing watcher when adding file after server close ([#23572](https://github.com/vitejs/vite/issues/23572)) ([6f831f9](https://github.com/vitejs/vite/commit/6f831f9b58ebda77638b514042ad8d160edfb928))
* **sourcemap:** skip URL source roots when injecting sources content ([#23519](https://github.com/vitejs/vite/issues/23519)) ([04fc30a](https://github.com/vitejs/vite/commit/04fc30a4b91870e65a436b3420620a2e02a94a41))

### Miscellaneous Chores

* merge prereleases in changelog ([#23466](https://github.com/vitejs/vite/issues/23466)) ([99bd9d1](https://github.com/vitejs/vite/commit/99bd9d1d46153fa939f4a304cc0177db42e28776))
* **optimizer:** add debug log when waiting for dep before init ([#23566](https://github.com/vitejs/vite/issues/23566)) ([63567c7](https://github.com/vitejs/vite/commit/63567c73ac132e6384fef384e6b9f7e8d5a37fff))
* update `optimizeDeps.include` comment ([#23489](https://github.com/vitejs/vite/issues/23489)) ([6a84c72](https://github.com/vitejs/vite/commit/6a84c72100da4e4be4badb2d9a0026279b4df136))

### Code Refactoring

* assets regexp use non-capture ([#23491](https://github.com/vitejs/vite/issues/23491)) ([f4b4431](https://github.com/vitejs/vite/commit/f4b4431a2f9097fd9bbb7aaebbf1b63c4b54dea1))
* remove duplicate configurations ([#23532](https://github.com/vitejs/vite/issues/23532)) ([9abd99b](https://github.com/vitejs/vite/commit/9abd99bfdd3117149d6faf87fc37bc9899b1c998))
* replace `find` with `some` ([#23554](https://github.com/vitejs/vite/issues/23554)) ([af7cdf6](https://github.com/vitejs/vite/commit/af7cdf6964f124f58d66037e808fe687654948e2))

## [8.3.0](https://github.com/vitejs/vite/compare/v8.2.2...v8.3.0) (2026-09-10)

### Features

* **build:** avoid settling seen preload dependencies for performance ([#23446](https://github.com/vitejs/vite/issues/23446)) ([e6f6b3e](https://github.com/vitejs/vite/commit/e6f6b3e3119256daa837b2dc399058c8aa45b470))
* **devtools:** enable dev server integration ([#23333](https://github.com/vitejs/vite/issues/23333)) ([68aeb8a](https://github.com/vitejs/vite/commit/68aeb8a3b5a5a2ccd505288999bae1a5e6942ee1))
* accept Rolldown watch options in `server.watch` ([#23133](https://github.com/vitejs/vite/issues/23133)) ([1b5cfe3](https://github.com/vitejs/vite/commit/1b5cfe3d3777d4ceb7f35fcee9d3c4279316a084))
* add closeServer and closePreviewServer hooks ([#23110](https://github.com/vitejs/vite/issues/23110)) ([e17d2d5](https://github.com/vitejs/vite/commit/e17d2d565b0288f169c7995adb2b192f917548e7))
* add top-level `tsconfig` option ([#23310](https://github.com/vitejs/vite/issues/23310)) ([93164c3](https://github.com/vitejs/vite/commit/93164c3530a7b4fc7bbedfb986d6afa9546cdef3))
* add warning for unsupported hooks in plugin returned from `applyToEnvironment` hook ([#23191](https://github.com/vitejs/vite/issues/23191)) ([fdef04f](https://github.com/vitejs/vite/commit/fdef04f112aadfea40ad3c448d96a49a04c168bd))
* **cli:** support naming the CPU profile via --profile [name] ([#23042](https://github.com/vitejs/vite/issues/23042)) ([a500dee](https://github.com/vitejs/vite/commit/a500deeb6f52d93ca501a0fc612a5392b939f2f5))
* **config:** warn on named imports from JSON modules ([#23378](https://github.com/vitejs/vite/issues/23378)) ([472385e](https://github.com/vitejs/vite/commit/472385e6ec4b21e3167c7abf9769883d1c9675f8))
* **css:** minify style tag ([#23183](https://github.com/vitejs/vite/issues/23183)) ([8156684](https://github.com/vitejs/vite/commit/8156684572bdcf73e9d8568ed67971f0467fab60))
* searched params attached to workers are now preserved ([#22280](https://github.com/vitejs/vite/issues/22280)) ([517b97f](https://github.com/vitejs/vite/commit/517b97f57ab9473e7417da856eb641d76870a56e))
* support subpath imports in dynamic import statements ([#23185](https://github.com/vitejs/vite/issues/23185)) ([b78e2f1](https://github.com/vitejs/vite/commit/b78e2f1bc1cba404c4bd9faf518d26ec85e89fc7))
* use `import.meta.ROLLDOWN_FILE_URL_*` for assets in JS ([#22888](https://github.com/vitejs/vite/issues/22888)) ([4366ac4](https://github.com/vitejs/vite/commit/4366ac468343252df6d5706361a6348afa66f9cc))
* use `import.meta.ROLLDOWN_FILE_URL_*` for other plugins ([#22894](https://github.com/vitejs/vite/issues/22894)) ([e38f29e](https://github.com/vitejs/vite/commit/e38f29ee48bea5ea3178faec5b78708e86f38afb))
* **worker:** remove worker chunk if it's detected that it's not referenced ([#22473](https://github.com/vitejs/vite/issues/22473)) ([924997a](https://github.com/vitejs/vite/commit/924997a4bdda9115faee9bdb622fcec4fc8357f0))

### Bug Fixes

* handle CRLF line endings in code frame positions ([#23219](https://github.com/vitejs/vite/issues/23219)) ([9913672](https://github.com/vitejs/vite/commit/9913672bee9c34a2df7fff4c2538783cd4f43b4e))
* only treat whole `node_modules` path segments as dependencies (fix [#17467](https://github.com/vitejs/vite/issues/17467)) ([#23437](https://github.com/vitejs/vite/issues/23437)) ([ef0dc17](https://github.com/vitejs/vite/commit/ef0dc17ada53d1169ae5a89cb8f6482831466755))
* **build:** keep hash placeholders as-is in `resolveFileUrl` hook ([#23422](https://github.com/vitejs/vite/issues/23422)) ([e8d6a4d](https://github.com/vitejs/vite/commit/e8d6a4d3399c739772080d70c7f3c4d548a637c9))
* **bundled-dev:** mark payload delivered on client report ([#23373](https://github.com/vitejs/vite/issues/23373)) ([a6d43bc](https://github.com/vitejs/vite/commit/a6d43bc9e3464faa4d49f090e75e1ab334ffb7b0))
* **deps:** update all non-major dependencies ([#23445](https://github.com/vitejs/vite/issues/23445)) ([fc7c104](https://github.com/vitejs/vite/commit/fc7c104e74d35a97fa313d5dd6f1b5e7d5b26159))
* **html:** don't inline preload link targets (fix [#13355](https://github.com/vitejs/vite/issues/13355)) ([#23387](https://github.com/vitejs/vite/issues/23387)) ([12e709c](https://github.com/vitejs/vite/commit/12e709ca4df1059747db1cb7c5d1cd71aba79a24))
* resolve the actual package root in findNearestMainPackageData for nested package.json ([#23356](https://github.com/vitejs/vite/issues/23356)) ([8492422](https://github.com/vitejs/vite/commit/8492422b8f110625a90c702f42f30784e8cf19dc))
* shortcuts extend error ([#23447](https://github.com/vitejs/vite/issues/23447)) ([4ec58d1](https://github.com/vitejs/vite/commit/4ec58d159df4a1b4799356a1fda62db88ed14752))
* **config:** close bundles when generation fails ([#23256](https://github.com/vitejs/vite/issues/23256)) ([6bacc95](https://github.com/vitejs/vite/commit/6bacc956df5a76cc5653b9de4493453b953439fd))
* **css:** keep newline-separated srcset candidates intact ([#23265](https://github.com/vitejs/vite/issues/23265)) ([4f9d2f4](https://github.com/vitejs/vite/commit/4f9d2f4dadc83191200de7d2154c957a711e8c3d))
* **deps:** update all non-major dependencies ([#23337](https://github.com/vitejs/vite/issues/23337)) ([d550815](https://github.com/vitejs/vite/commit/d55081581ddd4d55667fef38e85d02ab7f879f15))
* **deps:** update all non-major dependencies ([#23404](https://github.com/vitejs/vite/issues/23404)) ([238ad81](https://github.com/vitejs/vite/commit/238ad811c7fb9e4730cbd317d0657867ed3447b3))
* **deps:** update rolldown-related dependencies ([#23338](https://github.com/vitejs/vite/issues/23338)) ([76e8082](https://github.com/vitejs/vite/commit/76e8082c56a2872dc8017c5672bc36cba8dcf75d))
* **deps:** update rolldown-related dependencies ([#23405](https://github.com/vitejs/vite/issues/23405)) ([b882566](https://github.com/vitejs/vite/commit/b88256607e3a051b7bcb0b338b3c4665926b55a8))
* **dev:** run closeBundle after buildEnd failure ([#23165](https://github.com/vitejs/vite/issues/23165)) ([8cb872e](https://github.com/vitejs/vite/commit/8cb872e7fb65b03f6068923c6aa7fcf3e71baf21))
* **hmr:** handle `import.meta.hot.invalidate` in virtual module ([#23171](https://github.com/vitejs/vite/issues/23171)) ([6162968](https://github.com/vitejs/vite/commit/616296895bd135386d35069a479a5f188c7de298))
* **utils:** handle dot in srcset density descriptor ([#23346](https://github.com/vitejs/vite/issues/23346)) ([b50e1b4](https://github.com/vitejs/vite/commit/b50e1b4a3d66128a4076e19769b2e29657985516))
* **utils:** match timestamp query parameter with proper delimiters ([#23364](https://github.com/vitejs/vite/issues/23364)) ([41f3c6f](https://github.com/vitejs/vite/commit/41f3c6fff88ade015669cac5c42db946e0b6f5c9))

### Performance Improvements

* **proxy:** pre-compile context matchers at server creation ([#23263](https://github.com/vitejs/vite/issues/23263)) ([8abf700](https://github.com/vitejs/vite/commit/8abf700eeb2411d8402d08f8e2696effafdbe774))

### Miscellaneous Chores

* introducing `@e18e/eslint-plugin` ([#23357](https://github.com/vitejs/vite/issues/23357)) ([f794133](https://github.com/vitejs/vite/commit/f79413353995a2344879014410a9128b1b9f8e9a))
* remove unnecessary comment ([#23448](https://github.com/vitejs/vite/issues/23448)) ([b919a1a](https://github.com/vitejs/vite/commit/b919a1a8b5a7c694667f993d677973f42d349458))
* delete unused `PluginContainerOptions` ([#23382](https://github.com/vitejs/vite/issues/23382)) ([ee64401](https://github.com/vitejs/vite/commit/ee644014aab61e546742b862a7d7b0d6c7d67a7b))
* use oxfmt `sortImports` ([#23319](https://github.com/vitejs/vite/issues/23319)) ([97ad042](https://github.com/vitejs/vite/commit/97ad042170f4c71b518239723b733dd98e8e3e76))

### Code Refactoring

* delete unused `esbuildPlugin` ([#23381](https://github.com/vitejs/vite/issues/23381)) ([f40efef](https://github.com/vitejs/vite/commit/f40efefbb3630cdb7235286bc2b51673d9fbfc27))
* exclude postfix from `__VITE_ASSET__` ([#22886](https://github.com/vitejs/vite/issues/22886)) ([a6c08e1](https://github.com/vitejs/vite/commit/a6c08e10a624bd89b78683ff1b0e8cfa1d89aa45))
* remove HmrUrl concept ([#23172](https://github.com/vitejs/vite/issues/23172)) ([67a6807](https://github.com/vitejs/vite/commit/67a680767317f8e2cb28b6b0500192f993a567cf))
* use `urlId` of `import.meta.ROLLDOWN_FILE_URL` in wasm plugin ([#22962](https://github.com/vitejs/vite/issues/22962)) ([92bd2a7](https://github.com/vitejs/vite/commit/92bd2a7f325ed102349cdc6c1ad4b5cd25e1d72f))

### Tests

* add `renderBuiltUrl` change changes hash ([#23118](https://github.com/vitejs/vite/issues/23118)) ([0291408](https://github.com/vitejs/vite/commit/0291408b8443129ce6f6d1d440be8facabe9683b))

### Beta Changelogs

#### [8.3.0-beta.1](https://github.com/vitejs/vite/compare/v8.3.0-beta.0...v8.3.0-beta.1) (2026-09-07)

See [8.3.0-beta.1 changelog](https://github.com/vitejs/vite/blob/v8.3.0-beta.1/packages/vite/CHANGELOG.md)

#### [8.3.0-beta.0](https://github.com/vitejs/vite/compare/v8.2.2...v8.3.0-beta.0) (2026-09-02)

See [8.3.0-beta.0 changelog](https://github.com/vitejs/vite/blob/v8.3.0-beta.0/packages/vite/CHANGELOG.md)

## <small>[8.2.2](https://github.com/vitejs/vite/compare/v8.2.1...v8.2.2) (2026-08-20)</small>
### Features

* **deps:** widen `@vitejs/devtools` peer range to v0.5.0 ([#23302](https://github.com/vitejs/vite/issues/23302)) ([495d9ff](https://github.com/vitejs/vite/commit/495d9ff5a7d843ca876a9e49799947a5deb704c7))

### Bug Fixes

* **bundled-dev:** handle lazy request error ([#23291](https://github.com/vitejs/vite/issues/23291)) ([3ba026d](https://github.com/vitejs/vite/commit/3ba026dade4af56df08815310d3458fa110f5c5c))
* **bundled-dev:** hot update through circular imports instead of reloading ([#23259](https://github.com/vitejs/vite/issues/23259)) ([3dbddef](https://github.com/vitejs/vite/commit/3dbddefaafc091a879b06f9279296f776691e455))
* **config:** resolve sourcemap paths against sourcemap location ([#23239](https://github.com/vitejs/vite/issues/23239)) ([05a003e](https://github.com/vitejs/vite/commit/05a003e6a17a84d75f907ea0f1598bc39b8dce6c))
* **css:** don't pass empty targets to lightningcss ([#23295](https://github.com/vitejs/vite/issues/23295)) ([2804636](https://github.com/vitejs/vite/commit/2804636ff608d105928009d274ffba7cfbe55340))
* **define:** fix match escaped dots to support $-prefixed define keys ([#23249](https://github.com/vitejs/vite/issues/23249)) ([dcf88bd](https://github.com/vitejs/vite/commit/dcf88bd2ad2b1a8845f9029587cc8c825e382d42))
* **deps:** update all non-major dependencies ([#23217](https://github.com/vitejs/vite/issues/23217)) ([ba958bd](https://github.com/vitejs/vite/commit/ba958bddfc9cabe302c6b34269dcf5c9634531e0))
* **deps:** update rolldown-related dependencies ([#23218](https://github.com/vitejs/vite/issues/23218)) ([83ecb2c](https://github.com/vitejs/vite/commit/83ecb2c8059e8ce946a7cc835d4c14ef78aef4fd))
* **module-runner:** exclude completed modules from in-flight cycle detection (fix [#22999](https://github.com/vitejs/vite/issues/22999)) ([#23009](https://github.com/vitejs/vite/issues/23009)) ([d9b10a9](https://github.com/vitejs/vite/commit/d9b10a98db1c293ee64300bd75d568b44c8ae931))
* **optimizer:** close custom extension analysis bundles ([#23207](https://github.com/vitejs/vite/issues/23207)) ([8fb7675](https://github.com/vitejs/vite/commit/8fb76752836f61224d3095b502fa237b478a06b2))
* reduce Windows 8.3-short-name detection false-positives ([#23066](https://github.com/vitejs/vite/issues/23066)) ([02cffa9](https://github.com/vitejs/vite/commit/02cffa9e2d38d5d8f12e4043ee9d0f7abb1471e2))
* respect `resolve.preserveSymlinks` when resolving root (fix [#23197](https://github.com/vitejs/vite/issues/23197)) ([#23198](https://github.com/vitejs/vite/issues/23198)) ([8413052](https://github.com/vitejs/vite/commit/8413052731836d4aaf3eb94a0f25788dd35d2888))
* **ssr:** rewrite computed key of destructing parameter ([#23307](https://github.com/vitejs/vite/issues/23307)) ([9db0b61](https://github.com/vitejs/vite/commit/9db0b61d4c9c7caad7ea1d9670b637faf2bb6c93))
* **vite:** update outdated upstream file links in license comments ([#23285](https://github.com/vitejs/vite/issues/23285)) ([c0f2fc6](https://github.com/vitejs/vite/commit/c0f2fc607ee97ee4499337b04826420c00654065))

### Documentation

* **build:** note cssTarget precedence ([#23200](https://github.com/vitejs/vite/issues/23200)) ([a20a35e](https://github.com/vitejs/vite/commit/a20a35ec0685e374519864d0f41dd5f6e9ba0271))

### Miscellaneous Chores

* fix ts errors in build test cases ([#23209](https://github.com/vitejs/vite/issues/23209)) ([a0cfcf7](https://github.com/vitejs/vite/commit/a0cfcf72f8ef8bf0f2f11d553333b9bb31f1d316))

### Code Refactoring

* use JSON import attributes instead of readFileSync in constants ([#23258](https://github.com/vitejs/vite/issues/23258)) ([1d9fa39](https://github.com/vitejs/vite/commit/1d9fa392a43229241f80630236f8552ce8f7cd0f))
* use named regex constants over inline literals ([#22964](https://github.com/vitejs/vite/issues/22964)) ([5c1c6c6](https://github.com/vitejs/vite/commit/5c1c6c609718303202832f706884192e1f1e9223))

### Tests

* **define:** close rolldown bundler after generate ([#23231](https://github.com/vitejs/vite/issues/23231)) ([b4d66fe](https://github.com/vitejs/vite/commit/b4d66fee14d970f45b8a6f3d7d6aee73ca9b88ab))
* **module-runner:** add TLA circular import case ([#23299](https://github.com/vitejs/vite/issues/23299)) ([4a261f2](https://github.com/vitejs/vite/commit/4a261f242831bef92afd2f1aacfb81eab9dec371))
* **module-runner:** simplify server-hmr tests ([#23300](https://github.com/vitejs/vite/issues/23300)) ([599b44b](https://github.com/vitejs/vite/commit/599b44b6600ec426e10cd556908d53b027b0c4fb))
* **ssr:** add destructing assignment case for moduleRunnerTransform ([#23308](https://github.com/vitejs/vite/issues/23308)) ([cb77e2a](https://github.com/vitejs/vite/commit/cb77e2a93bad2a8ece00b4aa0ef507c092582c45))

### Build System

* use JSON import attributes instead of readFIleSync in rolldown configs ([#23251](https://github.com/vitejs/vite/issues/23251)) ([d615bcd](https://github.com/vitejs/vite/commit/d615bcdb23d96c1ca5ce1ee45e21d8d87381106f))


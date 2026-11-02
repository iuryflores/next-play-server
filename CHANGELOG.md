# Changelog

## [0.5.7](https://github.com/iuryflores/next-play-server/compare/v0.5.6...v0.5.7) (2026-11-02)


### Bug Fixes

* verifica execução mínima do agente quando SSM não retorna logs ([80121a5](https://github.com/iuryflores/next-play-server/commit/80121a5234fc929dfdcadcdfabd9edf9ba846a4b))

## [0.5.6](https://github.com/iuryflores/next-play-server/compare/v0.5.5...v0.5.6) (2026-11-02)


### Bug Fixes

* consulta diagnóstico do agente SSM além do shell ([3301e41](https://github.com/iuryflores/next-play-server/commit/3301e41a7af01a39c755765ba05b045e36949891))
* mantém diagnóstico adicional SSM como consulta opcional ([0c9cdf1](https://github.com/iuryflores/next-play-server/commit/0c9cdf14996914853140f6a455543827d80a2692))

## [0.5.5](https://github.com/iuryflores/next-play-server/compare/v0.5.4...v0.5.5) (2026-11-02)


### Bug Fixes

* inclui erro de sistema SSM com valores privados removidos ([7401533](https://github.com/iuryflores/next-play-server/commit/7401533aef1abd25b6148b164123922b03a320bd))

## [0.5.4](https://github.com/iuryflores/next-play-server/compare/v0.5.3...v0.5.4) (2026-11-02)


### Bug Fixes

* explica recusas de ativação antes do rollback ([c3e7b7a](https://github.com/iuryflores/next-play-server/commit/c3e7b7a4e1d41f7593ddd356a1c055f2fcdb8462))
* preserva linhas seguras no diagnóstico de deploy ([e28d77f](https://github.com/iuryflores/next-play-server/commit/e28d77f4cb4fb69f7a5bb0c77795d95dc69576b7))

## [0.5.3](https://github.com/iuryflores/next-play-server/compare/v0.5.2...v0.5.3) (2026-11-02)


### Bug Fixes

* identifica erros de transporte e shell no deploy remoto ([c0212b7](https://github.com/iuryflores/next-play-server/commit/c0212b7f82dc9636fc378671f5570a0a985a7d33))

## [0.5.2](https://github.com/iuryflores/next-play-server/compare/v0.5.1...v0.5.2) (2026-11-02)


### Bug Fixes

* revalida releases desatualizadas e diagnostica falhas SSM ([1feb99b](https://github.com/iuryflores/next-play-server/commit/1feb99b02971516f719c9d2c821f599fe217c07c))

## [0.5.1](https://github.com/iuryflores/next-play-server/compare/v0.5.0...v0.5.1) (2026-11-02)


### Bug Fixes

* salva tema e densidade na conta do usuário ([226d2bd](https://github.com/iuryflores/next-play-server/commit/226d2bd71ac050d3d1ff7a3975c803cc11bdd4bb))

## [0.5.0](https://github.com/iuryflores/next-play-server/compare/v0.4.0...v0.5.0) (2026-11-02)


### Features

* aprimora conquistas, rankings e navegação ([a8d0544](https://github.com/iuryflores/next-play-server/commit/a8d054494367a84cc3abd850bc5afc07f652807f))
* exibe fotos e facilita convites nos rankings ([945e9fc](https://github.com/iuryflores/next-play-server/commit/945e9fc2eeb3c78952ceac049fbed303dabd2080))
* registra tempo jogado no acompanhamento de jogos ([01f4468](https://github.com/iuryflores/next-play-server/commit/01f44685fbe6addc62675b32cb80a2f74372fc29))

## [0.4.0](https://github.com/iuryflores/next-play-server/compare/v0.3.0...v0.4.0) (2026-11-02)


### Features

* add achievement progression and catalog previews ([b100d3a](https://github.com/iuryflores/next-play-server/commit/b100d3a0d37d1c74af26e20d247bcde4b4747c9b))

## [0.3.0](https://github.com/iuryflores/next-play-server/compare/v0.2.0...v0.3.0) (2026-11-01)


### Features

* add collector MVP with books and private item photos ([b178e42](https://github.com/iuryflores/next-play-server/commit/b178e42ed88074bf7637cfd1a2eb8844708bbc93))

## [0.2.0](https://github.com/iuryflores/next-play-server/compare/v0.1.0...v0.2.0) (2026-11-01)


### Features

* consolidate NextPlay API and automate EC2 deployments ([753f4fc](https://github.com/iuryflores/next-play-server/commit/753f4fcaf7654b6406e78b778e34548302cb0037))


### Bug Fixes

* use compatible MongoDB service in CI ([1389b3c](https://github.com/iuryflores/next-play-server/commit/1389b3cf94a3271bbb7c592fe5f5eb24ca563582))
* wait for Nginx workers before verifying deployment ([cb52920](https://github.com/iuryflores/next-play-server/commit/cb529201fb99f904af69643f23fa4f971032db71))

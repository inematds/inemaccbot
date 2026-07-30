# inemaccbot

Gateway Telegram + fila durável + runtime de fluxos. Sucessor do `inemaccvbot`.

**Estado:** etapa 0 — núcleo da fila (`src/db/`, `src/fila/`, `src/dominio/perfil.ts`). Ainda sem
código de Telegram, sem `interpret`, sem registries (`config/*.json`) e sem runtime de fluxos —
isso é etapa 1+. `src/index.ts` hoje é um placeholder vazio; é onde a etapa 1 vai ligar o loop de
`Worker.passo()`, o timer de `bater()` e o `SIGTERM` a `drenar()`.

## Documentos

- Arquitetura: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md`
- Perfil de execução (motor/modelo/esforço): `docs/perfil-de-execucao.md`
- Plano da etapa 0: `docs/superpowers/plans/2026-07-30-etapa-0-fila-duravel.md`
- Crítica externa ao design (respondida na §13 do spec): `docs/analise_critica_inemaccbot_design.md`

## Estrutura do código (etapa 0)

```
src/
  db/           abrir.ts (SQLite + WAL), migrations.ts, backup.ts
  fila/         types.ts (Job/Perfil/Fila), store.ts (FilaSqlite), runner.ts (contrato
                Runner/Execucao), runner-claude.ts (motor claude), worker.ts (stepper)
  dominio/      perfil.ts (resolverPerfil — motor/modelo/esforço)
  integracao/   testes que legitimamente cruzam camadas (ex.: backup-restore.test.ts)
  arquitetura.test.ts   verifica as fronteiras entre camadas acima
  index.ts      placeholder — etapa 1 liga Worker, Telegram e o resto aqui
```

## Desenvolvimento

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc
```

Config futura em `.env` (modo 600, fora do git) — nomes previstos, ainda **não lidos por nenhum
loader de configuração nesta etapa** (isso entra quando `src/index.ts` deixar de ser placeholder):
`BOT_TOKEN`, `QUEUE_DB`, `STATE_DIR`, `LOG_FILE`, `MOTOR_PADRAO`, `MODELO_PADRAO`, `ESFORCO_PADRAO`.

## Convenções

- ESM: todo import relativo termina em `.js` (mesmo importando de um `.ts`)
- Relógio injetável: nada chama `Date.now()` fora de um `agora: Agora` (`src/fila/types.ts`)
- Testes com arquivo SQLite temporário, nunca `:memory:`
- Fronteiras entre camadas verificadas por `src/arquitetura.test.ts`: `fila/` não importa de
  `gateway/` nem `fluxos/`; `fluxos/` não importa de `gateway/`; `dominio/` não importa de
  `gateway/`, `fila/` nem `fluxos/`; `db/` não importa de nenhuma das outras. A regra vale para
  **todo `.ts`, inclusive teste** — um teste que precisa legitimamente cruzar camadas não é motivo
  para abrir exceção na regra, ele vai em `src/integracao/`, que fica fora do mapa de proibições de
  propósito. A lista de exceções do teste de arquitetura tem hoje **uma única entrada**
  (`dominio/` pode importar `fila/types.js`, porque é só um tipo) — se uma fronteira falhar, o
  conserto é mover o código, não engordar essa lista.

## `Worker` é um stepper, não um serviço

`src/fila/worker.ts` não tem `iniciar()` nem agenda a si mesmo. Ele expõe `passo()` (processa no
máximo um job), `bater()` (renova o lease do que está em voo), `drenar()` (para de aceitar novos
jobs e espera o que está em voo, renovando o lease enquanto espera) e `abortar()` (cancela à força
o que sobrou depois do timeout do drain). Quem chama `passo()` em loop, quem chama `bater()`
periodicamente e quem liga `SIGTERM` a `drenar()` é `src/index.ts` — isso é trabalho da etapa 1,
não desta classe.

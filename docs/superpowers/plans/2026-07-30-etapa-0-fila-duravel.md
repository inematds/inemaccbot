# Etapa 0 — Fila durável + perfil de execução (plano de implementação)

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development`
> (recomendado) ou `superpowers:executing-plans` para implementar tarefa por tarefa. Os passos usam
> checkbox (`- [ ]`) para rastreio.

**Goal:** entregar o núcleo do `inemaccbot` — fila SQLite durável com claim atômico, lease com
heartbeat, retry com backoff, idempotência, drain no `SIGTERM`, migrations com checksum, backup
consistente — e a camada de **perfil de execução** (motor/modelo/esforço) plugável e documentada.

**Architecture:** monólito modular. Nesta etapa só existem `src/db/` (migrations, backup),
`src/fila/` (tipos, store, claim, runner, worker) e `src/dominio/perfil.ts` (resolução do perfil de
execução). **Nenhum comando de Telegram** — o gateway é a etapa 1. O motor de fila é portado
conceitualmente do `mkivideos` (que é `ports & adapters`), com o claim reescrito para ser atômico.

**Tech Stack:** Node 22+, TypeScript ESM (`module: NodeNext`), `better-sqlite3`, `vitest`. Testes
colocados ao lado do código (`src/**/*.test.ts`), padrão do `inemaccvbot`.

**Spec:** `docs/superpowers/specs/2026-07-30-inemaccbot-design.md` (revisão 2 + §1.4/§1.5).

## Global Constraints

- Repo: `~/projetos/inemaccbot`, remoto `git@github.com:inematds/inemaccbot.git`, branch `master`.
- Autor de todo commit: `inematds <inematds@gmail.com>` (já configurado localmente). Push via SSH.
- TypeScript `strict: true`. ESM: **todo import relativo termina em `.js`** (`./types.js`).
- `better-sqlite3` é a única dependência de runtime nesta etapa.
- **Relógio injetável**: nada chama `Date.now()` fora de um `agora: Agora` recebido por parâmetro.
  Sem exceção — lease, backoff e `disponivel_em` são tempo, e teste com `sleep` é proibido.
- **SQLite**: `journal_mode = WAL` e `busy_timeout = 5000` em toda abertura.
- **Testes usam arquivo temporário, nunca `:memory:`** (claim atômico e WAL não existem em memória).
- **`spawn`/`execFile` sempre sem `shell: true`**, argumentos como array.
- Segredos nunca aparecem em log nem em mensagem de erro.
- Nomes de env sem nome de produto: `QUEUE_DB`, `BOT_TOKEN`, `MODELO_PADRAO`, `ESFORCO_PADRAO`,
  `MOTOR_PADRAO`.
- Nomenclatura de domínio em português (`fila`, `tarefa`, `tentativas`, `disponivel_em`), como no v1.
- Nenhum arquivo do `inemaccvbot` ou do `mkivideos` é modificado. Este repo é independente.

## Estrutura de arquivos desta etapa

| arquivo | responsabilidade |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | scaffold |
| `src/db/abrir.ts` | abre o SQLite com WAL + busy_timeout |
| `src/db/migrations.ts` | lista de migrations + aplicação com checksum |
| `src/db/backup.ts` | backup via API do SQLite |
| `src/fila/types.ts` | `Job`, `NovoJob`, `Fila`, `Kind`, `StatusJob`, `Perfil`, `FilaStore`, `Agora` |
| `src/fila/store.ts` | implementação `FilaStore` sobre better-sqlite3 (enqueue, claim, lease, ack) |
| `src/fila/runner.ts` | `AgentRunner`/`Runner` (interface) + `FakeRunner` |
| `src/fila/runner-claude.ts` | `ClaudeRunner` — `child_process`, kill de árvore |
| `src/fila/worker.ts` | loop `claim → executa → ack`, concorrência por fila, drain |
| `src/dominio/perfil.ts` | resolução de motor/modelo/esforço por precedência |
| `src/arquitetura.test.ts` | teste que verifica as fronteiras de import |
| `src/integracao/` | testes que cruzam camadas de propósito, sem restrição de fronteira |

> **Correção da revisão 2 do plano (decidida pelo dono em 2026-07-30):** o teste de fronteiras
> encontrou uma violação real já no primeiro run — o teste da Task 12 (`src/db/backup.test.ts`)
> importa `FilaSqlite` de `../fila/store.js`, e `db/` não pode importar de `fila/`. As regras valem
> para **todo** `.ts`, testes incluídos, e a lista de exceções continua com **uma** entrada
> (`dominio/` → `fila/types.js`, tipo e não implementação). Teste que precisa cruzar camadas muda de
> lugar: o cenário de restore vive em `src/integracao/backup-restore.test.ts`. Assim "este teste
> cruza camadas" é decisão explícita e visível, em vez de isenção geral para testes — e a etapa 1,
> que terá testes de gateway + fila juntos, já tem o lugar certo definido.
| `docs/perfil-de-execucao.md` | documentação da portabilidade de motor/modelo/esforço |

---

### Task 1: Scaffold do projeto

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/.gitkeep`
- Modify: nenhum

**Interfaces:**
- Consumes: nada
- Produces: scripts `npm test`, `npm run build`, `npm run typecheck`

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "inemaccbot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^12.11.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Criar `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], passWithNoTests: true },
});
```

- [ ] **Step 4: Instalar e verificar**

```bash
cd ~/projetos/inemaccbot && touch src/.gitkeep && npm install && npm run typecheck && npm test
```

Esperado: `typecheck` sem erro; `vitest` termina com "No test files found" e código 0
(`passWithNoTests`).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/.gitkeep
git commit -m "chore: scaffold TypeScript ESM + vitest + better-sqlite3"
```

---

### Task 2: Abrir o banco com WAL e migrations com checksum

**Files:**
- Create: `src/db/abrir.ts`, `src/db/migrations.ts`, `src/db/migrations.test.ts`
- Test: `src/db/migrations.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `abrirDb(caminho: string): Database.Database` — WAL + `busy_timeout=5000`
  - `type Migration = { version: number; nome: string; sql: string }`
  - `MIGRATIONS: Migration[]`
  - `aplicarMigrations(db: Database.Database, agora: () => number, migrations?: Migration[]): number`
    — devolve quantas aplicou; lança `Error` se um checksum já aplicado divergir
  - `checksum(sql: string): string` — sha256 hex

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/db/migrations.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from './abrir.js';
import { aplicarMigrations, type Migration } from './migrations.js';

const agora = () => 1_700_000_000;

describe('migrations', () => {
  let dir: string;
  let caminho: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
    caminho = join(dir, 'teste.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const M1: Migration = { version: 1, nome: 'cria_t', sql: 'CREATE TABLE t (a INTEGER);' };

  it('abre em WAL com busy_timeout', () => {
    const db = abrirDb(caminho);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('aplica uma migration e registra versão + checksum', () => {
    const db = abrirDb(caminho);
    expect(aplicarMigrations(db, agora, [M1])).toBe(1);
    const linha = db.prepare('SELECT version, checksum FROM schema_migrations').get() as {
      version: number; checksum: string;
    };
    expect(linha.version).toBe(1);
    expect(linha.checksum).toHaveLength(64);
    db.close();
  });

  it('é idempotente — segunda chamada não aplica nada', () => {
    const db = abrirDb(caminho);
    aplicarMigrations(db, agora, [M1]);
    expect(aplicarMigrations(db, agora, [M1])).toBe(0);
    db.close();
  });

  it('recusa subir se o checksum de uma migration aplicada divergir', () => {
    const db = abrirDb(caminho);
    aplicarMigrations(db, agora, [M1]);
    const adulterada: Migration = { ...M1, sql: 'CREATE TABLE t (a TEXT);' };
    expect(() => aplicarMigrations(db, agora, [adulterada])).toThrow(/checksum/i);
    db.close();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Rodar: `npx vitest run src/db/migrations.test.ts`
Esperado: FAIL — `Cannot find module './abrir.js'`.

- [ ] **Step 3: Implementar `src/db/abrir.ts`**

```ts
// Abre o SQLite operacional. WAL e busy_timeout são obrigatórios: a fila tem
// concorrência > 1 (fila `io`), e sem WAL um leitor bloquearia o escritor.
import Database from 'better-sqlite3';

export function abrirDb(caminho: string): Database.Database {
  const db = new Database(caminho);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 4: Implementar `src/db/migrations.ts`**

```ts
// Migrations versionadas com checksum. O boot RECUSA subir se o SQL de uma
// migration já aplicada mudou — divergência silenciosa de schema é a pior
// classe de bug num sistema que guarda estado de fluxo.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  nome: string;
  sql: string;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Migrations do sistema, em ordem crescente de `version`. */
export const MIGRATIONS: Migration[] = [];

const SCHEMA_CONTROLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    nome       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

export function aplicarMigrations(
  db: Database.Database,
  agora: () => number,
  migrations: Migration[] = MIGRATIONS,
): number {
  db.exec(SCHEMA_CONTROLE);

  const aplicadas = new Map<number, string>(
    (db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
      version: number; checksum: string;
    }[]).map((l) => [l.version, l.checksum]),
  );

  let n = 0;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const soma = checksum(m.sql);
    const anterior = aplicadas.get(m.version);
    if (anterior !== undefined) {
      if (anterior !== soma) {
        throw new Error(
          `migration ${m.version} (${m.nome}): checksum divergente — o SQL mudou depois de aplicado`,
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, nome, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.nome, soma, agora());
    })();
    n += 1;
  }
  return n;
}
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Rodar: `npx vitest run src/db/migrations.test.ts`
Esperado: 4 testes PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/abrir.ts src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(db): abertura em WAL e migrations versionadas com checksum"
```

---

### Task 3: Tipos da fila e migration 001 (tabela `jobs`)

**Files:**
- Create: `src/fila/types.ts`
- Modify: `src/db/migrations.ts` (preencher `MIGRATIONS`)
- Create: `src/db/schema-001.test.ts`

**Interfaces:**
- Consumes: `aplicarMigrations`, `abrirDb` (Task 2)
- Produces:
  - `type Fila = 'render' | 'navegador' | 'texto' | 'io' | 'cpu'`
  - `type Kind = 'agent' | 'function'`
  - `type StatusJob = 'queued' | 'running' | 'done' | 'failed' | 'canceled'`
  - `type Agora = () => number`
  - `interface Perfil { motor: string; modelo: string; esforco: string }`
  - `interface Job` (linha completa) e `interface NovoJob` (entrada de enfileiramento)
  - `MIGRATIONS` com a migration `1 · jobs`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/db/schema-001.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { abrirDb } from './abrir.js';
import { MIGRATIONS, aplicarMigrations } from './migrations.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('migration 001 cria jobs com todas as colunas do spec', () => {
  const db = abrirDb(join(dir, 'x.db'));
  aplicarMigrations(db, () => 1, MIGRATIONS);

  const colunas = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[])
    .map((c) => c.name);

  for (const esperada of [
    'id', 'fila', 'kind', 'tarefa', 'input', 'prioridade', 'status',
    'tentativas', 'max_tentativas', 'lease_ate', 'disponivel_em',
    'idem_key', 'flow_ref', 'chat_id', 'motor', 'modelo', 'esforco',
    'resultado', 'erro', 'criado_em', 'iniciado_em', 'terminado_em',
  ]) {
    expect(colunas, `falta coluna ${esperada}`).toContain(esperada);
  }

  const indices = (db.prepare('PRAGMA index_list(jobs)').all() as { name: string }[])
    .map((i) => i.name);
  expect(indices).toContain('idx_jobs_claim');
  expect(indices).toContain('idx_jobs_flow_ref');
  db.close();
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/db/schema-001.test.ts`
Esperado: FAIL — `PRAGMA table_info(jobs)` devolve lista vazia, então `toContain('id')` falha.

- [ ] **Step 3: Criar `src/fila/types.ts`**

```ts
// Contratos da fila. Sem dependência de gateway, fluxos ou Telegram.

export type Fila = 'render' | 'navegador' | 'texto' | 'io' | 'cpu';
export type Kind = 'agent' | 'function';
export type StatusJob = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/** Relógio injetável (segundos epoch). Nada no sistema chama Date.now() direto. */
export type Agora = () => number;

/** Perfil de execução efetivo de um job — ver src/dominio/perfil.ts e docs/perfil-de-execucao.md. */
export interface Perfil {
  motor: string;
  modelo: string;
  esforco: string;
}

export interface Job {
  id: number;
  fila: Fila;
  kind: Kind;
  tarefa: string;
  input: string;
  prioridade: number;
  status: StatusJob;
  tentativas: number;
  max_tentativas: number;
  lease_ate: number | null;
  disponivel_em: number;
  /** Chave de idempotência: identifica o EFEITO, não a tentativa. Ver spec §2.5. */
  idem_key: string | null;
  /** "P#16/mulheres/render" quando o job é fase de fluxo; null em job solto. */
  flow_ref: string | null;
  chat_id: number | null;
  motor: string | null;
  modelo: string | null;
  esforco: string | null;
  resultado: string | null;
  erro: string | null;
  criado_em: number;
  iniciado_em: number | null;
  terminado_em: number | null;
}

export interface NovoJob {
  fila: Fila;
  kind: Kind;
  tarefa: string;
  input: string;
  prioridade?: number;
  max_tentativas?: number;
  disponivel_em?: number;
  idem_key?: string | null;
  flow_ref?: string | null;
  chat_id?: number | null;
  perfil?: Perfil | null;
}
```

- [ ] **Step 4: Preencher `MIGRATIONS` em `src/db/migrations.ts`**

Substituir `export const MIGRATIONS: Migration[] = [];` por:

```ts
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    nome: 'jobs',
    sql: `
      CREATE TABLE jobs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        fila           TEXT    NOT NULL,
        kind           TEXT    NOT NULL,
        tarefa         TEXT    NOT NULL,
        input          TEXT    NOT NULL,
        prioridade     INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'queued',
        tentativas     INTEGER NOT NULL DEFAULT 0,
        max_tentativas INTEGER NOT NULL DEFAULT 1,
        lease_ate      INTEGER,
        disponivel_em  INTEGER NOT NULL DEFAULT 0,
        idem_key       TEXT,
        flow_ref       TEXT,
        chat_id        INTEGER,
        motor          TEXT,
        modelo         TEXT,
        esforco        TEXT,
        resultado      TEXT,
        erro           TEXT,
        criado_em      INTEGER NOT NULL,
        iniciado_em    INTEGER,
        terminado_em   INTEGER
      );
      CREATE INDEX idx_jobs_claim
        ON jobs (fila, status, disponivel_em, prioridade DESC, id);
      CREATE INDEX idx_jobs_flow_ref ON jobs (flow_ref);
      CREATE INDEX idx_jobs_idem_key ON jobs (idem_key);
    `,
  },
];
```

- [ ] **Step 5: Rodar e confirmar que passa**

Rodar: `npx vitest run`
Esperado: todos PASS (migrations + schema-001).

- [ ] **Step 6: Commit**

```bash
git add src/fila/types.ts src/db/migrations.ts src/db/schema-001.test.ts
git commit -m "feat(fila): tipos da fila e migration 001 (tabela jobs)"
```

---

### Task 4: Store — enfileirar, obter, listar

**Files:**
- Create: `src/fila/store.ts`, `src/fila/store.test.ts`

**Interfaces:**
- Consumes: `abrirDb`, `aplicarMigrations`, tipos de `src/fila/types.ts`
- Produces:
  - `class FilaSqlite`, construtor `(db: Database.Database, agora: Agora)`
  - `enfileirar(n: NovoJob): Job`
  - `obter(id: number): Job | undefined`
  - `listar(filtro?: { fila?: Fila; status?: StatusJob }): Job[]`
  - `criarFilaEmMemoriaDeTeste(dir: string): { fila: FilaSqlite; db: Database.Database; setAgora(t: number): void }`
    em `src/fila/store.test.ts` — helper local, não exportado do módulo de produção

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/fila/store.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

function novaFila(): FilaSqlite {
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  return new FilaSqlite(db, () => t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  fila = novaFila();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('enfileirar', () => {
  it('grava com defaults e devolve o job criado', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
    expect(job.id).toBe(1);
    expect(job.status).toBe('queued');
    expect(job.prioridade).toBe(0);
    expect(job.max_tentativas).toBe(1);
    expect(job.tentativas).toBe(0);
    expect(job.disponivel_em).toBe(1_000);
    expect(job.criado_em).toBe(1_000);
    expect(job.lease_ate).toBeNull();
  });

  it('grava campos opcionais, inclusive o perfil de execução', () => {
    const job = fila.enfileirar({
      fila: 'render', kind: 'agent', tarefa: 'explicativo', input: 'RAG',
      prioridade: 5, max_tentativas: 3, disponivel_em: 1_500,
      idem_key: 'P#16/mulheres/render', flow_ref: 'P#16/mulheres/render', chat_id: 42,
      perfil: { motor: 'claude', modelo: 'sonnet', esforco: 'low' },
    });
    expect(job.prioridade).toBe(5);
    expect(job.max_tentativas).toBe(3);
    expect(job.disponivel_em).toBe(1_500);
    expect(job.idem_key).toBe('P#16/mulheres/render');
    expect(job.flow_ref).toBe('P#16/mulheres/render');
    expect(job.chat_id).toBe(42);
    expect(job.motor).toBe('claude');
    expect(job.modelo).toBe('sonnet');
    expect(job.esforco).toBe('low');
  });
});

describe('obter e listar', () => {
  it('obter devolve undefined para id inexistente', () => {
    expect(fila.obter(999)).toBeUndefined();
  });

  it('listar filtra por fila e por status', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'b', input: '' });
    expect(fila.listar().length).toBe(2);
    expect(fila.listar({ fila: 'io' }).map((j) => j.tarefa)).toEqual(['a']);
    expect(fila.listar({ status: 'done' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/store.test.ts`
Esperado: FAIL — `Cannot find module './store.js'`.

- [ ] **Step 3: Implementar `src/fila/store.ts`**

```ts
// Store da fila sobre better-sqlite3. Nenhum conhecimento de Telegram, fluxo ou
// skill: recebe NovoJob, devolve Job. O relógio vem por injeção (`agora`).
import type Database from 'better-sqlite3';

import type { Agora, Fila, Job, NovoJob, StatusJob } from './types.js';

export class FilaSqlite {
  constructor(
    private readonly db: Database.Database,
    private readonly agora: Agora,
  ) {}

  enfileirar(n: NovoJob): Job {
    const agora = this.agora();
    const info = this.db
      .prepare(
        `INSERT INTO jobs
           (fila, kind, tarefa, input, prioridade, max_tentativas, disponivel_em,
            idem_key, flow_ref, chat_id, motor, modelo, esforco, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n.fila,
        n.kind,
        n.tarefa,
        n.input,
        n.prioridade ?? 0,
        n.max_tentativas ?? 1,
        n.disponivel_em ?? agora,
        n.idem_key ?? null,
        n.flow_ref ?? null,
        n.chat_id ?? null,
        n.perfil?.motor ?? null,
        n.perfil?.modelo ?? null,
        n.perfil?.esforco ?? null,
        agora,
      );
    const job = this.obter(Number(info.lastInsertRowid));
    if (!job) throw new Error('enfileirar: job não encontrado após INSERT');
    return job;
  }

  obter(id: number): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
  }

  listar(filtro: { fila?: Fila; status?: StatusJob } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filtro.fila) { where.push('fila = ?'); args.push(filtro.fila); }
    if (filtro.status) { where.push('status = ?'); args.push(filtro.status); }
    const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id`;
    return this.db.prepare(sql).all(...args) as Job[];
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/store.test.ts`
Esperado: 4 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fila/store.ts src/fila/store.test.ts
git commit -m "feat(fila): store com enfileirar/obter/listar"
```

---

### Task 5: Claim atômico (prioridade, agendamento, concorrência)

**Files:**
- Modify: `src/fila/store.ts`
- Create: `src/fila/claim.test.ts`

**Interfaces:**
- Consumes: `FilaSqlite` (Task 4)
- Produces:
  - `FilaSqlite.pegar(fila: Fila, leaseSegundos: number): Job | undefined` — claim atômico;
    marca `running`, incrementa `tentativas`, define `lease_ate = agora + leaseSegundos` e
    `iniciado_em`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/fila/claim.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let caminho: string;
let t = 1_000;

function conectar(): FilaSqlite {
  const db = abrirDb(caminho);
  aplicarMigrations(db, () => t, MIGRATIONS);
  return new FilaSqlite(db, () => t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  caminho = join(dir, 'fila.db');
  t = 1_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pegar', () => {
  it('marca running, incrementa tentativas e define lease', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60);
    expect(job?.status).toBe('running');
    expect(job?.tentativas).toBe(1);
    expect(job?.lease_ate).toBe(1_060);
    expect(job?.iniciado_em).toBe(1_000);
  });

  it('respeita a fila pedida', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '' });
    expect(fila.pegar('io', 60)).toBeUndefined();
    expect(fila.pegar('render', 60)?.tarefa).toBe('a');
  });

  it('ordena por prioridade DESC e depois por id ASC', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'primeiro', input: '' });
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'furou', input: '', prioridade: 10 });
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'segundo', input: '' });
    expect(fila.pegar('io', 60)?.tarefa).toBe('furou');
    expect(fila.pegar('io', 60)?.tarefa).toBe('primeiro');
    expect(fila.pegar('io', 60)?.tarefa).toBe('segundo');
  });

  it('não pega job agendado para o futuro', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'depois', input: '', disponivel_em: 2_000 });
    expect(fila.pegar('io', 60)).toBeUndefined();
    t = 2_000;
    expect(fila.pegar('io', 60)?.tarefa).toBe('depois');
  });

  it('devolve undefined com a fila vazia', () => {
    expect(conectar().pegar('io', 60)).toBeUndefined();
  });

  it('duas conexões concorrentes: só uma pega o mesmo job', () => {
    const a = conectar();
    const b = conectar();
    a.enfileirar({ fila: 'io', kind: 'function', tarefa: 'unico', input: '' });
    const pegos = [a.pegar('io', 60), b.pegar('io', 60)].filter(Boolean);
    expect(pegos).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/claim.test.ts`
Esperado: FAIL — `fila.pegar is not a function`.

- [ ] **Step 3: Implementar `pegar` em `src/fila/store.ts`**

Adicionar dentro da classe `FilaSqlite`:

```ts
  /**
   * Claim ATÔMICO: um único UPDATE ... WHERE id = (SELECT ...) RETURNING *.
   * Fazer SELECT e depois UPDATE (como o mkivideos faz hoje) permite que dois
   * workers peguem o mesmo job. Ordem: prioridade DESC, id ASC (FIFO dentro da
   * mesma prioridade). `disponivel_em` cobre poll, backoff e agendamento.
   */
  pegar(fila: Fila, leaseSegundos: number): Job | undefined {
    const agora = this.agora();
    return this.db
      .prepare(
        `UPDATE jobs
            SET status = 'running',
                tentativas = tentativas + 1,
                lease_ate = ?,
                iniciado_em = COALESCE(iniciado_em, ?)
          WHERE id = (SELECT id FROM jobs
                       WHERE fila = ? AND status = 'queued' AND disponivel_em <= ?
                       ORDER BY prioridade DESC, id ASC
                       LIMIT 1)
        RETURNING *`,
      )
      .get(agora + leaseSegundos, agora, fila, agora) as Job | undefined;
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/claim.test.ts`
Esperado: 6 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fila/store.ts src/fila/claim.test.ts
git commit -m "feat(fila): claim atômico com prioridade e disponivel_em"
```

---

### Task 6: Lease — heartbeat, expiração e recuperação no boot

**Files:**
- Modify: `src/fila/store.ts`
- Create: `src/fila/lease.test.ts`

**Interfaces:**
- Consumes: `FilaSqlite.pegar` (Task 5)
- Produces:
  - `FilaSqlite.renovar(id: number, leaseSegundos: number): boolean` — só renova job `running`
  - `FilaSqlite.recuperarLeasesVencidos(): number` — `running` com `lease_ate <= agora` volta a
    `queued` (mantém `tentativas`), devolve quantos recuperou

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/fila/lease.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('renovar', () => {
  it('empurra o lease_ate de um job em execução', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    t = 1_050;
    expect(fila.renovar(job.id, 60)).toBe(true);
    expect(fila.obter(job.id)!.lease_ate).toBe(1_110);
  });

  it('não renova job que não está running', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    expect(fila.renovar(job.id, 60)).toBe(false);
  });
});

describe('recuperarLeasesVencidos', () => {
  it('devolve à fila o job cujo lease venceu, preservando tentativas', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 3 });
    const job = fila.pegar('render', 60)!;
    expect(job.tentativas).toBe(1);

    t = 1_061;
    expect(fila.recuperarLeasesVencidos()).toBe(1);

    const depois = fila.obter(job.id)!;
    expect(depois.status).toBe('queued');
    expect(depois.tentativas).toBe(1);
    expect(depois.lease_ate).toBeNull();
    expect(fila.pegar('render', 60)!.tentativas).toBe(2);
  });

  it('não mexe em job com lease vivo', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.pegar('io', 60);
    t = 1_030;
    expect(fila.recuperarLeasesVencidos()).toBe(0);
  });

  it('não mexe em job terminal', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.pegar('io', 60);
    t = 5_000;
    fila.recuperarLeasesVencidos();
    expect(fila.recuperarLeasesVencidos()).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/lease.test.ts`
Esperado: FAIL — `fila.renovar is not a function`.

- [ ] **Step 3: Implementar `renovar` e `recuperarLeasesVencidos` em `src/fila/store.ts`**

```ts
  /**
   * Heartbeat: empurra o lease enquanto o trabalho está vivo. Obrigatório em job
   * longo (render de ~15 min) e durante o drain — soltar lease com o processo
   * vivo é exatamente o que permitiria dupla execução (spec §1.3).
   */
  renovar(id: number, leaseSegundos: number): boolean {
    const r = this.db
      .prepare(`UPDATE jobs SET lease_ate = ? WHERE id = ? AND status = 'running'`)
      .run(this.agora() + leaseSegundos, id);
    return r.changes === 1;
  }

  /**
   * Devolve à fila todo job `running` com lease vencido (worker morto, kill -9,
   * queda de energia). `tentativas` NÃO é zerado: o job já consumiu uma.
   */
  recuperarLeasesVencidos(): number {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_ate = NULL
          WHERE status = 'running' AND lease_ate IS NOT NULL AND lease_ate <= ?`,
      )
      .run(this.agora());
    return r.changes;
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/lease.test.ts`
Esperado: 5 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fila/store.ts src/fila/lease.test.ts
git commit -m "feat(fila): lease com heartbeat e recuperação de lease vencido"
```

---

### Task 7: Ack — done, failed com backoff, cancelamento que bloqueia done

**Files:**
- Modify: `src/fila/store.ts`
- Create: `src/fila/ack.test.ts`

**Interfaces:**
- Consumes: `FilaSqlite.pegar` (Task 5)
- Produces:
  - `FilaSqlite.concluir(id: number, resultado: string): boolean` — só de `running`; devolve
    `false` se o job foi cancelado no meio
  - `FilaSqlite.falhar(id: number, erro: string, backoffBase?: number): 'requeued' | 'failed'`
  - `FilaSqlite.cancelar(id: number): boolean` — de `queued` ou `running`
  - `FilaSqlite.reagendar(id: number, emSegundos: number): boolean` — para poll (`espera`)

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/fila/ack.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('concluir', () => {
  it('marca done com resultado e terminado_em', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    t = 1_010;
    expect(fila.concluir(job.id, '/saida.mp4')).toBe(true);
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('done');
    expect(d.resultado).toBe('/saida.mp4');
    expect(d.terminado_em).toBe(1_010);
  });

  it('REJEITA done depois de cancelado', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    expect(fila.cancelar(job.id)).toBe(true);
    expect(fila.concluir(job.id, 'x')).toBe(false);
    expect(fila.obter(job.id)!.status).toBe('canceled');
  });
});

describe('falhar', () => {
  it('reenfileira com backoff exponencial enquanto há tentativa', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 3 });
    const job = fila.pegar('render', 60)!;           // tentativas = 1
    expect(fila.falhar(job.id, 'boom', 10)).toBe('requeued');
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('queued');
    expect(d.erro).toBe('boom');
    expect(d.disponivel_em).toBe(1_010);             // 10 * 2^(1-1) = 10
    expect(d.lease_ate).toBeNull();
  });

  it('backoff cresce com a tentativa', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 4 });
    const job = fila.pegar('render', 60)!;
    fila.falhar(job.id, 'e1', 10);
    t = 1_010;
    fila.pegar('render', 60);                        // tentativas = 2
    fila.falhar(job.id, 'e2', 10);
    expect(fila.obter(job.id)!.disponivel_em).toBe(1_030); // 1_010 + 10 * 2^(2-1)
  });

  it('esgotadas as tentativas, vira failed', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '', max_tentativas: 1 });
    const job = fila.pegar('io', 60)!;
    expect(fila.falhar(job.id, 'fim', 10)).toBe('failed');
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('failed');
    expect(d.terminado_em).toBe(1_000);
  });
});

describe('cancelar e reagendar', () => {
  it('cancela job na fila', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    expect(fila.cancelar(job.id)).toBe(true);
    expect(fila.obter(job.id)!.status).toBe('canceled');
  });

  it('não cancela job terminal', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    fila.concluir(job.id, 'ok');
    expect(fila.cancelar(job.id)).toBe(false);
  });

  it('reagenda para poll sem gastar tentativa', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'poll', input: '' });
    const job = fila.pegar('io', 60)!;
    expect(fila.reagendar(job.id, 120)).toBe(true);
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('queued');
    expect(d.disponivel_em).toBe(1_120);
    expect(d.tentativas).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/ack.test.ts`
Esperado: FAIL — `fila.concluir is not a function`.

- [ ] **Step 3: Implementar em `src/fila/store.ts`**

```ts
  /**
   * Fecha o job como done. O `AND status = 'running'` é a proteção contra a
   * corrida "cancelei, mas o worker terminou depois": job cancelado NUNCA vira
   * done (spec §3.7).
   */
  concluir(id: number, resultado: string): boolean {
    const agora = this.agora();
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'done', resultado = ?, erro = NULL,
                         lease_ate = NULL, terminado_em = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(resultado, agora, id);
    return r.changes === 1;
  }

  /**
   * Falha o job. Se ainda há tentativa, volta pra fila com backoff exponencial
   * (base * 2^(tentativas-1)); senão vira `failed`. Nunca reabre job cancelado.
   */
  falhar(id: number, erro: string, backoffBase = 30): 'requeued' | 'failed' {
    const agora = this.agora();
    return this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM jobs WHERE id = ? AND status = 'running'`)
        .get(id) as Job | undefined;
      if (!job) return 'failed';

      if (job.tentativas < job.max_tentativas) {
        const espera = backoffBase * 2 ** (job.tentativas - 1);
        this.db
          .prepare(
            `UPDATE jobs SET status = 'queued', erro = ?, lease_ate = NULL, disponivel_em = ?
              WHERE id = ?`,
          )
          .run(erro, agora + espera, id);
        return 'requeued';
      }
      this.db
        .prepare(
          `UPDATE jobs SET status = 'failed', erro = ?, lease_ate = NULL, terminado_em = ?
            WHERE id = ?`,
        )
        .run(erro, agora, id);
      return 'failed';
    })();
  }

  /** Cancela job pendente ou em execução. Job terminal não é cancelável. */
  cancelar(id: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'canceled', lease_ate = NULL, terminado_em = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(this.agora(), id);
    return r.changes === 1;
  }

  /**
   * Devolve o job à fila para nova checagem em `emSegundos` SEM gastar tentativa
   * — é o mecanismo de poll das fases com `espera` (spec §3.2).
   */
  reagendar(id: number, emSegundos: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_ate = NULL, disponivel_em = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(this.agora() + emSegundos, id);
    return r.changes === 1;
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/ack.test.ts`
Esperado: 8 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fila/store.ts src/fila/ack.test.ts
git commit -m "feat(fila): ack com backoff, cancelamento que bloqueia done e reagendamento de poll"
```

---

### Task 8: Idempotência — não repetir efeito externo

**Files:**
- Modify: `src/fila/store.ts`
- Create: `src/fila/idempotencia.test.ts`

**Interfaces:**
- Consumes: `FilaSqlite` (Tasks 4-7)
- Produces:
  - `FilaSqlite.jaConcluido(idemKey: string): Job | undefined` — job `done` com essa chave
  - `FilaSqlite.enfileirarSeNovo(n: NovoJob): { job: Job; novo: boolean }` — não duplica quando já
    existe job com o mesmo `idem_key` em estado não terminal ou `done`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/fila/idempotencia.test.ts
// Lease garante claim único; NÃO garante efeito único. O cenário real: o worker
// cria o vídeo no HeyGen, morre antes do ack, o lease vence, outro worker roda a
// mesma fase — e criaria um SEGUNDO vídeo. A defesa é a chave de idempotência
// (spec §2.5): a tarefa procura antes de criar.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CHAVE = 'P#16/mulheres/render';

describe('enfileirarSeNovo', () => {
  it('enfileira na primeira vez', () => {
    const r = fila.enfileirarSeNovo({
      fila: 'navegador', kind: 'agent', tarefa: 'fluxo-navegador', input: '', idem_key: CHAVE,
    });
    expect(r.novo).toBe(true);
  });

  it('não duplica job pendente com a mesma chave', () => {
    fila.enfileirarSeNovo({ fila: 'navegador', kind: 'agent', tarefa: 'x', input: '', idem_key: CHAVE });
    const r = fila.enfileirarSeNovo({ fila: 'navegador', kind: 'agent', tarefa: 'x', input: '', idem_key: CHAVE });
    expect(r.novo).toBe(false);
    expect(fila.listar()).toHaveLength(1);
  });

  it('não reenfileira o que já está done', () => {
    const p = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    fila.pegar('io', 60);
    fila.concluir(p.job.id, 'ok');
    const r = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    expect(r.novo).toBe(false);
    expect(r.job.status).toBe('done');
  });

  it('DEIXA reenfileirar depois de failed (retry manual é legítimo)', () => {
    const p = fila.enfileirarSeNovo({
      fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE, max_tentativas: 1,
    });
    fila.pegar('io', 60);
    fila.falhar(p.job.id, 'boom', 10);
    const r = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    expect(r.novo).toBe(true);
  });

  it('sem idem_key sempre enfileira', () => {
    fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '' });
    fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '' });
    expect(fila.listar()).toHaveLength(2);
  });
});

describe('jaConcluido', () => {
  it('permite a tarefa ADOTAR o efeito de uma execução anterior', () => {
    // simula: worker criou o render, gravou o resultado, e MORREU antes do ack final
    const p = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    fila.pegar('io', 60);
    fila.concluir(p.job.id, 'heygen:video-abc');

    expect(fila.jaConcluido(CHAVE)?.resultado).toBe('heygen:video-abc');
    expect(fila.jaConcluido('outra/chave')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/idempotencia.test.ts`
Esperado: FAIL — `fila.enfileirarSeNovo is not a function`.

- [ ] **Step 3: Implementar em `src/fila/store.ts`**

```ts
  /** Job já concluído com essa chave de idempotência — a tarefa pode adotar o resultado. */
  jaConcluido(idemKey: string): Job | undefined {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE idem_key = ? AND status = 'done' ORDER BY id DESC LIMIT 1`,
      )
      .get(idemKey) as Job | undefined;
  }

  /**
   * Enfileira só se não houver job com a mesma `idem_key` já concluído ou em voo.
   * `failed`/`canceled` NÃO bloqueiam: retentar é legítimo (é o que /refazer faz).
   */
  enfileirarSeNovo(n: NovoJob): { job: Job; novo: boolean } {
    if (!n.idem_key) return { job: this.enfileirar(n), novo: true };
    return this.db.transaction(() => {
      const existente = this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE idem_key = ? AND status IN ('queued', 'running', 'done')
            ORDER BY id DESC LIMIT 1`,
        )
        .get(n.idem_key) as Job | undefined;
      if (existente) return { job: existente, novo: false };
      return { job: this.enfileirar(n), novo: true };
    })();
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/idempotencia.test.ts`
Esperado: 6 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fila/store.ts src/fila/idempotencia.test.ts
git commit -m "feat(fila): idempotência por idem_key (não repete efeito externo)"
```

---

### Task 9: Perfil de execução — motor, modelo e esforço em config

**Files:**
- Create: `src/dominio/perfil.ts`, `src/dominio/perfil.test.ts`

**Interfaces:**
- Consumes: `Perfil` de `src/fila/types.ts` (Task 3)
- Produces:
  - `MODELOS_RANK: Record<string, number>` e `ESFORCOS_RANK: Record<string, number>`
  - `interface PerfilParcial { motor?: string; modelo?: string; esforco?: string }`
  - `interface DeclaracaoSkill { sugere?: PerfilParcial; exige?: PerfilParcial }`
  - `interface FontesPerfil { override?: PerfilParcial; fase?: PerfilParcial; registry?: PerfilParcial; skill?: DeclaracaoSkill; padrao: Perfil }`
  - `interface ResolucaoPerfil { perfil: Perfil; avisos: string[] }`
  - `resolverPerfil(f: FontesPerfil): ResolucaoPerfil`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/dominio/perfil.test.ts
import { describe, expect, it } from 'vitest';

import { resolverPerfil, type FontesPerfil } from './perfil.js';

const padrao = { motor: 'claude', modelo: 'sonnet', esforco: 'low' };
const base: FontesPerfil = { padrao };

describe('precedência', () => {
  it('sem nenhuma fonte, usa o padrão', () => {
    expect(resolverPerfil(base).perfil).toEqual(padrao);
  });

  it('sugestão da skill vence o padrão', () => {
    const { perfil } = resolverPerfil({ ...base, skill: { sugere: { modelo: 'opus' } } });
    expect(perfil.modelo).toBe('opus');
  });

  it('registry vence a sugestão da skill', () => {
    const { perfil } = resolverPerfil({
      ...base, skill: { sugere: { modelo: 'opus' } }, registry: { modelo: 'haiku' },
    });
    expect(perfil.modelo).toBe('haiku');
  });

  it('fase vence o registry', () => {
    const { perfil } = resolverPerfil({
      ...base, registry: { esforco: 'low' }, fase: { esforco: 'high' },
    });
    expect(perfil.esforco).toBe('high');
  });

  it('override do comando vence tudo', () => {
    const { perfil } = resolverPerfil({
      ...base, registry: { modelo: 'haiku' }, fase: { modelo: 'sonnet' },
      override: { modelo: 'opus' },
    });
    expect(perfil.modelo).toBe('opus');
  });

  it('mistura fontes campo a campo', () => {
    const { perfil } = resolverPerfil({
      ...base, registry: { modelo: 'opus' }, fase: { esforco: 'high' },
      override: { motor: 'codex' },
    });
    expect(perfil).toEqual({ motor: 'codex', modelo: 'opus', esforco: 'high' });
  });
});

describe('piso declarado pela skill (exige)', () => {
  it('eleva o modelo quando o resolvido é mais fraco que o exigido', () => {
    const { perfil, avisos } = resolverPerfil({
      ...base, skill: { exige: { modelo: 'opus' } }, registry: { modelo: 'haiku' },
    });
    expect(perfil.modelo).toBe('opus');
    expect(avisos.join(' ')).toMatch(/exige modelo opus/i);
  });

  it('eleva o esforço quando o resolvido é mais fraco', () => {
    const { perfil } = resolverPerfil({ ...base, skill: { exige: { esforco: 'high' } } });
    expect(perfil.esforco).toBe('high');
  });

  it('não rebaixa quando o resolvido é mais forte que o piso', () => {
    const { perfil } = resolverPerfil({
      ...base, skill: { exige: { modelo: 'sonnet' } }, registry: { modelo: 'opus' },
    });
    expect(perfil.modelo).toBe('opus');
  });

  it('override EXPLÍCITO do operador vence o piso, mas avisa', () => {
    const { perfil, avisos } = resolverPerfil({
      ...base, skill: { exige: { modelo: 'opus' } }, override: { modelo: 'haiku' },
    });
    expect(perfil.modelo).toBe('haiku');
    expect(avisos.join(' ')).toMatch(/abaixo do exigido/i);
  });

  it('motor exigido é obrigatório e não é rebaixável por registry', () => {
    const { perfil } = resolverPerfil({
      ...base, skill: { exige: { motor: 'claude' } }, registry: { motor: 'codex' },
    });
    expect(perfil.motor).toBe('claude');
  });
});

describe('validação', () => {
  it('rejeita modelo desconhecido', () => {
    expect(() => resolverPerfil({ ...base, override: { modelo: 'gpt-inventado' } }))
      .toThrow(/modelo desconhecido/i);
  });

  it('rejeita esforço desconhecido', () => {
    expect(() => resolverPerfil({ ...base, override: { esforco: 'turbo' } }))
      .toThrow(/esforço desconhecido/i);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/dominio/perfil.test.ts`
Esperado: FAIL — `Cannot find module './perfil.js'`.

- [ ] **Step 3: Implementar `src/dominio/perfil.ts`**

```ts
// Perfil de execução = { motor, modelo, esforco }.
//
// No v1 isso era hardcoded em DOIS lugares (`mkivideos/src/cli-lib.ts:171` com
// `--model sonnet --effort low` para toda skill de render, e
// `inemaccvbot/src/interpret.ts` com opus/low), então tarefas de dificuldade
// muito diferente compartilhavam perfil por acidente e mudar exigia recompilar.
//
// Aqui é CONFIGURAÇÃO, resolvida por precedência, e o perfil efetivo é gravado
// no job — quando um render sai ruim, o log diz com que modelo rodou.
// Documentação de uso e de portabilidade: docs/perfil-de-execucao.md
import type { Perfil } from '../fila/types.js';

/** Ranking de capacidade. Usado só para comparar (piso de `exige`), nunca para escolher sozinho. */
export const MODELOS_RANK: Record<string, number> = {
  haiku: 1,
  fable: 2,
  sonnet: 3,
  opus: 4,
};

export const ESFORCOS_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export interface PerfilParcial {
  motor?: string;
  modelo?: string;
  esforco?: string;
}

/**
 * O que a própria skill declara sobre o que precisa (lido do SKILL.md / do
 * registry da skill):
 * - `sugere`: preferência fraca — perde de registry, fase e override
 * - `exige`: PISO — eleva o resultado se ele vier mais fraco; só um override
 *   explícito do operador consegue furar, e isso gera aviso
 */
export interface DeclaracaoSkill {
  sugere?: PerfilParcial;
  exige?: PerfilParcial;
}

export interface FontesPerfil {
  /** 1 — override pontual no comando: `| modelo=opus` */
  override?: PerfilParcial;
  /** 2 — fase do flow.json */
  fase?: PerfilParcial;
  /** 3 — entrada do registry (skills.json / fluxos.json) */
  registry?: PerfilParcial;
  /** 4 — o que a skill declara */
  skill?: DeclaracaoSkill;
  /** 5 — default do .env */
  padrao: Perfil;
}

export interface ResolucaoPerfil {
  perfil: Perfil;
  avisos: string[];
}

function primeiro(campo: keyof PerfilParcial, fontes: (PerfilParcial | undefined)[]): string | undefined {
  for (const f of fontes) {
    const v = f?.[campo];
    if (v !== undefined) return v;
  }
  return undefined;
}

function validar(p: Perfil): void {
  if (MODELOS_RANK[p.modelo] === undefined) {
    throw new Error(`modelo desconhecido: ${p.modelo} (conhecidos: ${Object.keys(MODELOS_RANK).join(', ')})`);
  }
  if (ESFORCOS_RANK[p.esforco] === undefined) {
    throw new Error(`esforço desconhecido: ${p.esforco} (conhecidos: ${Object.keys(ESFORCOS_RANK).join(', ')})`);
  }
}

export function resolverPerfil(f: FontesPerfil): ResolucaoPerfil {
  const ordem = [f.override, f.fase, f.registry, f.skill?.sugere];
  const perfil: Perfil = {
    motor: primeiro('motor', ordem) ?? f.padrao.motor,
    modelo: primeiro('modelo', ordem) ?? f.padrao.modelo,
    esforco: primeiro('esforco', ordem) ?? f.padrao.esforco,
  };
  validar(perfil);

  const avisos: string[] = [];
  const exige = f.skill?.exige;
  if (exige) {
    if (exige.motor && perfil.motor !== exige.motor) {
      if (f.override?.motor === perfil.motor) {
        avisos.push(`override usa motor ${perfil.motor}, mas a skill exige ${exige.motor}`);
      } else {
        perfil.motor = exige.motor;
        avisos.push(`skill exige motor ${exige.motor} — aplicado`);
      }
    }
    for (const [campo, rank] of [['modelo', MODELOS_RANK], ['esforco', ESFORCOS_RANK]] as const) {
      const pedido = exige[campo];
      if (!pedido) continue;
      if (rank[pedido] === undefined) throw new Error(`skill exige ${campo} desconhecido: ${pedido}`);
      if (rank[perfil[campo]] >= rank[pedido]) continue;
      if (f.override?.[campo] === perfil[campo]) {
        avisos.push(`override usa ${campo} ${perfil[campo]}, abaixo do exigido pela skill (${pedido})`);
      } else {
        perfil[campo] = pedido;
        avisos.push(`skill exige ${campo} ${pedido} — elevado`);
      }
    }
    validar(perfil);
  }
  return { perfil, avisos };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/dominio/perfil.test.ts`
Esperado: 13 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dominio/perfil.ts src/dominio/perfil.test.ts
git commit -m "feat(dominio): resolução de perfil de execução (motor/modelo/esforço) por precedência"
```

---

### Task 10: `Runner` — interface, fake, e o runner do Claude

**Files:**
- Create: `src/fila/runner.ts`, `src/fila/runner.test.ts`, `src/fila/runner-claude.ts`,
  `src/fila/runner-claude.test.ts`

**Interfaces:**
- Consumes: `Perfil` (Task 3)
- Produces:
  - `interface ContextoExecucao { prompt: string; cwd: string; perfil: Perfil; vars: Record<string, string> }`
  - `interface Execucao { aguardar(): Promise<string>; cancelar(): Promise<void>; limpar(): Promise<void> }`
  - `interface Runner { nome: string; iniciar(ctx: ContextoExecucao): Execucao }`
  - `class FakeRunner implements Runner` — com `respostas`, `erros`, `cancelamentos`
  - `argumentosClaude(ctx: ContextoExecucao): string[]` (pura, testável sem processo)
  - `class ClaudeRunner implements Runner`
  - `RUNNERS: Record<string, Runner>` (registro por nome de motor)

- [ ] **Step 1: Escrever o teste que falha (interface + fake)**

```ts
// src/fila/runner.test.ts
import { describe, expect, it } from 'vitest';

import { FakeRunner } from './runner.js';

const ctx = {
  prompt: 'faça X', cwd: '/tmp', perfil: { motor: 'claude', modelo: 'sonnet', esforco: 'low' },
  vars: {},
};

describe('FakeRunner', () => {
  it('devolve a resposta programada e registra a chamada', async () => {
    const r = new FakeRunner({ respostas: ['ok'] });
    const exec = r.iniciar(ctx);
    await expect(exec.aguardar()).resolves.toBe('ok');
    expect(r.chamadas).toHaveLength(1);
    expect(r.chamadas[0].perfil.modelo).toBe('sonnet');
  });

  it('propaga erro programado', async () => {
    const r = new FakeRunner({ erros: ['boom'] });
    await expect(r.iniciar(ctx).aguardar()).rejects.toThrow('boom');
  });

  it('cancelar faz aguardar rejeitar com "cancelado" e conta o cancelamento', async () => {
    const r = new FakeRunner({ respostas: ['nunca'], travar: true });
    const exec = r.iniciar(ctx);
    const p = exec.aguardar();
    await exec.cancelar();
    await expect(p).rejects.toThrow(/cancelado/);
    expect(r.cancelamentos).toBe(1);
  });

  it('limpar é idempotente', async () => {
    const r = new FakeRunner({ respostas: ['ok'] });
    const exec = r.iniciar(ctx);
    await exec.aguardar();
    await exec.limpar();
    await exec.limpar();
    expect(r.limpezas).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/runner.test.ts`
Esperado: FAIL — `Cannot find module './runner.js'`.

- [ ] **Step 3: Implementar `src/fila/runner.ts`**

```ts
// Contrato de execução de UM job. O motor (Claude, Codex, …) é plugável: nada
// fora deste arquivo e dos runner-*.ts sabe qual agente está por baixo.
// Ver docs/perfil-de-execucao.md.
import type { Perfil } from './types.js';

export interface ContextoExecucao {
  prompt: string;
  cwd: string;
  perfil: Perfil;
  vars: Record<string, string>;
}

/** Uma execução em curso. `cancelar` encerra a ÁRVORE de processos (spec §3.7). */
export interface Execucao {
  aguardar(): Promise<string>;
  cancelar(): Promise<void>;
  limpar(): Promise<void>;
}

export interface Runner {
  nome: string;
  iniciar(ctx: ContextoExecucao): Execucao;
}

export interface FakeRunnerOpts {
  respostas?: string[];
  erros?: string[];
  /** Quando true, `aguardar` só resolve/rejeita depois de cancelar. */
  travar?: boolean;
}

/**
 * Runner de teste. É a SEGUNDA implementação da interface — por isso a costura
 * de motor plugável não custa nada: ela já é exigida pelos testes.
 */
export class FakeRunner implements Runner {
  nome = 'fake';
  chamadas: ContextoExecucao[] = [];
  cancelamentos = 0;
  limpezas = 0;

  constructor(private readonly opts: FakeRunnerOpts = {}) {}

  iniciar(ctx: ContextoExecucao): Execucao {
    this.chamadas.push(ctx);
    const resposta = this.opts.respostas?.shift();
    const erro = this.opts.erros?.shift();
    let rejeitarCancelado: ((e: Error) => void) | undefined;

    const aguardar = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        rejeitarCancelado = reject;
        if (this.opts.travar) return;
        if (erro !== undefined) reject(new Error(erro));
        else resolve(resposta ?? '');
      });

    return {
      aguardar,
      cancelar: async () => {
        this.cancelamentos += 1;
        rejeitarCancelado?.(new Error('cancelado'));
      },
      limpar: async () => { this.limpezas += 1; },
    };
  }
}

/** Registro de motores disponíveis, preenchido pelos runner-*.ts. */
export const RUNNERS: Record<string, Runner> = {};
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/runner.test.ts`
Esperado: 4 testes PASS.

- [ ] **Step 5: Escrever o teste do `ClaudeRunner`**

```ts
// src/fila/runner-claude.test.ts
import { describe, expect, it } from 'vitest';

import { ClaudeRunner, argumentosClaude } from './runner-claude.js';
import { RUNNERS } from './runner.js';

const ctx = (modelo: string, esforco: string) => ({
  prompt: 'faça X', cwd: '/tmp',
  perfil: { motor: 'claude', modelo, esforco }, vars: {},
});

describe('argumentosClaude', () => {
  it('traduz o perfil em flags da CLI, com o prompt por último', () => {
    expect(argumentosClaude(ctx('opus', 'high')))
      .toEqual(['--model', 'opus', '--effort', 'high', '-p', 'faça X']);
  });

  it('nunca usa shell: os argumentos são um array, sem interpolação', () => {
    const args = argumentosClaude({ ...ctx('sonnet', 'low'), prompt: 'rm -rf / ; echo oi' });
    expect(args[args.length - 1]).toBe('rm -rf / ; echo oi');
    expect(args.join(' ')).not.toContain('&&');
  });
});

describe('registro de motores', () => {
  it('registra "claude" em RUNNERS', () => {
    expect(RUNNERS.claude).toBeInstanceOf(ClaudeRunner);
    expect(RUNNERS.claude.nome).toBe('claude');
  });
});

describe('execução real de subprocesso (usa /bin/echo como binário)', () => {
  it('devolve o stdout', async () => {
    const r = new ClaudeRunner('/bin/echo');
    const saida = await r.iniciar(ctx('sonnet', 'low')).aguardar();
    expect(saida).toContain('--model sonnet');
  });

  it('cancelar mata a árvore e faz aguardar rejeitar', async () => {
    const r = new ClaudeRunner('/bin/sleep');
    const exec = r.iniciar({ ...ctx('sonnet', 'low'), prompt: '30' });
    const p = exec.aguardar();
    await exec.cancelar();
    await expect(p).rejects.toThrow(/cancelad/);
  });
});
```

- [ ] **Step 6: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/runner-claude.test.ts`
Esperado: FAIL — `Cannot find module './runner-claude.js'`.

- [ ] **Step 7: Implementar `src/fila/runner-claude.ts`**

```ts
// Runner do motor `claude`. Único lugar do sistema que conhece a CLI do Claude.
// Trocar de motor = escrever outro arquivo como este e registrá-lo em RUNNERS.
import { spawn } from 'node:child_process';

import { RUNNERS, type ContextoExecucao, type Execucao, type Runner } from './runner.js';

/**
 * Traduz o perfil de execução nas flags da CLI. Função pura de propósito: é o
 * ponto de comparação quando se escreve o runner de outro motor.
 */
export function argumentosClaude(ctx: ContextoExecucao): string[] {
  return ['--model', ctx.perfil.modelo, '--effort', ctx.perfil.esforco, '-p', ctx.prompt];
}

export class ClaudeRunner implements Runner {
  nome = 'claude';

  constructor(private readonly binario = 'claude') {}

  iniciar(ctx: ContextoExecucao): Execucao {
    // `detached: true` cria um process group próprio: cancelar mata a ÁRVORE
    // (o agente abre subprocessos), não só o pai. Nunca `shell: true`.
    const filho = spawn(this.binario, argumentosClaude(ctx), {
      cwd: ctx.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...ctx.vars },
    });

    let cancelado = false;
    let stdout = '';
    let stderr = '';
    filho.stdout?.on('data', (d) => { stdout += String(d); });
    filho.stderr?.on('data', (d) => { stderr += String(d); });

    const promessa = new Promise<string>((resolve, reject) => {
      filho.on('error', reject);
      filho.on('close', (code) => {
        if (cancelado) return reject(new Error('execução cancelada'));
        if (code === 0) return resolve(stdout.trim());
        reject(new Error(`${this.binario} saiu com código ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });

    const matarArvore = (sinal: NodeJS.Signals): void => {
      if (filho.pid === undefined) return;
      try { process.kill(-filho.pid, sinal); } catch { /* já morreu */ }
    };

    return {
      aguardar: () => promessa,
      cancelar: async () => {
        cancelado = true;
        matarArvore('SIGTERM');
        await new Promise((r) => setTimeout(r, 2_000));
        matarArvore('SIGKILL');
      },
      limpar: async () => { /* o runner do Claude não deixa parciais próprios */ },
    };
  }
}

RUNNERS.claude = new ClaudeRunner();
```

- [ ] **Step 8: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/runner-claude.test.ts`
Esperado: 5 testes PASS. (O teste de `cancelar` usa `/bin/sleep 30`; se o ambiente não tiver
`/bin/sleep`, ajustar para `/usr/bin/sleep` — verificar com `command -v sleep`.)

- [ ] **Step 9: Commit**

```bash
git add src/fila/runner.ts src/fila/runner.test.ts src/fila/runner-claude.ts src/fila/runner-claude.test.ts
git commit -m "feat(fila): interface Runner + FakeRunner + ClaudeRunner com kill de árvore"
```

---

### Task 11: Worker — loop por fila, concorrência e drain

**Files:**
- Create: `src/fila/worker.ts`, `src/fila/worker.test.ts`

**Interfaces:**
- Consumes: `FilaSqlite` (Tasks 4-8), `Runner`/`FakeRunner` (Task 10)
- Produces:
  - `type Tarefa = (job: Job) => Promise<string>` (para `kind=function`)
  - `interface WorkerOpts { fila: Fila; concorrencia: number; leaseSegundos: number; tarefas: Record<string, Tarefa>; runners: Record<string, Runner>; promptDe: (job: Job) => ContextoExecucao; log?: (m: string) => void }`
  - `class Worker` com `passo(): Promise<boolean>` (processa no máximo um job; devolve se pegou),
    `bater(): Promise<void>`, `drenar(): Promise<void>`, `abortar(): Promise<void>`,
    `get emVoo(): number`

> **Correção da revisão 2 do plano (decidida pelo dono em 2026-07-30):** a versão anterior listava
> `iniciar()` e um campo `heartbeatSegundos` que o código do Step 3 nunca usava — config morta. O
> `Worker` fica um *stepper* puro, sem nenhum timer: quem agenda o laço de `passo()`, o `bater()`
> periódico e o `SIGTERM` → `drenar()` é o `src/index.ts`, na etapa 1. Isso mantém a etapa 0 sem um
> único teste dependente de tempo real, e é coerente com o que este plano já diz sobre
> `recuperarLeasesVencidos()` e `drenar()`/`abortar()` serem ligados na etapa 1.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/fila/worker.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';
import { FakeRunner } from './runner.js';
import { Worker } from './worker.js';
import type { Job } from './types.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

function novoWorker(over: Partial<ConstructorParameters<typeof Worker>[1]> = {}): Worker {
  return new Worker(fila, {
    fila: 'io', concorrencia: 1, leaseSegundos: 60, heartbeatSegundos: 20,
    tarefas: { ok: async () => 'pronto', explode: async () => { throw new Error('boom'); } },
    runners: { fake: new FakeRunner({ respostas: ['saida do agente'] }) },
    promptDe: (job: Job) => ({
      prompt: job.input, cwd: '/tmp',
      perfil: { motor: job.motor ?? 'fake', modelo: job.modelo ?? 'sonnet', esforco: job.esforco ?? 'low' },
      vars: {},
    }),
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('passo', () => {
  it('executa tarefa function e conclui o job', async () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '' });
    expect(await novoWorker().passo()).toBe(true);
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('done');
    expect(d.resultado).toBe('pronto');
  });

  it('executa job agent pelo runner do motor gravado no job', async () => {
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'qualquer', input: 'prompt',
      perfil: { motor: 'fake', modelo: 'opus', esforco: 'high' },
    });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.resultado).toBe('saida do agente');
  });

  it('falha o job quando a tarefa lança', async () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'explode', input: '' });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.status).toBe('failed');
    expect(fila.obter(job.id)!.erro).toContain('boom');
  });

  it('falha o job quando a tarefa não existe no catálogo', async () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'inexistente', input: '' });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.erro).toMatch(/tarefa desconhecida/i);
  });

  it('falha o job quando o motor não está registrado', async () => {
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '',
      perfil: { motor: 'motor-que-nao-existe', modelo: 'sonnet', esforco: 'low' },
    });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.erro).toMatch(/motor desconhecido/i);
  });

  it('devolve false quando não há nada na fila', async () => {
    expect(await novoWorker().passo()).toBe(false);
  });
});

describe('drain', () => {
  it('para de pegar novos jobs, mas termina o que está em voo', async () => {
    let liberar: (() => void) | undefined;
    const w = novoWorker({
      tarefas: { lento: () => new Promise<string>((r) => { liberar = () => r('fim'); }) },
    });
    const j1 = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });
    const j2 = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });

    const emCurso = w.passo();
    const drenando = w.drenar();
    expect(await w.passo()).toBe(false);            // drain: não pega mais

    liberar!();
    await emCurso;
    await drenando;

    expect(fila.obter(j1.id)!.status).toBe('done');
    expect(fila.obter(j2.id)!.status).toBe('queued'); // nunca foi pego
  });

  it('abortar cancela a execução em voo e devolve/falha o job', async () => {
    const runner = new FakeRunner({ respostas: ['nunca'], travar: true });
    const w = novoWorker({ runners: { fake: runner }, tarefas: {} });
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '',
      perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' }, max_tentativas: 2,
    });
    const emCurso = w.passo();
    await new Promise((r) => setTimeout(r, 10));
    await w.abortar();
    await emCurso;
    expect(runner.cancelamentos).toBe(1);
    expect(fila.obter(job.id)!.status).toBe('queued');   // ainda tem tentativa
    expect(fila.obter(job.id)!.erro).toMatch(/encerramento do serviço/);
  });

  it('renova o lease durante o drain (não solta o job em voo)', async () => {
    let liberar: (() => void) | undefined;
    const w = novoWorker({
      leaseSegundos: 60,
      tarefas: { lento: () => new Promise<string>((r) => { liberar = () => r('fim'); }) },
    });
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });
    const emCurso = w.passo();
    expect(fila.obter(job.id)!.lease_ate).toBe(1_060);

    t = 1_050;
    const drenando = w.drenar();
    await w.bater();                                 // heartbeat manual
    expect(fila.obter(job.id)!.lease_ate).toBe(1_110);

    liberar!();
    await emCurso;
    await drenando;
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/worker.test.ts`
Esperado: FAIL — `Cannot find module './worker.js'`.

- [ ] **Step 3: Implementar `src/fila/worker.ts`**

```ts
// Loop de trabalho de UMA fila. Não sabe o que é Telegram nem fluxo — só
// claim → executa → ack. A disciplina que faltava no v1: lease com heartbeat,
// falha registrada, e drain que NÃO solta o lease do que está em voo (spec §1.3).
import type { Execucao, ContextoExecucao, Runner } from './runner.js';
import type { FilaSqlite } from './store.js';
import type { Fila, Job } from './types.js';

export type Tarefa = (job: Job) => Promise<string>;

export interface WorkerOpts {
  fila: Fila;
  concorrencia: number;
  leaseSegundos: number;
  heartbeatSegundos: number;
  tarefas: Record<string, Tarefa>;
  runners: Record<string, Runner>;
  promptDe: (job: Job) => ContextoExecucao;
  log?: (m: string) => void;
}

export class Worker {
  private drenando = false;
  private readonly ativos = new Map<number, Execucao | null>();

  constructor(
    private readonly fila: FilaSqlite,
    private readonly opts: WorkerOpts,
  ) {}

  get emVoo(): number {
    return this.ativos.size;
  }

  /** Renova o lease de tudo que está em voo. Chamado pelo timer e no drain. */
  async bater(): Promise<void> {
    for (const id of this.ativos.keys()) {
      this.fila.renovar(id, this.opts.leaseSegundos);
    }
  }

  /** Processa no máximo um job. Devolve true se pegou algo. */
  async passo(): Promise<boolean> {
    if (this.drenando) return false;
    if (this.ativos.size >= this.opts.concorrencia) return false;

    const job = this.fila.pegar(this.opts.fila, this.opts.leaseSegundos);
    if (!job) return false;

    this.ativos.set(job.id, null);
    const log = this.opts.log ?? (() => {});
    const ref = job.flow_ref ? ` ${job.flow_ref}` : '';
    log(`[job ${job.id}${ref}] ${job.fila}/${job.tarefa} motor=${job.motor ?? '-'} modelo=${job.modelo ?? '-'} esforco=${job.esforco ?? '-'}`);

    try {
      const saida = job.kind === 'function'
        ? await this.rodarFuncao(job)
        : await this.rodarAgente(job);
      if (!this.fila.concluir(job.id, saida)) {
        log(`[job ${job.id}] terminou mas não estava running (cancelado?) — done rejeitado`);
      }
    } catch (e) {
      const erro = (e as Error).message.slice(0, 1_000);
      const r = this.fila.falhar(job.id, erro, 30);
      log(`[job ${job.id}] ${r}: ${erro}`);
    } finally {
      this.ativos.delete(job.id);
    }
    return true;
  }

  private async rodarFuncao(job: Job): Promise<string> {
    const tarefa = this.opts.tarefas[job.tarefa];
    if (!tarefa) throw new Error(`tarefa desconhecida: ${job.tarefa}`);
    return tarefa(job);
  }

  private async rodarAgente(job: Job): Promise<string> {
    const ctx = this.opts.promptDe(job);
    const runner = this.opts.runners[ctx.perfil.motor];
    if (!runner) throw new Error(`motor desconhecido: ${ctx.perfil.motor}`);
    const exec = runner.iniciar(ctx);
    this.ativos.set(job.id, exec);
    try {
      return await exec.aguardar();
    } finally {
      await exec.limpar();
    }
  }

  /**
   * Drain: para de aceitar novos claims e espera o que está em voo, RENOVANDO o
   * lease enquanto espera. Soltar o lease aqui permitiria outro worker pegar o
   * mesmo job com o nosso processo ainda vivo.
   */
  async drenar(): Promise<void> {
    this.drenando = true;
    while (this.ativos.size > 0) {
      await this.bater();
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Encerra à força o que estiver em voo (usado no timeout do drain). */
  async abortar(): Promise<void> {
    for (const [id, exec] of this.ativos) {
      await exec?.cancelar();
      this.fila.falhar(id, 'interrompido no encerramento do serviço', 30);
    }
    this.ativos.clear();
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/fila/worker.test.ts`
Esperado: 9 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fila/worker.ts src/fila/worker.test.ts
git commit -m "feat(fila): worker com concorrência, heartbeat e drain que preserva o lease"
```

---

### Task 12: Backup consistente e restore

**Files:**
- Create: `src/db/backup.ts`, `src/db/backup.test.ts`

**Interfaces:**
- Consumes: `abrirDb`, `aplicarMigrations`, `FilaSqlite`
- Produces: `backupPara(db: Database.Database, destino: string): Promise<void>`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/db/backup.test.ts
// Com WAL, copiar só o arquivo principal produz backup INCOMPLETO (as escritas
// recentes vivem no -wal). Este teste prova que o backup pela API do SQLite
// carrega os dados e que a fila funciona no arquivo restaurado.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { abrirDb } from './abrir.js';
import { MIGRATIONS, aplicarMigrations } from './migrations.js';
import { backupPara } from './backup.js';
import { FilaSqlite } from '../fila/store.js';

let dir: string;
const t = 1_000;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('backup carrega os jobs e o arquivo restaurado é operacional', async () => {
  const origem = join(dir, 'fila.db');
  const db = abrirDb(origem);
  aplicarMigrations(db, () => t, MIGRATIONS);
  const fila = new FilaSqlite(db, () => t);
  fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'explicativo', input: 'RAG' });

  const destino = join(dir, 'backup.db');
  await backupPara(db, destino);
  db.close();

  expect(existsSync(destino)).toBe(true);

  const restaurado = abrirDb(destino);
  const fila2 = new FilaSqlite(restaurado, () => t);
  expect(fila2.listar()).toHaveLength(1);
  expect(fila2.pegar('render', 60)?.tarefa).toBe('explicativo');   // fila funciona no restaurado
  restaurado.close();
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/db/backup.test.ts`
Esperado: FAIL — `Cannot find module './backup.js'`.

- [ ] **Step 3: Implementar `src/db/backup.ts`**

```ts
// Backup pela API do SQLite. NUNCA `cp` do arquivo principal: com WAL, as
// escritas recentes moram no -wal e a cópia crua sai inconsistente.
import type Database from 'better-sqlite3';

export async function backupPara(db: Database.Database, destino: string): Promise<void> {
  await db.backup(destino);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Rodar: `npx vitest run src/db/backup.test.ts`
Esperado: 1 teste PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/backup.ts src/db/backup.test.ts
git commit -m "feat(db): backup consistente pela API do SQLite + teste de restore"
```

---

### Task 13: Teste de arquitetura (fronteiras de import)

**Files:**
- Create: `src/arquitetura.test.ts`

**Interfaces:**
- Consumes: a árvore de arquivos criada até aqui
- Produces: teste que falha se uma camada importar de outra que não deve

- [ ] **Step 1: Escrever o teste (deve passar de primeira se as tarefas anteriores respeitaram as fronteiras)**

```ts
// src/arquitetura.test.ts
// As fronteiras do monólito modular são verificadas por teste, não por revisão
// humana. Regras do spec §4:
//   fila/    não importa de gateway/ nem de fluxos/
//   fluxos/  não importa de gateway/
//   dominio/ não importa de gateway/, fila/ nem fluxos/ (exceto TIPOS de fila/)
//   db/      não importa de nenhuma das outras
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = new URL('.', import.meta.url).pathname;

const PROIBIDO: Record<string, string[]> = {
  db: ['gateway', 'fila', 'fluxos', 'dominio'],
  fila: ['gateway', 'fluxos'],
  fluxos: ['gateway'],
  dominio: ['gateway', 'fluxos'],
};

function arquivosTs(dir: string): string[] {
  let saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida = saida.concat(arquivosTs(caminho));
    else if (nome.endsWith('.ts')) saida.push(caminho);
  }
  return saida;
}

/** `../fila/types.js` importado por dominio/ é a ÚNICA exceção: tipo, não implementação. */
const EXCECOES = [{ de: 'dominio', para: 'fila', arquivo: 'types.js' }];

describe('fronteiras entre camadas', () => {
  for (const [camada, vetados] of Object.entries(PROIBIDO)) {
    it(`${camada}/ não importa de ${vetados.join(', ')}`, () => {
      let dir: string;
      try {
        dir = join(RAIZ, camada);
        statSync(dir);
      } catch {
        return; // camada ainda não existe nesta etapa
      }
      const violacoes: string[] = [];
      for (const arquivo of arquivosTs(dir)) {
        const codigo = readFileSync(arquivo, 'utf8');
        for (const alvo of vetados) {
          const re = new RegExp(`from\\s+['"][^'"]*\\b${alvo}/([^'"]+)['"]`, 'g');
          for (const m of codigo.matchAll(re)) {
            const permitido = EXCECOES.some(
              (e) => e.de === camada && e.para === alvo && m[1] === e.arquivo,
            );
            if (!permitido) violacoes.push(`${arquivo} → ${alvo}/${m[1]}`);
          }
        }
      }
      expect(violacoes).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Rodar e confirmar que passa**

Rodar: `npx vitest run src/arquitetura.test.ts`
Esperado: 4 testes PASS. Se algum falhar, **a correção é mover o código**, nunca afrouxar a regra.

- [ ] **Step 3: Rodar a suíte inteira e o typecheck**

```bash
npm run typecheck && npm test
```

Esperado: `typecheck` sem erro; todos os testes PASS.

- [ ] **Step 4: Commit**

```bash
git add src/arquitetura.test.ts
git commit -m "test: fronteiras entre camadas verificadas automaticamente"
```

---

### Task 14: Documentação — `docs/perfil-de-execucao.md`

**Files:**
- Create: `docs/perfil-de-execucao.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `resolverPerfil` (Task 9), `Runner`/`ClaudeRunner` (Task 10)
- Produces: documentação de referência para portar motor, modelo e esforço

- [ ] **Step 1: Escrever `docs/perfil-de-execucao.md`**

````markdown
# Perfil de execução — motor, modelo e esforço

Todo job `kind=agent` roda com um **perfil de execução**: `{ motor, modelo, esforco }`.

- **motor** — qual agente executa (`claude` hoje; `codex` ou outro amanhã)
- **modelo** — qual modelo daquele motor (`haiku`, `fable`, `sonnet`, `opus`)
- **esforço** — quanto raciocínio (`low`, `medium`, `high`, `xhigh`, `max`)

O perfil efetivo é **gravado no job** (colunas `motor`, `modelo`, `esforco`) e aparece no log:

```
[job 412 P#16/mulheres/render] navegador/fluxo-navegador motor=claude modelo=opus esforco=high
```

Isso responde à pergunta "com que modelo esse render foi feito?" sem arqueologia de commit.

## Por que isso existe

No sistema anterior o perfil era **hardcoded em dois lugares**:

| onde (v1) | valor | consequência |
|---|---|---|
| `mkivideos/src/cli-lib.ts:171` | `--model sonnet --effort low` | valia para TODA skill de render |
| `inemaccvbot/src/interpret.ts` | `--model claude-opus-5 --effort low` | só para interpretar texto livre |

Um `explicativo` e um `reelinematds` (que tem revisor independente) rodavam igual, e mudar exigia
editar TypeScript, recompilar e reiniciar o serviço. Aqui é configuração.

## Precedência (`src/dominio/perfil.ts`)

Da mais forte para a mais fraca, resolvida **campo a campo**:

| # | fonte | onde se escreve | quando usar |
|---|---|---|---|
| 1 | override do comando | `/explicativo X \| modelo=opus` | teste pontual |
| 2 | fase do fluxo | `fases[].modelo` no `flow.json` | uma fase específica precisa de mais |
| 3 | registry | `config/skills.json` / `config/fluxos.json` | **o lugar normal**, por tarefa |
| 4 | sugestão da skill | `sugere` na declaração da skill | a skill indica o que costuma funcionar |
| 5 | default do ambiente | `MOTOR_PADRAO`, `MODELO_PADRAO`, `ESFORCO_PADRAO` no `.env` | fallback global |

## O que a própria skill declara

A skill conhece a própria dificuldade. Ela pode declarar duas coisas:

```jsonc
{
  "sugere": { "modelo": "sonnet", "esforco": "low" },   // preferência FRACA (nível 4)
  "exige":  { "modelo": "opus", "motor": "claude" }      // PISO — eleva, nunca rebaixa
}
```

- **`sugere`** entra na precedência como nível 4: qualquer registry ou fase vence.
- **`exige`** é um **piso**: se a resolução chegou num modelo/esforço mais fraco que o exigido, o
  valor é **elevado** e um aviso é registrado. Serve para o caso legítimo "esta skill não funciona
  abaixo de X" — por exemplo uma skill com revisor independente, ou uma que só roda no motor com
  navegador pareado (`exige.motor = "claude"`).
- Um **override explícito do operador** fura o piso, porque a decisão final é sua — mas gera aviso
  (`override usa modelo haiku, abaixo do exigido pela skill (opus)`). Nada é rebaixado em silêncio.

A comparação usa `MODELOS_RANK` (`haiku 1 < fable 2 < sonnet 3 < opus 4`) e `ESFORCOS_RANK`
(`low 1 < medium 2 < high 3 < xhigh 4 < max 5`). Um modelo/esforço fora dessas tabelas é **erro**,
não default silencioso — inclui-se um novo modelo adicionando-o à tabela.

## Portar para outro motor

Só dois arquivos conhecem o motor: `src/fila/runner.ts` (interface) e `src/fila/runner-*.ts`
(implementações). Um motor novo é ~100 linhas:

```ts
// src/fila/runner-codex.ts
import { RUNNERS, type ContextoExecucao, type Execucao, type Runner } from './runner.js';

export function argumentosCodex(ctx: ContextoExecucao): string[] {
  // traduza o perfil para as flags DESTE motor — é o único ponto de tradução
  return ['--model', ctx.perfil.modelo, 'exec', ctx.prompt];
}

export class CodexRunner implements Runner {
  nome = 'codex';
  iniciar(ctx: ContextoExecucao): Execucao { /* spawn detached, kill de árvore, igual ao ClaudeRunner */ }
}

RUNNERS.codex = new CodexRunner();
```

Depois é só usar `motor: "codex"` numa entrada do registry. **O motor é escolhido por tarefa**, não
globalmente: você avalia um motor novo numa skill só, na mesma fila, comparando custo e qualidade,
em vez de fazer uma troca tudo-ou-nada.

Checklist de um runner novo:

1. `argumentos*()` como função pura (testável sem subprocesso)
2. `spawn` com `detached: true` e **sem `shell: true`**
3. `cancelar()` mata o **process group** (`process.kill(-pid, …)`), não só o pai
4. `limpar()` remove parciais
5. stdout é o resultado; stderr entra na mensagem de erro (truncado)
6. registrar em `RUNNERS`

## O que trocar de motor NÃO resolve

| item | portável? |
|---|---|
| fila, worker, store, perfil | sim — não conhecem o motor |
| `prompts/*.md` dos repos de domínio | sim — markdown agnóstico |
| as ~118 skills em `~/.claude/skills/` | **não** — formato Claude Code; outro motor exige adaptar cada uma |
| fase de navegador (`claude --chrome -p`) | **não** — depende da extensão pareada com o Chromium logado |

Portar o `inemaccbot` é barato; portar o catálogo de skills é o trabalho real. A interface existe
para manter a porta aberta, não porque a troca esteja planejada.
````

- [ ] **Step 2: Escrever `README.md`**

```markdown
# inemaccbot

Gateway Telegram + fila durável + runtime de fluxos. Sucessor do `inemaccvbot`.

**Estado:** etapa 0 — núcleo da fila. Ainda sem comandos de Telegram (etapa 1).

## Documentos

- Arquitetura: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md`
- Perfil de execução (motor/modelo/esforço): `docs/perfil-de-execucao.md`
- Plano da etapa 0: `docs/superpowers/plans/2026-07-30-etapa-0-fila-duravel.md`
- Crítica externa ao design (respondida na §13 do spec): `docs/analise_critica_inemaccbot_design.md`

## Desenvolvimento

```bash
npm install
npm test           # vitest
npm run typecheck
npm run build
```

Config em `.env` (modo 600, fora do git): `BOT_TOKEN`, `QUEUE_DB`, `STATE_DIR`, `LOG_FILE`,
`MOTOR_PADRAO`, `MODELO_PADRAO`, `ESFORCO_PADRAO`.

## Convenções

- ESM: todo import relativo termina em `.js`
- Relógio injetável: nada chama `Date.now()` fora de um `agora: Agora`
- Testes com arquivo SQLite temporário, nunca `:memory:`
- Fronteiras entre camadas verificadas por `src/arquitetura.test.ts`
```

- [ ] **Step 3: Verificar a suíte inteira**

```bash
npm run typecheck && npm test
```

Esperado: tudo verde.

- [ ] **Step 4: Commit e push**

```bash
git add docs/perfil-de-execucao.md README.md
git commit -m "docs: perfil de execução (motor/modelo/esforço) e README da etapa 0"
git push origin master
```

---

## Aceitação da etapa 0

A etapa fecha quando **todos** valem:

1. `npm test` verde, zero teste skipado sem comentário justificando
2. `npm run typecheck` sem erro
3. `src/arquitetura.test.ts` verde
4. **Prova de concorrência** (Task 5): duas conexões, um job → só uma pega
5. **Prova de lease** (Task 6): lease vencido devolve o job com `tentativas` preservado
6. **Prova de idempotência** (Task 8): efeito já concluído é adotado, não repetido
7. **Prova de drain** (Task 11): durante o drain o lease é renovado e nenhum job novo é pego
8. **Prova de restore** (Task 12): fila operacional no arquivo restaurado do backup
9. Nenhum `TODO`/`FIXME` novo sem issue
10. Push no `origin`, autor `inematds <inematds@gmail.com>`

Fora do escopo desta etapa (etapa 1+): qualquer coisa de Telegram, `interpret`, registries em
`config/*.json`, runtime de fluxos, dashboard, systemd unit, tarefas `function` reais
(`heygen.baixar`, `http.get`, `ffmpeg.*`).

Duas peças ficam **implementadas e testadas aqui, mas só são ligadas na etapa 1**, quando existir
`src/index.ts`: `recuperarLeasesVencidos()` (chamada no boot) e `Worker.drenar()/abortar()`
(ligadas ao `SIGTERM` do systemd). A etapa 0 prova que funcionam; a etapa 1 as conecta ao processo.

## Sobre o nome `mkivideos`

Este plano **não depende** do repo `mkivideos` nem em código nem em runtime: o motor de fila é
reimplementado aqui em `src/fila/` (o `mkivideos` serviu de referência de desenho — ports &
adapters — e como fonte do erro a corrigir: claim não atômico). O `mkivideos.service` continua
rodando intacto até a etapa 3 do cutover e depois é desligado.

Por isso **não se renomeia o `mkivideos`**: o `inemaccvbot` em produção referencia o binário e os
paths (`MKIVIDEOS_DIR`, `MKIVIDEOS_DB`, `mkivideos add …`), e renomear quebraria o v1 durante a
coexistência — que é justamente o que a decisão "não mexer no v1" protege. O nome genérico já vive
no repo novo (`src/fila/`, sem produto no nome). Se um dia a fila precisar ser reusada por outro
projeto, o caminho é **extrair um pacote a partir de `src/fila/`** (aí sim com nome genérico, ex.
`mkiservico`), não renomear um repo que está sendo aposentado.

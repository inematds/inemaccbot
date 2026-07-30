# Etapa 1 — Gateway mínimo + filas `io`/`cpu` + serviço (plano de implementação)

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development`
> (recomendado) ou `superpowers:executing-plans` para implementar tarefa por tarefa. Os passos usam
> checkbox (`- [ ]`) para rastreio.

**Goal:** o `inemaccbot` vira um serviço vivo: recebe comando no Telegram, enfileira, executa em
worker com lease e posse, responde no chat, e desliga sem perder trabalho. Sem agente Claude ainda —
só tarefas `function` baratas, para validar claim, lease, drain, cancelamento e prioridade com jobs
de milissegundos, onde errar custa pouco.

**Architecture:** a etapa 0 entregou o núcleo (`db/`, `fila/`, `dominio/`). Esta etapa acrescenta
`gateway/` (Telegram), `fila/tarefas/` (catálogo de funções) e `src/index.ts` (boot, laço,
`SIGTERM`), e corrige os três perigos que a revisão final nomeou. Nada de skills, fluxos ou
registries em JSON — isso é etapa 2.

**Tech Stack:** Node 22+, TypeScript ESM, `better-sqlite3`, `vitest`, e **uma dependência nova**:
`grammy` (Telegram), a mesma do v1.

**Base:** `master` em `05f8767` (etapa 0 mergeada, 92 testes verdes).
**Spec:** `docs/superpowers/specs/2026-07-30-inemaccbot-design.md` (§1, §2.3, §2.5.1, §7.2, §9).

## Global Constraints

Valem os mesmos da etapa 0, e são inegociáveis:

- Repo `~/projetos/inemaccbot`, branch nova `etapa-1` a partir de `master`. Autor
  `inematds <inematds@gmail.com>`. Push via SSH.
- TypeScript `strict: true`; ESM — **todo import relativo termina em `.js`**.
- **Relógio injetável**: nada chama `Date.now()` fora de um `agora: Agora` recebido por parâmetro.
- **Testes usam arquivo SQLite temporário, nunca `:memory:`**; nenhum teste toca a API real do
  Telegram, do sistema de arquivos do usuário ou da rede.
- `spawn`/`execFile` **sempre sem `shell: true`**, argumentos em array.
- Segredos nunca aparecem em log nem em mensagem de erro.
- Nomes de env sem nome de produto: `BOT_TOKEN`, `QUEUE_DB`, `STATE_DIR`, `LOG_FILE`,
  `ALLOWED_CHAT_IDS`, `MOTOR_PADRAO`, `MODELO_PADRAO`, `ESFORCO_PADRAO`.
- Nomenclatura de domínio em português.
- **Fronteiras** (`src/arquitetura.test.ts`, que agora passa a valer para `gateway/`):
  `gateway/` pode importar de `dominio/` e a **interface** de `fila/`; `fila/` e `dominio/` **não**
  importam de `gateway/`. Teste que cruza camadas vive em `src/integracao/`. A lista de exceções
  continua com **uma** entrada.
- Guarda nova só entra com **prova por mutação**: quebre a guarda, veja o teste vermelho, restaure.

## Estrutura de arquivos desta etapa

| arquivo | responsabilidade |
|---|---|
| `src/config.ts` | lê e valida o `.env`; falha alto no boot se algo essencial falta |
| `src/fila/types.ts` (mod.) | `ContextoTarefa`, `Tarefa` com acesso ao store |
| `src/fila/worker.ts` (mod.) | passa contexto às tarefas; `promptDe` assíncrono; `aoTerminar` |
| `src/fila/tarefas/http.ts` | tarefa `http.get` |
| `src/fila/tarefas/ffmpeg.ts` | tarefa `ffmpeg.thumb` |
| `src/fila/tarefas/index.ts` | catálogo `TAREFAS` |
| `src/gateway/telegram.ts` | adaptador grammy: allowlist, envio com corte de 4096 |
| `src/gateway/comandos.ts` | parse e execução dos comandos (puro, sem grammy) |
| `src/gateway/notificar.ts` | avisa o chat quando um job termina |
| `src/index.ts` | boot, laço de `passo()`, heartbeat, `SIGTERM` → drain |
| `deploy/inemaccbot.service` | unit systemd |
| `src/integracao/ponta-a-ponta.test.ts` | comando → fila → worker → notificação |

---

### Task 1: Branch e configuração (`src/config.ts`)

**Files:**
- Create: `src/config.ts`, `src/config.test.ts`
- Modify: `.env.example` (criar)

**Interfaces:**
- Consumes: nada
- Produces:
  - `interface Config { botToken: string; queueDb: string; stateDir: string; logFile: string; chatsPermitidos: number[]; motorPadrao: string; modeloPadrao: string; esforcoPadrao: string }`
  - `carregarConfig(env: NodeJS.ProcessEnv): Config` — pura, recebe o ambiente, **não** lê arquivo

- [ ] **Step 1: Criar a branch**

```bash
cd ~/projetos/inemaccbot && git checkout master && git pull --ff-only && git checkout -b etapa-1
```

- [ ] **Step 2: Escrever o teste que falha**

```ts
// src/config.test.ts
import { describe, expect, it } from 'vitest';

import { carregarConfig } from './config.js';

const base = {
  BOT_TOKEN: 'x:y',
  QUEUE_DB: '/tmp/q.db',
  STATE_DIR: '/tmp/estado',
  LOG_FILE: '/tmp/bot.log',
  ALLOWED_CHAT_IDS: '42, 7',
};

describe('carregarConfig', () => {
  it('lê o essencial e parseia a allowlist', () => {
    const c = carregarConfig(base);
    expect(c.botToken).toBe('x:y');
    expect(c.chatsPermitidos).toEqual([42, 7]);
  });

  it('aplica os defaults de perfil quando não vêm no ambiente', () => {
    const c = carregarConfig(base);
    expect(c.motorPadrao).toBe('claude');
    expect(c.modeloPadrao).toBe('sonnet');
    expect(c.esforcoPadrao).toBe('low');
  });

  it('respeita os defaults de perfil vindos do ambiente', () => {
    const c = carregarConfig({ ...base, MODELO_PADRAO: 'opus', ESFORCO_PADRAO: 'high' });
    expect(c.modeloPadrao).toBe('opus');
    expect(c.esforcoPadrao).toBe('high');
  });

  it('falha alto quando falta variável essencial, nomeando qual', () => {
    const { BOT_TOKEN, ...semToken } = base;
    expect(() => carregarConfig(semToken)).toThrow(/BOT_TOKEN/);
  });

  it('falha quando a allowlist está vazia — bot aberto é falha de segurança, não default', () => {
    expect(() => carregarConfig({ ...base, ALLOWED_CHAT_IDS: '' })).toThrow(/ALLOWED_CHAT_IDS/);
  });

  it('falha quando a allowlist tem entrada não numérica', () => {
    expect(() => carregarConfig({ ...base, ALLOWED_CHAT_IDS: '42,abc' })).toThrow(/abc/);
  });

  it('nunca inclui o token na mensagem de erro', () => {
    try {
      carregarConfig({ ...base, ALLOWED_CHAT_IDS: '' });
    } catch (e) {
      expect((e as Error).message).not.toContain('x:y');
    }
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Rodar: `npx vitest run src/config.test.ts` · Esperado: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 4: Implementar `src/config.ts`**

```ts
// Configuração do processo. Função PURA sobre o ambiente: quem lê o arquivo é o
// index.ts. Assim o teste não precisa de .env no disco, e o boot falha alto e
// cedo — variável faltando derruba o serviço na largada, não no primeiro job.
export interface Config {
  botToken: string;
  queueDb: string;
  stateDir: string;
  logFile: string;
  chatsPermitidos: number[];
  motorPadrao: string;
  modeloPadrao: string;
  esforcoPadrao: string;
}

function exigir(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new Error(`config: falta ${nome} no ambiente`);
  return v;
}

export function carregarConfig(env: NodeJS.ProcessEnv): Config {
  const bruta = exigir(env, 'ALLOWED_CHAT_IDS');
  const chatsPermitidos = bruta.split(',').map((p) => {
    const t = p.trim();
    const n = Number(t);
    // Allowlist é a única barreira entre o bot e qualquer pessoa no Telegram:
    // entrada inválida é erro de boot, nunca "ignora e segue".
    if (!t || !Number.isInteger(n)) throw new Error(`config: ALLOWED_CHAT_IDS inválido: "${t}"`);
    return n;
  });

  return {
    botToken: exigir(env, 'BOT_TOKEN'),
    queueDb: exigir(env, 'QUEUE_DB'),
    stateDir: exigir(env, 'STATE_DIR'),
    logFile: exigir(env, 'LOG_FILE'),
    chatsPermitidos,
    motorPadrao: env.MOTOR_PADRAO?.trim() || 'claude',
    modeloPadrao: env.MODELO_PADRAO?.trim() || 'sonnet',
    esforcoPadrao: env.ESFORCO_PADRAO?.trim() || 'low',
  };
}
```

- [ ] **Step 5: Criar `.env.example`** (sem valores reais)

```
BOT_TOKEN=
QUEUE_DB=/home/nmaldaner/projetos/inemaccbot/inemaccbot.db
STATE_DIR=/home/nmaldaner/projetos/inemaccbot/state
LOG_FILE=/home/nmaldaner/projetos/inemaccbot/inemaccbot.log
ALLOWED_CHAT_IDS=
MOTOR_PADRAO=claude
MODELO_PADRAO=sonnet
ESFORCO_PADRAO=low
```

- [ ] **Step 6: Rodar, typecheck, commit**

```bash
npx vitest run src/config.test.ts && npm run typecheck && npm test
git add src/config.ts src/config.test.ts .env.example
git commit -m "feat(config): leitura e validação do ambiente, com allowlist obrigatória"
```

---

### Task 2: `Tarefa` ganha contexto — a idempotência fica alcançável

**Files:**
- Modify: `src/fila/types.ts`, `src/fila/worker.ts`, `src/fila/worker.test.ts`
- Test: `src/fila/worker.test.ts`

**Interfaces:**
- Consumes: `FilaSqlite`, `Job`, `Agora` (etapa 0)
- Produces:
  - `interface ContextoTarefa { job: Job; fila: FilaSqlite; agora: Agora; log: (m: string) => void }`
  - `type Tarefa = (ctx: ContextoTarefa) => Promise<string>` (era `(job: Job) => Promise<string>`)

**Por que:** a revisão final da etapa 0 apontou que `Tarefa = (job) => Promise<string>` não dá acesso
ao store, então **uma tarefa não consegue chamar `jaConcluido`** — a defesa de idempotência é
inalcançável exatamente do lugar onde o spec §2.5 manda ela viver. Corrigir agora custa uma
assinatura; corrigir depois custa reescrever todas as tarefas.

- [ ] **Step 1: Escrever o teste que falha** (acrescentar a `src/fila/worker.test.ts`)

```ts
  it('entrega à tarefa um contexto com job, fila e relógio', async () => {
    let visto: { id: number; temFila: boolean; agora: number } | undefined;
    const w = novoWorker({
      tarefas: {
        espia: async (ctx) => {
          visto = { id: ctx.job.id, temFila: typeof ctx.fila.obter === 'function', agora: ctx.agora() };
          return 'ok';
        },
      },
    });
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'espia', input: '' });
    await w.passo();
    expect(visto).toEqual({ id: job.id, temFila: true, agora: 1_000 });
  });

  it('a tarefa consegue consultar jaConcluido pelo contexto (§2.5 alcançável)', async () => {
    const CHAVE = 'P#1/alvo/fase';
    const anterior = fila.enfileirarSeNovo({
      fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE,
    });
    fila.pegar('io', 60, 'w0');
    fila.concluir(anterior.job.id, 'artefato-antigo', 'w0');

    const w = novoWorker({
      tarefas: { adota: async (ctx) => ctx.fila.jaConcluido(ctx.job.idem_key!)?.resultado ?? 'novo' },
    });
    const job = fila.enfileirar({
      fila: 'io', kind: 'function', tarefa: 'adota', input: '', idem_key: CHAVE,
    });
    await w.passo();
    expect(fila.obter(job.id)!.resultado).toBe('artefato-antigo');
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Rodar: `npx vitest run src/fila/worker.test.ts` · Esperado: FAIL — a tarefa recebe um `Job`, então
`ctx.fila` é `undefined` e `ctx.job` também.

- [ ] **Step 3: Alterar `src/fila/types.ts`**

```ts
/**
 * O que uma tarefa `kind=function` recebe. Ela precisa do STORE, não só do job:
 * é por aqui que a regra "procure antes de criar" do §2.5 fica alcançável —
 * sem isto, uma tarefa não consegue consultar `jaConcluido` e a garantia de
 * efeito único vira comentário.
 */
export interface ContextoTarefa {
  job: Job;
  fila: import('./store.js').FilaSqlite;
  agora: Agora;
  log: (m: string) => void;
}
```

> Nota de fronteira: `types.ts` passa a referenciar `store.js` **como tipo**, via `import(...)`
> inline. Isso mantém `types.ts` sem import de runtime. Se o teste de arquitetura reclamar, a
> correção é o `import type` no topo — **não** alargar a lista de exceções.

- [ ] **Step 4: Alterar `src/fila/worker.ts`**

Trocar `export type Tarefa = (job: Job) => Promise<string>;` por:

```ts
export type Tarefa = (ctx: ContextoTarefa) => Promise<string>;
```

e, em `rodarFuncao`, montar o contexto:

```ts
  private async rodarFuncao(job: Job): Promise<string> {
    const tarefa = this.opts.tarefas[job.tarefa];
    if (!tarefa) throw new Error(`tarefa desconhecida: ${job.tarefa}`);
    return tarefa({
      job,
      fila: this.fila,
      agora: this.agora,
      log: this.opts.log ?? (() => {}),
    });
  }
```

O `Worker` precisa do relógio: acrescente `agora: Agora` ao construtor
(`constructor(private readonly fila: FilaSqlite, private readonly opts: WorkerOpts, private readonly agora: Agora)`)
e atualize **todos** os sites de construção, inclusive nos testes.

- [ ] **Step 5: Rodar, typecheck, commit**

```bash
npx vitest run && npm run typecheck
git add src/fila/types.ts src/fila/worker.ts src/fila/worker.test.ts
git commit -m "feat(fila): tarefa recebe contexto com store e relógio — idempotência alcançável (§2.5)"
```

---

### Task 3: `promptDe` assíncrono

**Files:**
- Modify: `src/fila/worker.ts`, `src/fila/worker.test.ts`

**Interfaces:**
- Produces: `promptDe: (job: Job) => Promise<ContextoExecucao>` (era síncrono)

**Por que:** montar o prompt real vai ler registry e arquivo de fluxo — I/O. A revisão final avisou
que mudar essa assinatura depois toca todo site de construção do `Worker` e todo teste. Fazemos
agora, enquanto há três sites.

- [ ] **Step 1: Ajustar o teste** — no helper `novoWorker`, trocar `promptDe: (job) => ({...})` por
  `promptDe: async (job) => ({...})`. Acrescentar um caso:

```ts
  it('aguarda um promptDe assíncrono antes de chamar o runner', async () => {
    let ordem: string[] = [];
    const w = novoWorker({
      promptDe: async (job) => {
        await new Promise((r) => setTimeout(r, 5));
        ordem.push('prompt');
        return { prompt: job.input, cwd: '/tmp', perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' }, vars: {} };
      },
      runners: { fake: new FakeRunner({ respostas: ['saida'] }) },
    });
    fila.enfileirar({ fila: 'io', kind: 'agent', tarefa: 'x', input: 'p', perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' } });
    await w.passo();
    expect(ordem).toEqual(['prompt']);
  });
```

- [ ] **Step 2: Rodar e confirmar que falha** (`promptDe` devolve Promise e o runner recebe um objeto errado).

- [ ] **Step 3: Implementar** — em `WorkerOpts`, `promptDe: (job: Job) => Promise<ContextoExecucao>`;
  em `rodarAgente`, `const ctx = await this.opts.promptDe(job);`.

- [ ] **Step 4: Rodar tudo, typecheck, commit**

```bash
npx vitest run && npm run typecheck
git add src/fila/worker.ts src/fila/worker.test.ts
git commit -m "refactor(fila): promptDe assíncrono — montar prompt vai fazer I/O na etapa 2"
```

---

### Task 4: Catálogo de tarefas `function` — `http.get`

**Files:**
- Create: `src/fila/tarefas/http.ts`, `src/fila/tarefas/http.test.ts`

**Interfaces:**
- Produces: `criarHttpGet(fetchFn?: typeof fetch): Tarefa` — fábrica, para o teste injetar o `fetch`

- [ ] **Step 1: Escrever o teste**

```ts
// src/fila/tarefas/http.test.ts
import { describe, expect, it } from 'vitest';

import { criarHttpGet } from './http.js';
import type { ContextoTarefa } from '../types.js';

const ctx = (input: string): ContextoTarefa =>
  ({ job: { input } as never, fila: {} as never, agora: () => 1_000, log: () => {} });

describe('http.get', () => {
  it('devolve o corpo de uma resposta 200', async () => {
    const tarefa = criarHttpGet(async () => new Response('conteúdo', { status: 200 }));
    await expect(tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' })))).resolves.toBe('conteúdo');
  });

  it('falha com o status quando não é 2xx', async () => {
    const tarefa = criarHttpGet(async () => new Response('nao', { status: 503 }));
    await expect(tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' })))).rejects.toThrow(/503/);
  });

  it('rejeita input sem url', async () => {
    const tarefa = criarHttpGet(async () => new Response('x'));
    await expect(tarefa(ctx('{}'))).rejects.toThrow(/url/i);
  });

  it('rejeita esquema que não seja http(s) — sem file:// nem data:', async () => {
    const tarefa = criarHttpGet(async () => new Response('x'));
    await expect(tarefa(ctx(JSON.stringify({ url: 'file:///etc/passwd' })))).rejects.toThrow(/esquema/i);
  });

  it('trunca corpo gigante em vez de devolver megabytes pro chat', async () => {
    const tarefa = criarHttpGet(async () => new Response('a'.repeat(20_000), { status: 200 }));
    const saida = await tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' })));
    expect(saida.length).toBeLessThanOrEqual(8_200);
    expect(saida).toMatch(/truncado/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha.**

- [ ] **Step 3: Implementar `src/fila/tarefas/http.ts`**

```ts
// Tarefa `function` mais barata que existe: serve para exercitar claim, lease,
// prioridade e cancelamento com jobs de milissegundos, onde errar custa pouco.
import type { ContextoTarefa, Tarefa } from '../types.js';

const LIMITE = 8_000;

export function criarHttpGet(fetchFn: typeof fetch = fetch): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    const { url } = JSON.parse(ctx.job.input || '{}') as { url?: string };
    if (!url) throw new Error('http.get: input precisa de { url }');
    const u = new URL(url);
    // Sem file:// nem data:: a URL vem do usuário, e um GET não pode virar
    // leitura de disco do servidor.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`http.get: esquema não permitido: ${u.protocol}`);
    }
    const r = await fetchFn(u);
    if (!r.ok) throw new Error(`http.get: HTTP ${r.status}`);
    const corpo = await r.text();
    return corpo.length > LIMITE ? `${corpo.slice(0, LIMITE)}\n… (truncado)` : corpo;
  };
}
```

- [ ] **Step 4: Rodar, commit**

```bash
npx vitest run src/fila/tarefas/http.test.ts && npm run typecheck
git add src/fila/tarefas/http.ts src/fila/tarefas/http.test.ts
git commit -m "feat(tarefas): http.get com limite de esquema e truncagem"
```

---

### Task 5: Tarefa `ffmpeg.thumb` e o catálogo

**Files:**
- Create: `src/fila/tarefas/ffmpeg.ts`, `src/fila/tarefas/ffmpeg.test.ts`, `src/fila/tarefas/index.ts`

**Interfaces:**
- Produces:
  - `criarFfmpegThumb(binario?: string): Tarefa`
  - `TAREFAS: Record<string, Tarefa>` — o catálogo fechado (spec §9: `tarefa` só pode ser nome do catálogo)

- [ ] **Step 1: Escrever o teste**

```ts
// src/fila/tarefas/ffmpeg.test.ts
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarFfmpegThumb } from './ffmpeg.js';
import { TAREFAS } from './index.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (input: string): ContextoTarefa =>
  ({ job: { input } as never, fila: {} as never, agora: () => 1_000, log: () => {} });

describe('ffmpeg.thumb', () => {
  it('rejeita entrada que não existe, sem chamar o binário', async () => {
    const tarefa = criarFfmpegThumb('/bin/false');
    await expect(tarefa(ctx(JSON.stringify({ entrada: join(dir, 'nao-existe.mp4') }))))
      .rejects.toThrow(/não encontrado|nao encontrado/i);
  });

  it('rejeita input sem entrada', async () => {
    await expect(criarFfmpegThumb('/bin/true')(ctx('{}'))).rejects.toThrow(/entrada/i);
  });

  it('devolve o caminho da saída quando o binário sai com 0', async () => {
    const entrada = join(dir, 'v.mp4');
    writeFileSync(entrada, 'x');
    // /bin/true ignora os argumentos e sai 0; o teste prova o contrato da tarefa
    // (validação, montagem de argumentos, caminho de saída), não o ffmpeg.
    const saida = await criarFfmpegThumb('/bin/true')(ctx(JSON.stringify({ entrada })));
    expect(saida).toBe(`${entrada}.jpg`);
  });

  it('falha com o código quando o binário sai diferente de 0', async () => {
    const entrada = join(dir, 'v.mp4');
    writeFileSync(entrada, 'x');
    await expect(criarFfmpegThumb('/bin/false')(ctx(JSON.stringify({ entrada }))))
      .rejects.toThrow(/código 1/);
  });
});

describe('catálogo', () => {
  it('expõe exatamente as tarefas conhecidas', () => {
    expect(Object.keys(TAREFAS).sort()).toEqual(['ffmpeg.thumb', 'http.get']);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha.**

- [ ] **Step 3: Implementar `src/fila/tarefas/ffmpeg.ts`**

```ts
// Tarefa da fila `cpu`. ffmpeg NÃO é trabalho leve — compete por CPU com o
// render — por isso vive numa fila de concorrência 1, separada da `io`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { ContextoTarefa, Tarefa } from '../types.js';

const pExecFile = promisify(execFile);

export function criarFfmpegThumb(binario = 'ffmpeg'): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    const { entrada } = JSON.parse(ctx.job.input || '{}') as { entrada?: string };
    if (!entrada) throw new Error('ffmpeg.thumb: input precisa de { entrada }');
    if (!existsSync(entrada)) throw new Error(`ffmpeg.thumb: arquivo não encontrado: ${entrada}`);
    const saida = `${entrada}.jpg`;
    try {
      // Argumentos em array, nunca shell: o caminho vem do usuário.
      await pExecFile(binario, ['-y', '-i', entrada, '-frames:v', '1', saida], { timeout: 60_000 });
    } catch (e) {
      const código = (e as { code?: number }).code ?? '?';
      throw new Error(`ffmpeg.thumb: saiu com código ${código}`);
    }
    return saida;
  };
}
```

- [ ] **Step 4: Implementar `src/fila/tarefas/index.ts`**

```ts
// Catálogo FECHADO de tarefas `function` (spec §9): o campo `tarefa` de um job
// só pode ser uma chave daqui. Texto livre do usuário nunca vira nome de tarefa.
import type { Tarefa } from '../types.js';
import { criarHttpGet } from './http.js';
import { criarFfmpegThumb } from './ffmpeg.js';

export const TAREFAS: Record<string, Tarefa> = {
  'http.get': criarHttpGet(),
  'ffmpeg.thumb': criarFfmpegThumb(),
};
```

- [ ] **Step 5: Rodar, typecheck, commit**

```bash
npx vitest run src/fila/tarefas && npm run typecheck && npm test
git add src/fila/tarefas
git commit -m "feat(tarefas): ffmpeg.thumb e catálogo fechado"
```

---

### Task 6: Comandos do gateway (puro, sem Telegram)

**Files:**
- Create: `src/gateway/comandos.ts`, `src/gateway/comandos.test.ts`

**Interfaces:**
- Produces:
  - `type Comando = { tipo: 'ping' } | { tipo: 'fila' } | { tipo: 'status'; id: number } | { tipo: 'cancelar'; id: number } | { tipo: 'furar'; id: number } | { tipo: 'http'; url: string } | { tipo: 'thumb'; entrada: string } | { tipo: 'desconhecido'; texto: string }`
  - `parseComando(texto: string): Comando`
  - `executar(cmd: Comando, deps: { fila: FilaSqlite; chatId: number; agora: Agora }): string` — devolve o texto da resposta

**Por que separado do grammy:** todo o comportamento fica testável sem tocar a API do Telegram, que
é a regra herdada do v1 (`nenhum teste deste bot bate na API real do Telegram`).

- [ ] **Step 1: Escrever o teste** — cobrir: cada comando reconhecido; `/status 999` inexistente;
  **id que não é deste bot é recusado com mensagem clara** (o cuidado de cutover do spec §5.1);
  `/furar` muda a prioridade e o job passa na frente; `/cancelar` num job `done` não mente;
  texto livre cai em `desconhecido` com dica de `/help`.

```ts
// src/gateway/comandos.test.ts (trecho essencial — completar os demais casos)
  it('recusa id que não existe neste bot, sem agir em job algum', () => {
    const r = executar(parseComando('/status 999'), { fila, chatId: 42, agora: () => 1_000 });
    expect(r).toMatch(/não é deste bot|não existe/i);
  });

  it('/furar põe o job na frente da fila', () => {
    const a = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
    const b = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
    executar(parseComando(`/furar ${b.id}`), { fila, chatId: 42, agora: () => 1_000 });
    expect(fila.pegar('io', 60, 'w')!.id).toBe(b.id);
    expect(fila.pegar('io', 60, 'w')!.id).toBe(a.id);
  });
```

- [ ] **Step 2: Rodar e confirmar que falha.**
- [ ] **Step 3: Implementar `parseComando` e `executar`.** `executar` só fala com o store — não
  imprime, não envia, não conhece grammy. `/fila` resume por fila: rodando, pendentes, job mais
  antigo, taxa de erro em 24h (spec §8).
- [ ] **Step 4: Rodar, typecheck, commit.**

---

### Task 7: Adaptador Telegram (grammy) com allowlist

**Files:**
- Create: `src/gateway/telegram.ts`, `src/gateway/telegram.test.ts`
- Modify: `package.json` (dependência `grammy`)

**Interfaces:**
- Produces:
  - `interface Transporte { responder(chatId: number, texto: string): Promise<void> }`
  - `criarBot(cfg: Config, deps: { aoComando: (chatId: number, texto: string) => Promise<string> }): { bot: Bot; transporte: Transporte }`
  - `cortar(texto: string, limite?: number): string[]` — **portado do `reply.ts` do v1**, com os testes junto

- [ ] **Step 1: Instalar** `npm install grammy` e portar `cortar` com a suíte do v1 (o corte de 4096
  é conhecimento duro e já testado; não reescrever do zero).
- [ ] **Step 2: Teste** — `criarBot` com um `Bot` fake: mensagem de chat **fora** da allowlist é
  descartada e logada, e `aoComando` **não** é chamado; mensagem de dentro chama `aoComando` e
  responde com o retorno, cortado em pedaços quando passa de 4096.
- [ ] **Step 3: Implementar.** Nenhum teste toca a API real.
- [ ] **Step 4: Rodar, typecheck, commit.**

---

### Task 8: Notificação de término

**Files:**
- Create: `src/gateway/notificar.ts`, `src/gateway/notificar.test.ts`
- Modify: `src/fila/worker.ts` (novo `aoTerminar` em `WorkerOpts`)

**Interfaces:**
- Produces:
  - `WorkerOpts.aoTerminar?: (job: Job) => Promise<void>` — chamado **depois** do ack, com o job já relido do banco
  - `criarNotificador(transporte: Transporte): (job: Job) => Promise<void>`

**Por que:** no v1 isso era um watcher separado varrendo o banco. Aqui worker e gateway vivem no
mesmo processo, então o worker avisa direto — e o spec §8 exige que **falha sempre notifique** com
`job_id` e trecho do erro; silêncio nunca é estado válido.

- [ ] **Step 1: Teste** — job `done` gera mensagem com id e resultado; job `failed` gera mensagem com
  id e o erro truncado; job **sem `chat_id`** (fase de fluxo, etapa 2) não notifica ninguém; uma
  exceção dentro do notificador **não** derruba o worker nem impede o próximo `passo()`.
- [ ] **Step 2: Rodar e confirmar que falha.**
- [ ] **Step 3: Implementar.** `aoTerminar` é chamado dentro de um `try/catch` no `passo()` — o envio
  ao Telegram pode falhar (rede), e isso não pode desfazer o ack nem parar a fila.
- [ ] **Step 4: Rodar, typecheck, commit.**

---

### Task 9: `src/index.ts` — boot, laço e desligamento

**Files:**
- Create: `src/index.ts` (substituindo o placeholder), `src/index.test.ts`

**Interfaces:**
- Produces:
  - `criarServico(cfg: Config, deps): { iniciar(): Promise<void>; parar(): Promise<void> }` — testável sem processo
  - `main()` — só no `import.meta.main`-equivalente, lê `.env` e chama `criarServico`

**Este é o miolo da etapa.** A revisão final da etapa 0 foi explícita: *"nada disso roda ainda —
ninguém chama `recuperarLeasesVencidos()`, `passo()` nem liga `SIGTERM` → `drenar()`; toda a
durabilidade fica inerte até o `index.ts` existir"*.

**Ordem de boot obrigatória** (spec §3.6), e ela roda **antes** do primeiro `passo()`:

1. abrir o DB (`abrirDb`), aplicar migrations (falha alto se checksum divergir);
2. `recuperarLeasesVencidos()` — devolve à fila o que ficou preso, marca `failed` quem estourou tentativas;
3. logar o resultado dessa recuperação (`{ requeued, failed }`) — é a evidência de que houve queda;
4. só então iniciar os workers e o bot.

**Um worker por fila**, com as concorrências do spec §2.3: `render` 1, `navegador` 1, `texto` 2,
`io` 10, `cpu` 1. Nesta etapa só `io` e `cpu` têm tarefas; os outros já sobem (vazios) para que a
etapa 2 não precise mexer no boot.

**Laço e heartbeat:** o `Worker` é um *stepper* — decisão do dono registrada na etapa 0. Quem agenda
é aqui: um laço que chama `passo()` enquanto ele devolver `true`, com pausa curta quando devolver
`false`, e um `setInterval` chamando `bater()` a cada `leaseSegundos / 3`.

**Desligamento:** `SIGTERM` → para o bot de receber, chama `drenar()` em todos os workers com timeout
de 110 s (o unit dá 120 s), depois `abortar()` no que sobrar, e fecha o DB. **Atenção à mudança
semântica da etapa 0:** `drenar()` só espera o trabalho que aquele worker ainda **possui** — job
roubado é abandonado de propósito, então o retorno não implica que toda promessa de `passo()`
assentou.

- [ ] **Step 1: Teste** (com `Bot` fake, DB temporário e relógio injetado):
  - o boot aplica migrations e chama `recuperarLeasesVencidos` **antes** do primeiro `passo()` —
    prove pela ordem: enfileire um job preso em `running` com lease vencido e assere que ele foi
    processado depois do boot, não ignorado;
  - `parar()` durante um job em voo espera ele terminar e o job fica `done`;
  - `parar()` com um job que não termina dentro do timeout resulta em job de volta na fila
    (ou `failed` se esgotou tentativas), **nunca** preso em `running` com lease vivo;
  - o serviço sobe com o DB vazio sem erro.
- [ ] **Step 2: Rodar e confirmar que falha.**
- [ ] **Step 3: Implementar.** Toda a temporização por parâmetro (`intervaloOciosoMs`,
  `timeoutDrenoMs`), para os testes não dependerem de relógio real.
- [ ] **Step 4: Rodar, typecheck, commit.**

---

### Task 10: Teste ponta a ponta

**Files:**
- Create: `src/integracao/ponta-a-ponta.test.ts`

Cruza `gateway/` e `fila/` de propósito — por isso vive em `src/integracao/`, a convenção fixada na
etapa 0.

- [ ] **Step 1: Escrever o teste**, com transporte fake e `fetch` injetado:
  1. texto `http https://exemplo.test/x` chega pelo gateway com um `chat_id` permitido;
  2. um job aparece na fila `io` com `chat_id` preenchido;
  3. o worker executa e conclui;
  4. o notificador manda ao chat certo uma mensagem contendo o id do job;
  5. `/fila` passa a mostrar zero pendentes.
  E o caminho triste: uma tarefa que lança → job `failed` → **o chat recebe** id + trecho do erro
  (spec §8: silêncio nunca é estado válido).
- [ ] **Step 2: Rodar, ajustar, commit.**

---

### Task 11: Deploy e documentação

**Files:**
- Create: `deploy/inemaccbot.service`
- Modify: `README.md`, `docs/perfil-de-execucao.md` (só onde algo ficou falso)

- [ ] **Step 1: Unit systemd**

```ini
[Unit]
Description=inemaccbot — gateway Telegram + fila durável
After=network-online.target

[Service]
Type=simple
User=nmaldaner
WorkingDirectory=/home/nmaldaner/projetos/inemaccbot
EnvironmentFile=/home/nmaldaner/projetos/inemaccbot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: README** — como rodar, o que a etapa entrega, e a ordem de boot (por que
  `recuperarLeasesVencidos` vem antes do laço).
- [ ] **Step 3: Commit e push** (`git push origin etapa-1`; via SSH se o commit tocar
  `.github/workflows/*`).

---

## Aceitação da etapa 1

Fecha quando **todos** valerem:

1. `npm test` verde, zero teste skipado sem comentário; `npm run typecheck` limpo; saída pristina
2. `src/arquitetura.test.ts` verde **com `gateway/` já sob as regras**
3. **Prova de reinício:** com o serviço rodando um job de `io`, `kill -9` no processo; ao subir, o
   log mostra a recuperação (`{ requeued: 1, failed: 0 }`) e o job termina — sem duplicar efeito
4. **Prova de drain:** `systemctl stop` (ou `SIGTERM`) com job em voo → o job termina, nada fica
   `running` com lease vivo
5. **Prova de allowlist:** mensagem de chat não permitido é descartada e logada; `aoComando` não roda
6. **Prova de prioridade:** 20 jobs `io` em paralelo e um `/furar` — o furado sai primeiro
7. `/cancelar` num `ffmpeg.thumb` em execução não deixa processo órfão
8. Commit + push no `origin` como `inematds`

## Fora do escopo (etapa 2+)

Skills, agentes (`kind=agent` em produção), registries em JSON (`skills.json`/`fluxos.json`/
`destinos.json`), `interpret` com `claude -p`, runtime de fluxos, dashboard, entrega de arquivo,
anexos, e desligar `mkitexto.service`/`mkivideos.service` — o cutover das filas `texto` e `render`
é etapa 2 e 3.

## Perigos herdados que esta etapa fecha

| perigo (revisão final da etapa 0) | task |
|---|---|
| nada chama `recuperarLeasesVencidos`/`passo`/`drenar` | 9 |
| `Tarefa` sem acesso ao store → idempotência inalcançável | 2 |
| `promptDe` síncrono | 3 |
| `reagendar()` sem chamador | fica para a etapa 2 (fases com `espera`) |
| `resolverPerfil` sem chamador em produção | fica para a etapa 2 (`kind=agent`) |

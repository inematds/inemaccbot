# Instalação sem tutor — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** quem clona o repo numa máquina limpa consegue instalar, ligar e autorizar o próprio chat sem precisar de conhecimento prévio nenhum.

**Architecture:** três peças independentes. (1) O pareamento é uma função pura nova em `src/gateway/pareamento.ts`, plugada como dependência **opcional** de `rotear` — a política de allowlist continua num lugar só, e nada muda para quem já tem allowlist real. (2) A reescrita do `.env` é texto puro (`src/env-arquivo.ts`) + uma escrita atômica injetada, para que os testes não toquem disco. (3) `start.sh`, `scripts/instalar.sh` e o README são shell e markdown, verificados à mão.

**Tech Stack:** TypeScript ESM (Node 22+), vitest, grammy, bash.

## Global Constraints

- **A suíte está em 797/797 verdes e termina assim.** `npx vitest run` no fim de cada tarefa.
- **Nada de dependência nova.** Nem no `package.json`, nem `dotenv`, nem lib de escrita atômica.
- **O pin `playwright: "1.57.0"` não muda neste plano.** É fora de escopo, declarado na spec.
- **`ALLOWED_CHAT_IDS` vazio continua erro de boot.** `exigir` (`src/config.ts:43`) não é tocado. O único sentinela de pareamento é o valor `0`.
- **Estado de pareamento = `chatsPermitidos` é exatamente `[0]`.** Nem `[0,123]`, nem lista vazia.
- **Fora de pareamento, chat desconhecido recebe silêncio (`[]`).** O bot nunca ecoa chat id para estranho depois de pareado.
- **Toda função nova recebe I/O por parâmetro**, como `carregarConfig(env)` já faz. Teste não escreve no disco.
- **Comentário de código em português**, explicando *por que*, no estilo dos arquivos vizinhos.
- **Autor dos commits:** `inematds <inematds@gmail.com>` (já é o `git config` local).

---

### Task 1: Reescrita da linha do `.env` (texto puro + escrita atômica)

**Files:**
- Create: `src/env-arquivo.ts`
- Test: `src/env-arquivo.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `trocarValorEnv(texto: string, chave: string, valor: string): string`
  - `gravarEnv(caminho: string, texto: string, io: EscritaEnv): void`
  - `interface EscritaEnv { escrever(caminho: string, texto: string): void; renomear(de: string, para: string): void; permissao(caminho: string, modo: number): void }`

- [ ] **Step 1: Write the failing test**

```ts
// src/env-arquivo.test.ts
import { describe, it, expect, vi } from 'vitest';
import { trocarValorEnv, gravarEnv, type EscritaEnv } from './env-arquivo.js';

describe('trocarValorEnv', () => {
  it('troca só a linha da chave e preserva comentários, ordem e demais linhas', () => {
    const antes = [
      '# allowlist: quem pode falar com o bot',
      'BOT_TOKEN=123:abc',
      'ALLOWED_CHAT_IDS=0',
      '',
      'LOG_FILE=/tmp/x.log',
    ].join('\n');

    const depois = trocarValorEnv(antes, 'ALLOWED_CHAT_IDS', '4242');

    expect(depois).toBe([
      '# allowlist: quem pode falar com o bot',
      'BOT_TOKEN=123:abc',
      'ALLOWED_CHAT_IDS=4242',
      '',
      'LOG_FILE=/tmp/x.log',
    ].join('\n'));
  });

  it('acrescenta a chave no fim quando ela não existe, sem duplicar quebra de linha', () => {
    expect(trocarValorEnv('BOT_TOKEN=1\n', 'ALLOWED_CHAT_IDS', '7'))
      .toBe('BOT_TOKEN=1\nALLOWED_CHAT_IDS=7\n');
  });

  it('não confunde chave que é prefixo de outra', () => {
    const antes = 'ALLOWED_CHAT_IDS_ANTIGO=9\nALLOWED_CHAT_IDS=0\n';
    expect(trocarValorEnv(antes, 'ALLOWED_CHAT_IDS', '5'))
      .toBe('ALLOWED_CHAT_IDS_ANTIGO=9\nALLOWED_CHAT_IDS=5\n');
  });

  it('ignora a chave dentro de comentário', () => {
    const antes = '# ALLOWED_CHAT_IDS=exemplo\nALLOWED_CHAT_IDS=0\n';
    expect(trocarValorEnv(antes, 'ALLOWED_CHAT_IDS', '5'))
      .toBe('# ALLOWED_CHAT_IDS=exemplo\nALLOWED_CHAT_IDS=5\n');
  });
});

describe('gravarEnv', () => {
  it('escreve em arquivo temporário, renomeia por cima e deixa em 0600', () => {
    const ordem: string[] = [];
    const io: EscritaEnv = {
      escrever: vi.fn((c: string) => { ordem.push(`escrever:${c}`); }),
      renomear: vi.fn((de: string, para: string) => { ordem.push(`renomear:${de}->${para}`); }),
      permissao: vi.fn((c: string, m: number) => { ordem.push(`permissao:${c}:${m.toString(8)}`); }),
    };

    gravarEnv('/casa/.env', 'X=1\n', io);

    expect(io.escrever).toHaveBeenCalledWith('/casa/.env.tmp', 'X=1\n');
    expect(io.renomear).toHaveBeenCalledWith('/casa/.env.tmp', '/casa/.env');
    expect(io.permissao).toHaveBeenCalledWith('/casa/.env', 0o600);
    // O rename tem que vir DEPOIS da escrita: é ele que torna a troca atômica.
    expect(ordem[0]).toBe('escrever:X=1\n');
    expect(ordem[1]).toBe('renomear:/casa/.env.tmp->/casa/.env');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/env-arquivo.test.ts`
Expected: FAIL — `Failed to resolve import "./env-arquivo.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/env-arquivo.ts
// Reescrita cirúrgica de UMA linha do .env. Texto puro aqui, I/O injetado no
// `gravarEnv` — o teste não escreve no disco, e o .env do dono não vira efeito
// colateral de rodar a suíte.

/** Escrita do .env como três operações mínimas. Interface (e não `fs` direto)
 * porque o pareamento precisa ser testável sem tocar em arquivo de verdade. */
export interface EscritaEnv {
  escrever(caminho: string, texto: string): void;
  renomear(de: string, para: string): void;
  permissao(caminho: string, modo: number): void;
}

/**
 * Devolve `texto` com `chave=valor`. Só a linha da chave muda: comentários,
 * ordem e espaçamento ficam byte a byte iguais — o .env é arquivo do dono, e
 * o bot é visita nele.
 */
export function trocarValorEnv(texto: string, chave: string, valor: string): string {
  const linhas = texto.split('\n');
  let achou = false;

  const saida = linhas.map((linha) => {
    // Comentário não é definição: `# ALLOWED_CHAT_IDS=exemplo` continua exemplo.
    if (linha.trimStart().startsWith('#')) return linha;
    const i = linha.indexOf('=');
    if (i <= 0) return linha;
    // Comparação da chave INTEIRA, senão `ALLOWED_CHAT_IDS_ANTIGO` seria pego.
    if (linha.slice(0, i).trim() !== chave) return linha;
    achou = true;
    return `${chave}=${valor}`;
  });

  if (achou) return saida.join('\n');

  // Chave ausente: acrescenta no fim, respeitando a quebra final que já existia.
  const base = texto.endsWith('\n') || texto === '' ? texto : `${texto}\n`;
  return `${base}${chave}=${valor}\n`;
}

/**
 * Grava atômico: escreve num temporário ao lado e renomeia por cima. Sem isso,
 * uma queda no meio da escrita deixaria o .env truncado — e um .env truncado
 * não faz o bot rejeitar mensagem, faz o bot não subir mais.
 */
export function gravarEnv(caminho: string, texto: string, io: EscritaEnv): void {
  const temporario = `${caminho}.tmp`;
  io.escrever(temporario, texto);
  io.renomear(temporario, caminho);
  io.permissao(caminho, 0o600);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/env-arquivo.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/env-arquivo.ts src/env-arquivo.test.ts
git commit -m "o .env ganha reescrita cirúrgica e atômica de uma chave

Texto puro e I/O injetado: o pareamento vai precisar gravar no .env, e nem a
suíte pode escrever no arquivo do dono nem uma queda no meio pode truncá-lo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Regras do pareamento (funções puras)

**Files:**
- Create: `src/gateway/pareamento.ts`
- Test: `src/gateway/pareamento.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `SENTINELA_PAREAMENTO: 0`
  - `emPareamento(chatsPermitidos: number[]): boolean`
  - `ehPingDePareamento(texto: string): boolean`
  - `mensagemDePareamento(chatId: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/gateway/pareamento.test.ts
import { describe, it, expect } from 'vitest';
import { emPareamento, ehPingDePareamento, mensagemDePareamento } from './pareamento.js';

describe('emPareamento', () => {
  it('só é verdade quando a allowlist é exatamente [0]', () => {
    expect(emPareamento([0])).toBe(true);
  });

  it('allowlist real não está em pareamento', () => {
    expect(emPareamento([4242])).toBe(false);
  });

  it('0 misturado com id real NÃO abre pareamento', () => {
    // Senão um .env com "0,4242" viraria porta aberta sem ninguém pedir.
    expect(emPareamento([0, 4242])).toBe(false);
  });

  it('lista vazia não está em pareamento (vazio é erro de boot, não estado)', () => {
    expect(emPareamento([])).toBe(false);
  });
});

describe('ehPingDePareamento', () => {
  it('aceita /ping', () => {
    expect(ehPingDePareamento('/ping')).toBe(true);
  });

  it('aceita /ping com espaços em volta', () => {
    expect(ehPingDePareamento('  /ping  ')).toBe(true);
  });

  it('aceita o sufixo @nome_do_bot que o Telegram acrescenta em grupo', () => {
    expect(ehPingDePareamento('/ping@inemaccbot')).toBe(true);
  });

  it('recusa qualquer outro comando', () => {
    expect(ehPingDePareamento('/fila')).toBe(false);
    expect(ehPingDePareamento('oi')).toBe(false);
    expect(ehPingDePareamento('/pingar')).toBe(false);
    expect(ehPingDePareamento('/ping agora')).toBe(false);
  });
});

describe('mensagemDePareamento', () => {
  it('confirma, mostra o id e ensina a trocar de dono', () => {
    const m = mensagemDePareamento(4242);
    expect(m).toContain('4242');
    expect(m).toContain('ALLOWED_CHAT_IDS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/pareamento.test.ts`
Expected: FAIL — `Failed to resolve import "./pareamento.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gateway/pareamento.ts
// Primeiro contato: com a allowlist em `0`, o primeiro /ping cadastra o chat.
// Decisão do dono (spec 2026-08-08), tomada com o risco na mesa: quem chegar
// primeiro leva o bot. O que dá pra estreitar sem contrariar a decisão está
// estreitado aqui — só texto, só /ping, só no estado sentinela.

/** `0` não é id de chat nenhum no Telegram, por isso serve de sentinela sem
 *  ambiguidade: `ALLOWED_CHAT_IDS=0` significa "ainda não tem dono". */
export const SENTINELA_PAREAMENTO = 0;

/** Exatamente `[0]`. `[0,123]` é allowlist real com lixo dentro, não convite. */
export function emPareamento(chatsPermitidos: number[]): boolean {
  return chatsPermitidos.length === 1 && chatsPermitidos[0] === SENTINELA_PAREAMENTO;
}

/** Só `/ping` pareia. Em grupo o Telegram manda `/ping@nome_do_bot`, então o
 *  sufixo é aceito; qualquer argumento depois do comando, não. */
export function ehPingDePareamento(texto: string): boolean {
  return /^\/ping(@[A-Za-z0-9_]+)?$/.test(texto.trim());
}

export function mensagemDePareamento(chatId: number): string {
  return [
    `Pareado. Este chat (id ${chatId}) agora é o dono do bot.`,
    '',
    `Gravei em ALLOWED_CHAT_IDS no .env. Para trocar de dono depois: ponha`,
    `ALLOWED_CHAT_IDS=0 de volta, reinicie, e mande /ping do chat novo.`,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gateway/pareamento.test.ts`
Expected: PASS (9 testes).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/pareamento.ts src/gateway/pareamento.test.ts
git commit -m "as regras do pareamento, puras e estreitas

Sentinela é a allowlist ser exatamente [0]; só /ping em texto pareia. A porta
mais larga possível seria qualquer mensagem, e estreitar não custa nada a quem
instala — /ping já é o primeiro comando do README.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `rotear` pareia antes de rejeitar

**Files:**
- Modify: `src/gateway/telegram.ts` (a função `rotear`, hoje em `:79-97`)
- Test: `src/gateway/telegram.test.ts` (acrescentar ao `describe('rotear')`, hoje em `:48`)

**Interfaces:**
- Consumes: `emPareamento`, `ehPingDePareamento`, `mensagemDePareamento` (Task 2).
- Produces: `rotear` ganha a dependência **opcional** `parear?: (chatId: number) => string`, que devolve a mensagem a responder. Ausente = comportamento de hoje, byte a byte.

**Por que dependência opcional e não leitura de `cfg`:** `rotear` é pura e não conhece `Config`. Quem decide se há pareamento é `criarBot` (Task 4), que tem o `cfg` na mão.

- [ ] **Step 1: Write the failing test**

```ts
// acrescentar dentro de describe('rotear', ...) em src/gateway/telegram.test.ts
it('em pareamento, /ping de chat desconhecido pareia e responde', async () => {
  const log = vi.fn();
  const parear = vi.fn(() => 'Pareado. id 4242');
  const aoComando = vi.fn();

  const r = await rotear(
    { chatId: 4242, texto: '/ping' },
    { permitido: () => false, aoComando, log, parear },
  );

  expect(r).toEqual(['Pareado. id 4242']);
  expect(parear).toHaveBeenCalledWith(4242);
  // O comando NÃO roda nesta mensagem: parear é o efeito, e só.
  expect(aoComando).not.toHaveBeenCalled();
});

it('em pareamento, mensagem que não é /ping continua rejeitada em silêncio', async () => {
  const log = vi.fn();
  const parear = vi.fn(() => 'nunca');

  const r = await rotear(
    { chatId: 4242, texto: '/fila' },
    { permitido: () => false, aoComando: vi.fn(), log, parear },
  );

  expect(r).toEqual([]);
  expect(parear).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('gateway: mensagem rejeitada — chat 4242 fora da allowlist');
});

it('sem `parear` (fora de pareamento), /ping de desconhecido é silêncio — nunca ecoa o id', async () => {
  const log = vi.fn();

  const r = await rotear(
    { chatId: 4242, texto: '/ping' },
    { permitido: () => false, aoComando: vi.fn(), log },
  );

  expect(r).toEqual([]);
  expect(log).toHaveBeenCalledWith('gateway: mensagem rejeitada — chat 4242 fora da allowlist');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/telegram.test.ts -t pareamento`
Expected: FAIL — o primeiro teste recebe `[]` em vez da mensagem (a dep `parear` é ignorada).

- [ ] **Step 3: Write minimal implementation**

Em `src/gateway/telegram.ts`, importar do módulo novo e trocar o bloco de rejeição de `rotear`:

```ts
import { ehPingDePareamento } from './pareamento.js';
```

```ts
export async function rotear(
  entrada: { chatId: number; texto: string },
  deps: {
    permitido: (chatId: number) => boolean;
    aoComando: (chatId: number, texto: string) => Promise<string>;
    log: (m: string) => void;
    /** Presente SÓ enquanto o bot está sem dono (allowlist `[0]`). Ausente é o
     *  caso normal, e aí a rejeição é exatamente a de sempre: silêncio. */
    parear?: (chatId: number) => string;
  },
): Promise<string[]> {
  const { chatId, texto } = entrada;

  if (!deps.permitido(chatId)) {
    if (deps.parear && ehPingDePareamento(texto)) {
      return cortar(deps.parear(chatId));
    }
    deps.log(`gateway: mensagem rejeitada — chat ${chatId} fora da allowlist`);
    return [];
  }
  // ... resto inalterado
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gateway/telegram.test.ts`
Expected: PASS, incluindo o teste antigo de rejeição (`:49`), que não passa `parear` e portanto não muda.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/telegram.ts src/gateway/telegram.test.ts
git commit -m "rotear pareia antes de rejeitar, e só quando lhe dão a permissão

A dep \`parear\` é opcional: sem ela o caminho de rejeição é o de sempre, byte
a byte. É o que garante que o bot pareado nunca ecoe chat id para estranho.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `criarBot` liga o pareamento — memória antes do disco

**Files:**
- Modify: `src/gateway/telegram.ts` (`criarBot`, hoje em `:176-200`)
- Test: `src/gateway/telegram.test.ts` (`describe('criarBot')`, hoje em `:157`)

**Interfaces:**
- Consumes: `emPareamento`, `mensagemDePareamento` (Task 2); `rotear` com `parear` (Task 3).
- Produces: `criarBot` ganha a dep opcional `persistirAllowlist?: (ids: number[]) => void`. Task 5 injeta a implementação real a partir do `index.ts`.

**O bug que esta tarefa existe para evitar:** `carregarConfig` roda uma vez no boot e `permitido` fecha sobre `cfg.chatsPermitidos`. Persistir só no arquivo faria o bot responder "pareado" e rejeitar a mensagem seguinte até reiniciar. Por isso a mutação **in-place** do array (`splice`), e não `cfg.chatsPermitidos = [...]`.

- [ ] **Step 1: Write the failing test**

```ts
// acrescentar dentro de describe('criarBot', ...) em src/gateway/telegram.test.ts
it('pareia: muta a allowlist em memória ANTES de persistir, e o chat já passa a valer', async () => {
  const ordem: string[] = [];
  const cfg = { botToken: 'x', chatsPermitidos: [0] } as unknown as Config;
  const persistirAllowlist = vi.fn(() => { ordem.push('persistiu'); });
  const aoComando = vi.fn(async () => 'pong');

  const { bot } = criarBot(cfg, { aoComando, log: vi.fn(), persistirAllowlist });
  // (usar o mesmo mecanismo de simulação de update que os testes vizinhos de
  //  criarBot já usam neste arquivo — não inventar um novo)
  await simularTexto(bot, { chatId: 4242, texto: '/ping' });

  expect(cfg.chatsPermitidos).toEqual([4242]);
  expect(persistirAllowlist).toHaveBeenCalledWith([4242]);
  // A memória vem primeiro: a resposta "pareado" só é verdade se o chat já
  // estiver autorizado quando ela sai.
  expect(ordem).toEqual(['persistiu']);
  expect(aoComando).not.toHaveBeenCalled();
});

it('depois de pareado, um segundo chat NÃO entra', async () => {
  const cfg = { botToken: 'x', chatsPermitidos: [0] } as unknown as Config;
  const { bot } = criarBot(cfg, { aoComando: vi.fn(async () => 'pong'), log: vi.fn(), persistirAllowlist: vi.fn() });

  await simularTexto(bot, { chatId: 4242, texto: '/ping' });
  await simularTexto(bot, { chatId: 9999, texto: '/ping' });

  expect(cfg.chatsPermitidos).toEqual([4242]);
});

it('falha ao persistir NÃO derruba o pareamento em memória, e loga o valor a pôr na mão', async () => {
  const log = vi.fn();
  const cfg = { botToken: 'x', chatsPermitidos: [0] } as unknown as Config;
  const persistirAllowlist = vi.fn(() => { throw new Error('EROFS'); });

  const { bot } = criarBot(cfg, { aoComando: vi.fn(async () => 'pong'), log, persistirAllowlist });
  await simularTexto(bot, { chatId: 4242, texto: '/ping' });

  expect(cfg.chatsPermitidos).toEqual([4242]);
  const linhas = log.mock.calls.map((c) => String(c[0]));
  expect(linhas.some((l) => l.includes('EROFS') && l.includes('4242'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/telegram.test.ts -t pareia`
Expected: FAIL — `cfg.chatsPermitidos` continua `[0]`.

- [ ] **Step 3: Write minimal implementation**

Em `criarBot`, depois de `const permitido = ...`:

```ts
  // Pareamento só existe enquanto o bot está sem dono. Fora disso, `parear`
  // fica `undefined` e `rotear` volta a ser exatamente o que sempre foi.
  const parear = emPareamento(cfg.chatsPermitidos)
    ? (chatId: number): string => {
        // MEMÓRIA PRIMEIRO, e in-place: `permitido` fecha sobre este array, e
        // reatribuir `cfg.chatsPermitidos` deixaria o closure vendo o antigo.
        cfg.chatsPermitidos.splice(0, cfg.chatsPermitidos.length, chatId);
        log(`gateway: pareado — chat ${chatId} virou dono do bot`);
        try {
          deps.persistirAllowlist?.(cfg.chatsPermitidos);
        } catch (erro) {
          // Disco read-only não pode custar a sessão: o chat continua valendo
          // até o próximo restart, e o log diz o que pôr no .env na mão.
          const detalhe = erro instanceof Error ? erro.message : String(erro);
          log(`gateway: pareado em memória, mas falhei ao gravar o .env (${detalhe}) — ponha ALLOWED_CHAT_IDS=${chatId} à mão`);
        }
        return mensagemDePareamento(chatId);
      }
    : undefined;
```

e passar `parear` na chamada de `rotear` dentro de `bot.on('message:text')`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, 797 + os novos.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/telegram.ts src/gateway/telegram.test.ts
git commit -m "o pareamento vale na hora: memória primeiro, disco depois

carregarConfig roda uma vez no boot e permitido() fecha sobre o array — por
isso a mutação é in-place. Persistir só no arquivo faria o bot dizer 'pareado'
e rejeitar a mensagem seguinte até reiniciar.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `index.ts` injeta a persistência real

**Files:**
- Modify: `src/index.ts` (`criarTransporteReal` em `:654-675`; `main` em `:677-681`)
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: `trocarValorEnv`, `gravarEnv`, `EscritaEnv` (Task 1); `criarBot` com `persistirAllowlist` (Task 4).
- Produces: `persistirAllowlistNoEnv(caminho: string, ids: number[], io: EscritaEnv & { ler(caminho: string): string }): void`, exportada de `src/index.ts` para o teste.

- [ ] **Step 1: Write the failing test**

```ts
// src/index.test.ts
import { persistirAllowlistNoEnv } from './index.js';

describe('persistirAllowlistNoEnv', () => {
  it('lê o .env, troca só a allowlist e grava atômico', () => {
    const escritas: Array<[string, string]> = [];
    const io = {
      ler: () => '# dono\nBOT_TOKEN=1\nALLOWED_CHAT_IDS=0\n',
      escrever: (c: string, t: string) => { escritas.push([c, t]); },
      renomear: vi.fn(),
      permissao: vi.fn(),
    };

    persistirAllowlistNoEnv('/casa/.env', [4242], io);

    expect(escritas[0][0]).toBe('/casa/.env.tmp');
    expect(escritas[0][1]).toBe('# dono\nBOT_TOKEN=1\nALLOWED_CHAT_IDS=4242\n');
    expect(io.renomear).toHaveBeenCalledWith('/casa/.env.tmp', '/casa/.env');
  });

  it('grava vários ids separados por vírgula, no formato que carregarConfig lê', () => {
    const escritas: string[] = [];
    persistirAllowlistNoEnv('/casa/.env', [1, 2], {
      ler: () => 'ALLOWED_CHAT_IDS=0\n',
      escrever: (_c: string, t: string) => { escritas.push(t); },
      renomear: vi.fn(),
      permissao: vi.fn(),
    });
    expect(escritas[0]).toBe('ALLOWED_CHAT_IDS=1,2\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts -t persistirAllowlistNoEnv`
Expected: FAIL — `persistirAllowlistNoEnv is not a function`.

- [ ] **Step 3: Write minimal implementation**

Em `src/index.ts`:

```ts
import { trocarValorEnv, gravarEnv, type EscritaEnv } from './env-arquivo.js';

/** Persistência do pareamento. I/O injetado pelo mesmo motivo do resto do
 *  arquivo: teste não escreve no .env de ninguém. */
export function persistirAllowlistNoEnv(
  caminho: string,
  ids: number[],
  io: EscritaEnv & { ler(caminho: string): string },
): void {
  // Vírgula sem espaço: é o formato que `carregarConfig` já parseia.
  const texto = trocarValorEnv(io.ler(caminho), 'ALLOWED_CHAT_IDS', ids.join(','));
  gravarEnv(caminho, texto, io);
}
```

Fiação em `criarTransporteReal` — ele passa a receber `caminhoEnv` de `main` e a repassar:

```ts
    persistirAllowlist: (ids: number[]): void => {
      persistirAllowlistNoEnv(caminhoEnv, ids, {
        ler: (c) => readFileSync(c, 'utf8'),
        escrever: (c, t) => { writeFileSync(c, t, { mode: 0o600 }); },
        renomear: (de, para) => { renameSync(de, para); },
        permissao: (c, m) => { chmodSync(c, m); },
      });
    },
```

Ajustar os imports de `node:fs` (`writeFileSync`, `renameSync`, `chmodSync`) e passar `arquivo` (o caminho do `.env` já calculado em `main`, `:678`) adiante.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run` e `npm run typecheck`
Expected: ambos verdes.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "o pareamento chega ao disco: index injeta a escrita real do .env

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Teste de integração do pareamento ponta a ponta

**Files:**
- Create: `src/integracao/pareamento.test.ts`

**Interfaces:**
- Consumes: tudo das tarefas 1–5.
- Produces: nada (só teste).

**Por que separado:** `src/integracao/` é a pasta que o `arquitetura.test.ts` isenta do mapa de fronteiras (`:35`) — é onde teste que cruza camadas mora legitimamente.

- [ ] **Step 1: Write the failing test**

```ts
// src/integracao/pareamento.test.ts
// O caminho inteiro: .env com ALLOWED_CHAT_IDS=0 -> carregarConfig -> criarBot
// -> /ping -> allowlist viva + .env reescrito. É o teste que teria pego o bug
// de "responde pareado e rejeita a próxima mensagem".
import { describe, it, expect, vi } from 'vitest';
import { carregarConfig } from '../config.js';
import { lerEnv, persistirAllowlistNoEnv } from '../index.js';

describe('pareamento ponta a ponta', () => {
  it('do .env sentinela ao .env com o dono, sem reiniciar', () => {
    let disco = [
      '# preencha com o id do seu chat, ou deixe 0 para parear no primeiro /ping',
      'ALLOWED_CHAT_IDS=0',
      'BOT_TOKEN=123:abc',
      'QUEUE_DB=/tmp/q.db',
      'STATE_DIR=/tmp/state',
      'LOG_FILE=/tmp/x.log',
    ].join('\n') + '\n';

    const cfg = carregarConfig(lerEnv(disco));
    expect(cfg.chatsPermitidos).toEqual([0]);

    // O que criarBot faz ao parear (Task 4), aqui explícito:
    cfg.chatsPermitidos.splice(0, cfg.chatsPermitidos.length, 4242);
    persistirAllowlistNoEnv('/casa/.env', cfg.chatsPermitidos, {
      ler: () => disco,
      escrever: (_c, t) => { disco = t; },
      renomear: vi.fn(),
      permissao: vi.fn(),
    });

    // O .env reescrito produz a mesma allowlist num boot futuro...
    expect(carregarConfig(lerEnv(disco)).chatsPermitidos).toEqual([4242]);
    // ...e o comentário do dono sobreviveu.
    expect(disco).toContain('# preencha com o id do seu chat');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/integracao/pareamento.test.ts`
Expected: PASS (as peças já existem).

- [ ] **Step 3: Commit**

```bash
git add src/integracao/pareamento.test.ts
git commit -m "teste ponta a ponta do pareamento: .env sentinela vira .env com dono

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `start.sh` na raiz

**Files:**
- Create: `start.sh` (raiz do repo, `chmod +x`)

**Interfaces:**
- Consumes: `dist/index.js` (produzido por `npm run build`).
- Produces: nada para o código.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Liga o bot em primeiro plano, com o log na tela. É o "rodar sem systemd" —
# primeira vez, depuração, e o dia em que o serviço não sobe e você quer ver
# por quê. Parar: Ctrl-C.
#
# Uso:
#   ./start.sh             # sobe (recusa se o serviço systemd já estiver de pé)
#   ./start.sh --forcar    # sobe mesmo assim (você sabe o que está fazendo)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FORCAR=0
[ "${1:-}" = "--forcar" ] && FORCAR=1

if [ ! -f .env ]; then
  echo "sem .env — rode ./scripts/instalar.sh primeiro" >&2
  exit 1
fi

# Dois processos no MESMO BOT_TOKEN disputam o getUpdates do Telegram e as
# mensagens somem alternadamente. O sintoma é "o bot ignora metade do que eu
# mando", que é caro de diagnosticar — daí a recusa explícita.
if [ "$FORCAR" = 0 ] && systemctl --user is-active --quiet inemaccbot 2>/dev/null; then
  cat >&2 <<'FIM'
o serviço systemd inemaccbot JÁ está rodando.

Subir um segundo processo no mesmo BOT_TOKEN faz os dois brigarem pelo
getUpdates e o bot passa a perder mensagens. Escolha um:

  systemctl --user stop inemaccbot && ./start.sh   # depurar no terminal
  journalctl --user -u inemaccbot -f               # só ver o log do serviço
  ./start.sh --forcar                              # subir assim mesmo
FIM
  exit 1
fi

# Build só quando falta ou está velho: ligar não pode virar ritual de compilar.
if [ ! -f dist/index.js ] || [ -n "$(find src -name '*.ts' -newer dist/index.js -print -quit 2>/dev/null)" ]; then
  echo "compilando (dist desatualizado)..."
  npm run build
fi

exec node dist/index.js
```

- [ ] **Step 2: Verify it fails cleanly without `.env`**

Run: `mv .env .env.bak 2>/dev/null; ./start.sh; echo "saida=$?"; mv .env.bak .env 2>/dev/null`
Expected: mensagem apontando o `instalar.sh`, `saida=1`. (Se não houver `.env` na máquina, o teste é só a mensagem.)

- [ ] **Step 3: Verify the stale-build detection**

Run: `touch src/index.ts && ./start.sh --forcar`
Expected: imprime "compilando (dist desatualizado)..." e sobe. Ctrl-C para sair.

- [ ] **Step 4: Commit**

```bash
chmod +x start.sh
git add start.sh
git commit -m "start.sh: ligar o bot deixa de ser conhecimento tácito

Primeiro plano, log na tela, recompila se o dist estiver velho e recusa subir
um segundo processo no mesmo BOT_TOKEN — que é a falha que se manifesta como
'o bot ignora metade das mensagens'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `scripts/instalar.sh` para de ensinar o mundo antigo

**Files:**
- Modify: `scripts/instalar.sh` (passo 1 em `:58-61`; passo 3 em `:69-73`; passo 4 em `:75-79`; passo 5 em `:81-91`; resultado em `:111-128`)

**Interfaces:** nenhuma para o código.

- [ ] **Step 1: Passo 1 — detectar devDependencies puladas**

Trocar o bloco `titulo "1. Dependências do projeto"` por:

```bash
titulo "1. Dependências do projeto"
cd "$REPO"
if [ -d node_modules ] && [ "$CHECAR" = 1 ]; then ok "node_modules já existe"
else faca npm ci; fi

# `tsc` é devDependency. Com NODE_ENV=production o npm pula TODAS as devDeps
# sozinho — e o sintoma só aparece lá na frente, como `tsc: not found` no build.
if [ "$CHECAR" = 0 ] && [ ! -x node_modules/.bin/tsc ]; then
  erro "node_modules sem devDependencies (falta o tsc). Causa quase certa: NODE_ENV=production. Refaça com: NODE_ENV=development npm ci --include=dev"
fi
```

- [ ] **Step 2: Passo 3 — CTA virou conferência**

```bash
titulo "3. CTA (versionado nos repos de domínio desde 2026-08-08)"
for r in promoavatar promoavatar3; do
  if [ -f "$PROJETOS/$r/cta/cta-9x16.mp4" ]; then ok "$r/cta/cta-9x16.mp4"
  else erro "falta $PROJETOS/$r/cta/cta-9x16.mp4 — o CTA agora vem no clone: 'cd $PROJETOS/$r && git pull'"; fi
done
```

- [ ] **Step 3: Passo 4 — Chromium sem `--with-deps`**

```bash
titulo "4. Chromium do Playwright (rota | estudio)"
if [ "$CHROMIUM" = 0 ]; then aviso "pulado por --sem-chromium"
elif npx playwright install --dry-run chromium >/dev/null 2>&1 \
     && [ -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" ]; then ok "já instalado"
else
  # SEM --with-deps de propósito: ele carrega uma lista de pacotes por versão de
  # SO e não conhece o Ubuntu 26.04 — era o que travava a instalação lá. Aqui
  # baixamos só o browser; se faltar biblioteca do sistema, o erro aparece no
  # launch e `npx playwright install-deps` é quem sabe a lista (quando sabe).
  faca npx playwright install chromium
  if [ "$CHECAR" = 0 ] && ! node -e "require('playwright').chromium.launch().then(b=>b.close())" >/dev/null 2>&1; then
    aviso "Chromium baixado mas não sobe — provavelmente falta biblioteca do sistema."
    aviso "Tente: npx playwright install-deps    (em SO muito novo ele pode não ter receita)"
    aviso "Isso afeta SÓ a rota | estudio; o resto do bot funciona."
  fi
fi
```

- [ ] **Step 4: Passo 5 — o `.env` ensina o pareamento**

Trocar a linha do `ALLOWED_CHAT_IDS` (hoje `:86`) por:

```bash
  if grep -q '^ALLOWED_CHAT_IDS=.\+' .env; then
    if grep -q '^ALLOWED_CHAT_IDS=0$' .env; then
      aviso "ALLOWED_CHAT_IDS=0 — modo pareamento: o PRIMEIRO /ping que o bot receber vira o dono"
    else ok "ALLOWED_CHAT_IDS preenchido"; fi
  else
    erro "ALLOWED_CHAT_IDS vazio — ponha 0 e o primeiro /ping cadastra seu chat sozinho (vazio derruba o boot)"
  fi
```

- [ ] **Step 5: Resultado — citar o `start.sh`**

No heredoc final, trocar `node dist/index.js          # confira o boot, Ctrl-C` por:

```
    ./start.sh                  # sobe aqui no terminal, Ctrl-C pra sair
```

e acrescentar, na última linha: `No chat: /ping (é ele que pareia, se a allowlist ainda for 0), /ajuda, /fila.`

- [ ] **Step 6: Rodar a verificação**

Run: `./scripts/instalar.sh --checar`
Expected: roda até o fim sem alterar nada; o passo 3 confere o CTA em vez de mandar copiar; o passo 5 relata o estado do `ALLOWED_CHAT_IDS`.

- [ ] **Step 7: Commit**

```bash
git add scripts/instalar.sh
git commit -m "instalar.sh para de ensinar o mundo antigo

Três coisas que já não eram verdade: o CTA precisava ser copiado à mão, o chat
id se descobria lendo o log, e o Chromium vinha com --with-deps (que não
conhece o Ubuntu 26.04 e travou a instalação lá). Mais a detecção de
devDependencies puladas, que é o que produz o 'tsc: not found'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: README

**Files:**
- Modify: `README.md` (§Instalação — passo 5 do `.env` e o passo de ligar; a tabela "o quê / onde / se faltar" em `:168-178`)

**Interfaces:** nenhuma.

- [ ] **Step 1: Seção do chat id**

Acrescentar na §Instalação, onde hoje se fala do `.env`:

```markdown
#### Como descobrir o chat id do Telegram (você não precisa saber de antemão)

Deixe `ALLOWED_CHAT_IDS=0` no `.env`. Isso é o **modo pareamento**: o bot ainda
não tem dono. Suba (`./start.sh`), abra o seu bot no Telegram e mande `/ping`.

O primeiro `/ping` que chegar cadastra aquele chat como dono: o bot responde
confirmando, grava o id em `ALLOWED_CHAT_IDS` no `.env` e fecha a porta — o
segundo chat que tentar já é rejeitado em silêncio.

**O que isso significa:** enquanto a allowlist for `0`, quem mandar `/ping`
primeiro leva o bot. Se o seu token vazou ou alguém sabe o @nome do bot, pareie
antes de deixar rodando. Só `/ping` em texto pareia — anexo e qualquer outra
mensagem, não.

**Trocar de dono:** ponha `ALLOWED_CHAT_IDS=0` de volta, reinicie
(`systemctl --user restart inemaccbot`) e mande `/ping` do chat novo. Para mais
de um chat, edite a lista à mão: `ALLOWED_CHAT_IDS=111,222`.

Deixar `ALLOWED_CHAT_IDS` **vazio** não é pareamento — é erro de boot, de
propósito: a allowlist é a única barreira entre o bot e o Telegram inteiro.
```

- [ ] **Step 2: Seção de ligar**

Onde o README manda `node dist/index.js`, passar a:

```markdown
```bash
./start.sh          # primeiro plano, log na tela, Ctrl-C para sair
```

Ele recusa subir se o serviço systemd já estiver de pé: dois processos no mesmo
`BOT_TOKEN` disputam o `getUpdates` e o bot passa a perder mensagens.
```

- [ ] **Step 3: Nota do Playwright / Ubuntu 26.04**

Na tabela de dependências externas, na linha do Chromium, acrescentar:

```markdown
Em SO recém-lançado (ex.: Ubuntu 26.04) o `--with-deps` falha: a lista de
pacotes dele é por versão de SO. Por isso o instalador baixa só o browser. Se o
Chromium não subir por falta de biblioteca, tente `npx playwright install-deps`
— e saiba que o pin `playwright@1.57.0` pode ser velho demais para o seu SO.
Isso afeta só a rota `| estudio`.
```

- [ ] **Step 4: Linha da allowlist na tabela**

Trocar a linha `**Allowlist de chat**` por:

```markdown
| **Allowlist de chat** | `ALLOWED_CHAT_IDS` no `.env` — ou `0` para parear no primeiro `/ping` | vazio derruba o boot. Com o id errado o bot fica mudo: toda mensagem vira `rejeitada — fora da allowlist` no log |
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "README: como achar o chat id sem saber nada, e como ligar o bot

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Fechamento

- [ ] **Step 1: Suíte e build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: tudo verde, 797 + os novos testes.

- [ ] **Step 2: Verificação de instalação**

Run: `./scripts/instalar.sh --checar`
Expected: sem erro; relata o estado real da máquina.

- [ ] **Step 3: Push**

```bash
git push origin master
```

- [ ] **Step 4: Relatar**

Dizer ao dono, sem enfeite: o número real de testes, o que foi verificado à mão (os scripts), e as duas lacunas que continuam abertas — o bump do Playwright (depende do `npx playwright --version` na VPS) e o fato de que `npm ci` na VPS vai rebaixar o Playwright que ele já tinha atualizado.

## Self-review

**Cobertura da spec:** Parte 1 → Tasks 1–6. Parte 2 → Task 7. Parte 3 → Task 8. Parte 4 → Task 8 (passo 3) + Task 9 (passo 3). Parte 5 → Task 9. Tabela de testes da spec → Tasks 1–6 (cada linha tem teste nomeado). Lacunas conhecidas → Task 9 passo 3 e Task 10 passo 4.

**Consistência de nomes:** `emPareamento`, `ehPingDePareamento`, `mensagemDePareamento`, `SENTINELA_PAREAMENTO` (Task 2) são os mesmos usados nas Tasks 3–4. `trocarValorEnv`/`gravarEnv`/`EscritaEnv` (Task 1) idem nas Tasks 5–6. `parear` (dep de `rotear`) e `persistirAllowlist` (dep de `criarBot`) são distintos de propósito: um é política, o outro é I/O.

**Ponto que exige atenção do implementador:** na Task 4, o teste usa `simularTexto` — não existe uma helper com esse nome hoje. Use o mecanismo que os testes de `criarBot` já usam neste arquivo (`src/gateway/telegram.test.ts:157+`) para injetar um update; se eles usarem outro nome ou construção, siga o deles em vez de criar helper nova.

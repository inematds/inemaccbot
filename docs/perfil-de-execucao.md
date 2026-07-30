# Perfil de execução — motor, modelo e esforço

Todo job `kind=agent` roda com um **perfil de execução**: `{ motor, modelo, esforco }`.

- **motor** — qual agente executa (`claude` hoje; `codex` ou outro amanhã)
- **modelo** — qual modelo daquele motor (`haiku`, `fable`, `sonnet`, `opus`)
- **esforço** — quanto raciocínio (`low`, `medium`, `high`, `xhigh`, `max`)

O perfil efetivo é **gravado no job** (colunas `motor`, `modelo`, `esforco` — ver `src/fila/types.ts`)
e aparece no log de `Worker.passo()` (`src/fila/worker.ts`):

```
[job 412 P#16/mulheres/render] navegador/fluxo-navegador motor=claude modelo=opus esforco=high
```

(Quando o job não tem `flow_ref`, essa parte some do log; quando algum campo do perfil ainda não
foi resolvido, aparece `-` no lugar.) Isso responde à pergunta "com que modelo esse render foi
feito?" sem arqueologia de commit.

## Por que isso existe

No sistema anterior o perfil era **hardcoded em dois lugares**:

| onde (v1) | valor | consequência |
|---|---|---|
| `mkivideos/src/cli-lib.ts:171` | `--model sonnet --effort low` | valia para TODA skill de render |
| `inemaccvbot/src/interpret.ts` | `--model claude-opus-5 --effort low` | só para interpretar texto livre |

Um `explicativo` e um `reelinematds` (que tem revisor independente) rodavam igual, e mudar exigia
editar TypeScript, recompilar e reiniciar o serviço. Aqui é configuração.

## Precedência (`src/dominio/perfil.ts`)

`resolverPerfil` recebe cinco fontes (`FontesPerfil`) e resolve **campo a campo** (motor, modelo e
esforço podem vir de fontes diferentes), da mais forte para a mais fraca:

| # | fonte | onde se escreve | quando usar |
|---|---|---|---|
| 1 | `override` | override do comando, ex. `/explicativo X \| modelo=opus` | teste pontual |
| 2 | `fase` | `fases[].modelo` no `flow.json` | uma fase específica precisa de mais |
| 3 | `registry` | `config/skills.json` / `config/fluxos.json` | **o lugar normal**, por tarefa |
| 4 | `skill.sugere` | `sugere` na declaração da skill | a skill indica o que costuma funcionar |
| 5 | `padrao` | default do ambiente (hoje passado por código; ver nota sobre `.env` no README) | fallback global |

Cada campo ausente numa fonte cai para a próxima; se nenhuma das cinco define o campo, é erro de
programação (a função exige `padrao: Perfil` completo). Depois de resolvido, o perfil passa por
`validar()`: `modelo` e `esforco` fora das tabelas de rank (abaixo) lançam exceção — nunca há
default silencioso para um valor desconhecido.

## O que a própria skill declara

A skill conhece a própria dificuldade. Ela pode declarar duas coisas em `DeclaracaoSkill`:

```jsonc
{
  "sugere": { "modelo": "sonnet", "esforco": "low" },   // preferência FRACA (nível 4)
  "exige":  { "modelo": "opus", "motor": "claude" }      // PISO — eleva, nunca rebaixa
}
```

- **`sugere`** entra na precedência como nível 4: qualquer `override`, `fase` ou `registry` vence.
- **`exige`** é um **piso**, aplicado *depois* da resolução principal: se o perfil resolvido tem um
  `modelo`/`esforco` com rank menor que o exigido, o valor é **elevado** e um aviso é registrado
  (`skill exige modelo opus — elevado`). Para `motor`, a comparação é por igualdade, não por rank
  (`skill exige motor claude — aplicado`). Serve para o caso legítimo "esta skill não funciona
  abaixo de X" — por exemplo uma skill com revisor independente, ou uma que só roda no motor com
  navegador pareado (`exige.motor = "claude"`).
- Um **override explícito do operador que bate exatamente com o valor resolvido** fura o piso — a
  decisão final é do operador — mas gera aviso (`override usa modelo haiku, abaixo do exigido pela
  skill (opus)` / `override usa motor X, mas a skill exige Y`). Nada é rebaixado em silêncio: o
  aviso entra em `ResolucaoPerfil.avisos`, sempre, mesmo quando o piso vence.
- Depois de aplicar o piso, `validar()` roda de novo — um `exige` mal escrito (modelo fora da
  tabela) também lança erro, não é ignorado.

A comparação usa `MODELOS_RANK` (`haiku 1 < fable 2 < sonnet 3 < opus 4`) e `ESFORCOS_RANK`
(`low 1 < medium 2 < high 3 < xhigh 4 < max 5`), ambos exportados de `src/dominio/perfil.ts`. Um
modelo/esforço fora dessas tabelas é **erro**, não default silencioso — inclui-se um novo modelo
adicionando-o à tabela (e, se for maior que os existentes, ao fim da ordem de rank).

## Portar para outro motor

Só dois arquivos conhecem o motor: `src/fila/runner.ts` (interface `Runner`/`Execucao`/
`ContextoExecucao`, e o registro `RUNNERS`) e `src/fila/runner-*.ts` (implementações — hoje só
`runner-claude.ts`). Um motor novo é da ordem de 100 linhas, no mesmo formato de
`src/fila/runner-claude.ts`:

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
em vez de fazer uma troca tudo-ou-nada. Quem consome o runner escolhido é `Worker.rodarAgente()`
(`src/fila/worker.ts`), que faz `this.opts.runners[ctx.perfil.motor]` e lança
`motor desconhecido: ...` se a entrada não existir em `RUNNERS`.

Checklist de um runner novo, tirado do que `ClaudeRunner` faz hoje:

1. `argumentos*()` como função pura, testável sem subprocesso (ver `runner-claude.test.ts` para o
   padrão: testa a função pura, não o spawn)
2. `spawn` com `detached: true` e **sem `shell: true`**
3. `cancelar()` mata o **process group**, não só o pai (`process.kill(-pid, 'SIGTERM')`, com
   fallback `SIGKILL` depois de um prazo — `ClaudeRunner` usa 2s)
4. `limpar()` remove parciais que o motor deixe para trás (o `ClaudeRunner` não deixa nenhum, por
   isso o método é vazio nele — não assuma que todo motor pode deixar assim)
5. stdout acumulado é o resultado (`aguardar()` resolve com ele, aparado); stderr entra na
   mensagem de erro, truncado (`ClaudeRunner` corta em 500 caracteres)
6. registrar a instância em `RUNNERS` no fim do arquivo (`RUNNERS.codex = new CodexRunner()`)

## O que trocar de motor NÃO resolve

| item | portável? |
|---|---|
| fila, worker, store, perfil | sim — não conhecem o motor |
| `prompts/*.md` dos repos de domínio | sim — markdown agnóstico |
| as skills do catálogo do operador (`~/.claude/skills/`) | **não** — formato Claude Code; outro motor exige adaptar cada uma |
| fase de navegador (`claude --chrome -p`) | **não** — depende da extensão pareada com o Chromium logado |

Portar o `inemaccbot` é barato; portar o catálogo de skills é o trabalho real. A interface existe
para manter a porta aberta, não porque a troca esteja planejada.

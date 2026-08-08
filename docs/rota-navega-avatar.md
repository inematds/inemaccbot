# Rota `| navega` — avatar por clone de template no estúdio

Implementada no `promoavatar` em 2026-08-03. É a quinta rota de avatar (ver
README, "As CINCO rotas"). Ainda **não rodou ponta a ponta**.

## O que ela é

A rota de navegação que já existia (`fluxo-navegador`, do promoclub) manda um
agente montar a cena do zero: escolher avatar, voz, cenário, conferir 16:9,
trocar o look do público, colar a fala, gerar. São muitos passos frágeis, e cada
um custa tokens.

A `| navega` faz outra coisa: acha um projeto-template no HeyGen, usa **`Edit as
New`** e troca **só duas coisas** — o título e a fala. Avatar, voz, cenário,
motor e proporção vêm prontos do template.

O ganho não é cada passo ficar mais barato. É **haver menos passos**.

**Medido em 2026-08-03** (A#18, 1 público): a fase gasta **7,76 M de tokens em
5 min 37 s** (~US$ 3,87 em `claude-sonnet-5`/`low`), contra 884 mil da fase de
texto. Números, o antes-e-depois do conserto da aba oculta e as armadilhas da
rota estão em [`amostra-a18-navega-custo-e-tempo.md`](./amostra-a18-navega-custo-e-tempo.md).

## Um template só, fixo

Decisão de 2026-08-03: **um único template por rodada**, o mesmo para os 12 (ou
36) vídeos do assunto. O look deixa de variar por público — quem diferencia o
público passa a ser o texto e depois o reel.

O template é achado pela **busca por título** (`TEMPLATE-AVATAR`), nunca pegando
"o mais recente" da lista: a lista anda a cada vídeo gerado, e um teste manual no
topo (`TESTE-CREDITOS-v1`) envenenaria a origem. O nome do template é
deliberadamente de outra família que os títulos de produção (`A16-<alvo>-v1`),
para que a busca por título do `heygen.baixar` não tenha como cair nele.

Voltar ao look por público continua possível sem mudar o desenho: bastaria um
template por look (`TEMPLATE-<look>`) e a mesma busca por título.

## O que o reconhecimento no estúdio provou (2026-08-03)

Percorrido à mão no Chromium do `:99`, com as tools de navegador:

1. **`Edit as New` está no ⋮ do CARD**, na grade de Projetos — não no ⋮ da
   página do vídeo, que só tem `Create Template`, `Move to` e `Delete`.
2. **Abre na MESMA aba**, em `app.heygen.com/create-v4/<novo-id>`. Isso é um
   ganho real sobre a rota antiga: o editor abrindo em aba nova era a causa nº 1
   de a fase 2 do promoclub travar (aba nova nasce `hidden`).
3. **O título vem CLONADO, não vazio.** O campo mostra o *placeholder*
   "Untitled Video", mas o `.value` real vem preenchido com o título do projeto
   de origem. Um clone não renomeado vira homônimo do template. Trocar o título
   é obrigatório — e `read_page` não serve para conferir isso, porque mostra o
   placeholder; tem que ler o `.value` por JavaScript.
4. **A fala também vem clonada** e precisa ser substituída.
5. **A proporção é herdada.** Não dá para ler com segurança qual botão está
   selecionado, então a regra "confirme que está em 16:9" do prompt do promoclub
   foi **removida**: era uma checagem que o agente não consegue fazer de
   verdade, e o clique de "conferir" pode mudar o que estava certo. O risco fica
   assumido e dito: **template errado erra todos os públicos em silêncio.**

## Rascunho homônimo não atrapalha o download

`heygen.baixar` acha o vídeo por `video.list` da API e **exige
`status === 'completed'`** (`src/fila/tarefas/heygen.ts:266`). Rascunho não passa
por ali, então um rascunho com título de produção não faz o download baixar a
coisa errada.

O caso de borda que sobra: se um rascunho homônimo aparecesse em `video.list` com
status não-`completed`, `porTitulo` casa o **primeiro** que encontra
(`heygen.ts:153`) e o download ficaria em "ainda não" até o timeout, mesmo com o
vídeo bom existindo. Nunca observado; anotado para quando aparecer.

Por isso o prompt manda, na retentativa, **procurar um rascunho com o título de
produção e continuar dele** em vez de clonar de novo — senão `max_tentativas: 2`
deixa dois rascunhos homônimos para trás. O agente nunca apaga nada no HeyGen;
limpeza é do usuário.

## O setup do navegador é herdado inteiro

Nada aqui reinventa o navegador. Vale tudo que está em
`inemaclubpromover/docs/setup-linux-navegador.md`, que custou caro para
estabilizar:

- `claude --chrome` (sem a flag a extensão não é reconhecida nesta máquina
  ARM64 com Chromium snap);
- Chromium dedicado no display virtual `:99` (Xvfb + openbox), opção B;
- fila `navegador` com concorrência 1 — o `:99` é exclusivo;
- **reusar a aba aberta, nunca abrir aba nova**;
- seleção automática do navegador local, sem perguntar.

**Confirmado na prática nesta sessão:** ao abrir uma aba nova em vez de reusar a
existente, ela veio `document.visibilityState === 'hidden'`, o clique não focou o
campo (`activeElement` ficou no `BODY`) e a digitação não entrou — exatamente o
§7 do doc. No `:99` só existe UMA janela mapeada.

### O reset do `stack99` saiu do papel

O §7.2 do doc marcava como "a fazer no código": reiniciar
`stack99.service` antes de cada fase de navegador, para o Chromium voltar a UMA
aba e o editor não nascer em segundo plano. Agora está em
`src/fila/runner-chrome.ts` (`resetarStack99`), rodando antes do spawn do
`claude --chrome`.

**Reiniciar não basta.** `systemctl restart` volta quando o *serviço* subiu, não
quando o Chromium pintou a janela, carregou `app.heygen.com/projects` e repareou
com a extensão. Soltar o agente nesse intervalo cai no mesmo buraco por outro
caminho: `list_connected_browsers` não acha o navegador local, ou acha uma janela
não mapeada e volta ao `hidden`. Por isso o reset só termina quando
`~/stack99/stack99-check.sh` sai 0 — e esse script verifica **janela MAPEADA**,
não só processo de pé (o bug original era tela preta com tudo rodando).

É **best-effort de propósito**: numa máquina sem `stack99` (dev, CI), falhar ali
derrubaria um job que talvez rodasse bem no navegador do desktop. Quem decide de
verdade se a aba está utilizável é o prompt da fase, que confere
`visibilityState` antes de digitar e para se estiver `hidden`.

**Caveat honesto — isto bloqueia o event loop.** `iniciar()` é síncrono e roda no
worker que serve TODAS as filas, não só a `navegador`. A concorrência 1 protege o
*navegador*; não protege o event loop. Enquanto o reset espera, nenhum outro job
começa e o heartbeat não renova lease nenhum — e o lease é de 60s
(`LEASE_PADRAO_SEGUNDOS`). Por isso o reset inteiro tem orçamento de parede de
**25s**, menos da metade do lease: atrasa outras filas, mas não faz job saudável
perder o lease. Se um dia precisar de mais tempo, a saída **não** é aumentar o
teto — é tirar o reset do caminho síncrono.

## Como usar

```
/promoavatar <assunto> | navega
```

Exclusiva com `| api` e `| creditos` — as três geram o mesmo vídeo, e pedir duas
é recusado. A checagem é por **contagem**, não par a par (`comandos-fluxo.ts`):
com três rotas, testar só `api+creditos` deixaria os outros pares passarem
calados.

Conferir o plano sem gastar nada:

```
/promoavatar <assunto> | alvos=jovens | navega | sombra
```

## Falta fazer

- Rodar ponta a ponta uma vez, com um alvo só.
- Criar o `TEMPLATE-AVATAR` no HeyGen (hoje o prompt aponta para um nome que
  ainda não existe na conta).
- Medir tokens contra a linha de base antes de afirmar qualquer economia.
- Se der certo, portar para o `promoavatar3`.
- Segunda etapa cogitada: trocar o agente por Playwright nos passos mecânicos.

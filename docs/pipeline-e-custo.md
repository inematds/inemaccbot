# Pipeline: decisões medidas e onde o custo mora

> Extraído do `README.md` em 2026-08-09. São três coisas que valem para **qualquer
> fluxo** deste bot — não para um domínio específico — e que só se sabe por medição:
> por que a fase de reel deixou de usar agente, onde o custo de um fluxo realmente
> está, e por que a legenda é decidida no estúdio e não aqui.
>
> Rotas de avatar (quem gera e de que bolso) → [`rotas-de-avatar.md`](rotas-de-avatar.md).
> Boot, filas e desligamento → [`arquitetura.md`](arquitetura.md).

## A fase de reel deixou de ser agente (2026-08-06)

No promoavatar a última fase (`reel`) era `kind: agent`: um prompt de 86 linhas
mandava o modelo (1) extrair `REF` e `público` do NOME do arquivo do avatar,
(2) escolher um slug de workspace, (3) conferir se o `.md` do público existia e
(4) montar uma linha de comando. **Nada disso é decisão** — o bot já conhecia os
quatro dados; foi ele que gerou aquele nome (`entrada-fase.ts:caminhoAvatar`).
Metade do prompt existia só para o modelo não errar o parse de volta.

Hoje é `kind: function` / `reel.montar`. O contrato com o resto do sistema não
mudou: o pipeline continua indo para segundo plano destacado gravando
`.pid`/`.log`/`.err`, e quem vigia continua sendo `render.ts`.

O que isso custava, medido em
[`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md): **US$ 0,18 e
~180k de cache_read por reel, para produzir ~1k de saída**.

**O ganho é custo e superfície de falha, não velocidade.** Medido nos primeiros
reels do A#30 pelo caminho novo: mediana **180s**, contra **220s** pelo caminho
de agente — praticamente o mesmo, e era o esperado, já que o que saiu foi
conversa, não processamento. (A primeira leitura desses números deu "6× mais
lento" e estava errada: `jobs.iniciado_em` não é reescrito na reclamação, então
a subtração incluía a espera na fila. Ver a ressalva de método no doc.) E três defeitos de
produção saíram daí, nenhum do `montar-reel.py`:

- **A#23** — o agente usou a skill global em vez da do projeto e escreveu o HTML
  à mão (`template: None`);
- **A#25** — leu o `{canal}` como se fosse o público e foi procurar
  `textos/A25/lives2.md`, que não existe;
- **A#29** — rodando em `haiku`, escreveu um redirecionamento de shell que o
  portão de permissão recusou (job morto em 58s), e o job seguinte ficou **1h47
  sem produzir uma linha**. Em `sonnet` o mesmo job leva ~3,5 min. Registrado em
  `promoavatar/docs/decisoes-reel.md` (decisão 4).

**A legenda passou a ser padrão em 2026-08-07, e a recusa caiu.** Antes,
`| legenda` era recusada quando a fase de reel era função: o `montar-reel.py`
não legendava, então aceitar em silêncio entregaria reel sem legenda dizendo
que legendou. Agora ele legenda — uma palavra por vez, caixa alta, branca com
acento âmbar na palavra-chave, colada na base da faixa do avatar. O desenho e
o lugar de mudar cor e formato estão em `promoavatar/docs/legenda.md`.

Quem quiser a legenda do ESTÚDIO em vez da nossa precisa dizer `| legenda=nao`:
a do estúdio vem queimada no avatar e não há como removê-la, então as duas
juntas continuam saindo dobradas.

## Onde o custo de um fluxo realmente está

Medição de 11 fluxos (A#19 a A#29, 245 jobs), em
[`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md). No recorte
de cobertura 100% (A#26 e A#27, pipeline novo, todos os jobs casados):

| fase | US$ | participação |
|---|---:|---:|
| `navega-avatar` | 33,05 | **84,6%** |
| `reel` | 4,29 | 11,0% |
| `texto` | 1,74 | 4,5% |
| `baixar` | 0,00 | 0% (`kind: function`) |

Duas conclusões que mudaram o rumo do projeto:

- **A navegação é o custo.** Ela nunca mudou em 11 fluxos (cache_read entre
  3.790k e 5.157k, saída entre 6,3k e 8,0k, sempre) enquanto todo o resto caía.
  É por isso que a rota `| estudio` existe.
- **A fila pesa mais que o agente no relógio de parede.** No A#22 um reel
  esperou 9.293s (2h35) na fila para rodar 938s. Com `render` serializado em 1 e
  12 públicos por fluxo, quem quiser encurtar o fluxo mexe na concorrência, não
  no prompt.

Ressalva de método que vale para qualquer número desse doc: **o bot não registra
token**. Tempo sai do banco (confiável); token sai dos logs de sessão do Claude
Code, casados job a job. É arqueologia, e o doc explica o casamento e o que ele
não prova.

## `heygen.baixar`: **quem decide a legenda é o estúdio**

O `video_status.get` devolve `video_url` (limpo), `video_url_caption` (com a
legenda **queimada** nos pixels) e `caption_url` (legenda solta). A tarefa lê
`video_url_caption` **quando ele vem preenchido**, e cai no `video_url` quando
não vem (`escolherUrl`, `src/fila/tarefas/heygen.ts`).

Isso põe a decisão onde ela é tomada: **gravou com legenda no estúdio, o reel
sai com ela; gravou sem, sai sem.** O bot não escolhe, e não há o que pedir à
API — a URL é pronta (sem `?estilo=`/`?formato=`) e os seis endpoints de legenda
dão 404. Estilo, fonte e posição se decidem no estúdio, antes de renderizar.

Duas consequências que nenhum código desfaz, e que quem grava precisa saber:

- legenda queimada vem enquadrada para **16:9** — no reel 9:16 ela pode ser
  cortada ou colidir com a base;
- se o reel também for montado com `| legenda`, saem **duas**. Ligar uma é
  decidir desligar a outra.

Medido em 2026-08-01 nos 25 vídeos completos mais recentes da conta (todos
gravados sem legenda): `video_url_caption` nulo e `caption_url` vazio em todos —
ou seja, o caminho normal hoje continua sendo o limpo, e esta regra só muda o
dia em que alguém gravar com a legenda ligada. **NÃO testado:** o comportamento
com a legenda ligada no estúdio — os nomes dos campos sugerem que `video_url`
siga limpo e `video_url_caption` passe a vir preenchido, mas não há observação
que prove. O teste custa um vídeo. Detalhe também no README do repo de domínio.

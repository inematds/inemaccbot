# Falhas

Uma linha por falha real. Mais recente no topo. O detalhe longo vira arquivo
separado e é linkado — aqui é só o suficiente para o padrão aparecer.

| data | o que quebrou | menor correção | prompt \| infra |
|---|---|---|---|
| 2026-08-22 | a correção do `/dados` não valeu em produção: `criarTransporteReal` não repassava `aposResponder` ao `criarBot`, e o teste passava porque o transporte FALSO chamava o hook direto (fronteira errada) | repassar, e tornar o campo OBRIGATÓRIO em `criarBot` para o compilador cobrar; teste no handler de verdade | prompt |
| 2026-08-22 | portão do musicavideo abria MUDO desde sempre: a entrega iterava sobre os alvos do fluxo, e um fluxo cujas fases são TODAS de escopo `fluxo` não tem alvo nenhum — laço vazio, nem um aviso | quando a lista de alvos é vazia, entregar uma vez com alvo `''` | prompt |
| 2026-08-22 | `{{artefato:musica}}` pegava a linha de PROGRESSO (`musica: pronto → faixa-1.mp3 (US$ 0.08)`) em vez do recibo do fim, e o portão dizia "não consegui ler" | o campo do recibo vale pela ÚLTIMA ocorrência, não pela primeira | prompt |
| 2026-08-22 | `/dados mvd90` respondeu "reentregando 2 fase(s)" e nada chegou: o dreno dos avisos de fluxo só era chamado depois que um JOB terminava, e a fila estava vazia | `aposResponder` no gateway — depois de responder a um comando, drena o que o comando empilhou | prompt |
| 2026-08-21 | análise morreu com `503` do Gemini, mas o chat disse "o comando falhou: comprimindo pra analise..." — a cauda do log pegou linha de PROGRESSO do yt-dlp em vez do erro | a `cauda()` filtra progresso e prefere a linha que anuncia erro; e o analisevideo passou a esperar 20s–2min no 503, em vez de 30s no total | infra |
| 2026-08-21 | fase `musica` virou `done` com o recibo declarando erro; o portão abriu e a fase seguinte entrou na fila de render sobre uma faixa que não existia (MVD#89) | guarda: recibo com `ERRO:` em início de linha reprova o job, como já valia no resgate pelo arquivo (`a2795f9`) | prompt |
| 2026-08-21 | portão do musicavideo abriu mudo: o bot só sabia ler `textos/<REF>/<alvo>.md`, que é a forma do promoavatar | `portao.mostrar` declarado pelo domínio no `flow.json` (`c9d1b58`) | infra |
| 2026-08-21 | prompts gerados pelo manifesto inventaram um binário (`musicavideo`) e um contrato de saída errado; passaram na validação e falharam só em produção (MVD#87/#88) | o plug passou a IMPORTAR a definição do domínio e sincronizar o manifesto a partir dele (`afe19ef`) | prompt |
| 2026-08-21 | `/musicavideo status` criou um fluxo com o assunto "status" (MVD#88), que rodou e falhou | rotear `status` como subcomando, como já era com `help` (`1ec2ebd`) | infra |
| 2026-08-21 | `\| legenda=nao` era aceito no chat e não fazia nada: só substituía `{legenda}` num campo `entrega` que nenhum domínio tem desde que o reel virou função | a decisão viaja na definição congelada e vira `--sem-legenda` no comando (`ac5c65a`) | infra |
| 2026-08-21 | `./atualizar.sh` guardou no stash alterações não commitadas e reiniciou o serviço sem elas — o bot subiu sem o `/musicavideo` | `git stash pop` (sem correção de código: o stash é o comportamento documentado) | infra |

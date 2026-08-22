# Falhas

Uma linha por falha real. Mais recente no topo. O detalhe longo vira arquivo
separado e é linkado — aqui é só o suficiente para o padrão aparecer.

| data | o que quebrou | menor correção | prompt \| infra |
|---|---|---|---|
| 2026-08-21 | análise morreu com `503` do Gemini, mas o chat disse "o comando falhou: comprimindo pra analise..." — a cauda do log pegou linha de PROGRESSO do yt-dlp em vez do erro | a `cauda()` filtra progresso e prefere a linha que anuncia erro; e o analisevideo passou a esperar 20s–2min no 503, em vez de 30s no total | infra |
| 2026-08-21 | fase `musica` virou `done` com o recibo declarando erro; o portão abriu e a fase seguinte entrou na fila de render sobre uma faixa que não existia (MVD#89) | guarda: recibo com `ERRO:` em início de linha reprova o job, como já valia no resgate pelo arquivo (`a2795f9`) | prompt |
| 2026-08-21 | portão do musicavideo abriu mudo: o bot só sabia ler `textos/<REF>/<alvo>.md`, que é a forma do promoavatar | `portao.mostrar` declarado pelo domínio no `flow.json` (`c9d1b58`) | infra |
| 2026-08-21 | prompts gerados pelo manifesto inventaram um binário (`musicavideo`) e um contrato de saída errado; passaram na validação e falharam só em produção (MVD#87/#88) | o plug passou a IMPORTAR a definição do domínio e sincronizar o manifesto a partir dele (`afe19ef`) | prompt |
| 2026-08-21 | `/musicavideo status` criou um fluxo com o assunto "status" (MVD#88), que rodou e falhou | rotear `status` como subcomando, como já era com `help` (`1ec2ebd`) | infra |
| 2026-08-21 | `\| legenda=nao` era aceito no chat e não fazia nada: só substituía `{legenda}` num campo `entrega` que nenhum domínio tem desde que o reel virou função | a decisão viaja na definição congelada e vira `--sem-legenda` no comando (`ac5c65a`) | infra |
| 2026-08-21 | `./atualizar.sh` guardou no stash alterações não commitadas e reiniciou o serviço sem elas — o bot subiu sem o `/musicavideo` | `git stash pop` (sem correção de código: o stash é o comportamento documentado) | infra |

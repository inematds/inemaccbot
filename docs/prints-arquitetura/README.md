# Prints da página de arquitetura

Capturas da página `guia/arquitetura.html` renderizada no navegador, feitas em
2026-08-15 direto do GitHub Pages
(`https://inematds.github.io/inemaccbot/guia/arquitetura.html`).

Servem para dois usos: verificar que os diagramas SVG renderizam de verdade
(claro e escuro), e ilustrar o sistema fora do navegador — slide, README,
mensagem.

| arquivo | o que mostra |
|---|---|
| `01-cinco-camadas.jpg` | o diagrama principal: CHAT → GATEWAY → FILA → EXECUÇÃO → ENTREGA, com os arquivos reais de cada camada e as 5 filas com suas concorrências |
| `02-promoavatar3-fluxo.jpg` | o fluxo do `promoavatar3` — fases, as 3 rotas de avatar, variantes de prompt e o CTA por variante |
| `03-comparativo-dominios.jpg` | a tabela `promoavatar` vs `promoavatar3` |
| `04-tema-claro.jpg` | a mesma área no tema claro — prova que os SVG usam as variáveis CSS e trocam de tema junto com a página |

**A fonte é o HTML, não estes JPGs.** Se a página mudar, estes prints ficam
velhos e ninguém é avisado — regerar é abrir a URL e capturar de novo.

Duas capturas do lote original foram descartadas: eram artefatos de repaint do
Chrome durante o scroll (tela preta), não problema de layout.

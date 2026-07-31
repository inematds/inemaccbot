// Leitura do roteiro que a fase de texto grava, para o portão de revisão.
//
// O formato é contrato da skill `inemaclub-textos` (seções FALA / SOBREPOSIÇÕES
// / ESTRUTURA), não invenção do bot. Aqui só se extrai a FALA — é o único
// pedaço que vai para o HeyGen, e é por isso que a mensagem do portão não pode
// mandar o arquivo inteiro: quem cola no estúdio precisa do texto falado, não
// das sobreposições de tela (que são instrução para a fase de reel).
//
// Puro de propósito: quem lê disco é o runtime, que injeta o conteúdo. Assim
// esta regra é testável sem tocar em arquivo.

/** Começo da seção falada. O `###` é do template da skill; o resto do título
 * varia ("FALA (texto para o HeyGen — falar exatamente isto)"), então casa-se
 * pelo prefixo e não pela linha inteira. */
const CABECALHO_FALA = /^#{2,4}\s*FALA\b/i;

/** Qualquer cabeçalho markdown encerra a seção — `### SOBREPOSIÇÕES`, o
 * `## Versão 2` de um arquivo antigo, ou o `## ESTRUTURA` do fim. */
const CABECALHO = /^#{1,6}\s/;

/**
 * A PRIMEIRA fala do arquivo.
 *
 * "Primeira" e não "a da versão N" porque o pipeline passou a gerar UMA versão
 * por público (um vídeo por público, já que `tituloEstudio` nomeia um só). Ler
 * a primeira mantém os arquivos ANTIGOS — os que ainda têm três versões —
 * legíveis pelo portão em vez de quebrá-los.
 *
 * Devolve `null` quando não há seção de fala: o chamador precisa distinguir
 * "não achei" de "achei vazio", porque um público sem texto tem que aparecer
 * como falta no chat, não sumir da lista.
 */
export function primeiraFala(markdown: string): string | null {
  const linhas = markdown.split(/\r?\n/);
  const inicio = linhas.findIndex((l) => CABECALHO_FALA.test(l));
  if (inicio < 0) return null;

  const corpo: string[] = [];
  for (const linha of linhas.slice(inicio + 1)) {
    if (CABECALHO.test(linha)) break;
    corpo.push(linha);
  }
  const texto = corpo.join('\n').trim();
  return texto || null;
}

// Contrato de saída de um job `kind=agent`: a ÚLTIMA linha do stdout diz o que
// aconteceu.
//
//   RESULT: /caminho/absoluto/do/artefato.txt   → sucesso
//   ERRO: <motivo curto>                        → falha declarada pelo agente
//
// Portado do `extractResultPath` do mkivideos, com duas correções que o v1 não
// tinha e que custam caro sem elas:
//
//  1. `resultado` do job é o CAMINHO, não o stdout cru. `concluir()` grava o que
//     o runner devolve, e o notificador manda isso para o chat: sem extração, o
//     usuário recebe a transcrição inteira (ou o log do agente) em vez do
//     arquivo.
//  2. Ausência do contrato é FALHA. O v1 tratava "sem RESULT:" como null e
//     seguia; aqui o job falha, porque um agente que não declarou onde gravou é
//     indistinguível de um que não gravou nada.

export class SemContrato extends Error {}

/**
 * Enfeite de markdown em volta da linha de contrato.
 *
 * Aconteceu no A#5: o agente declarou `` `ERRO: skill não encontrada` `` — com
 * crase — e o contrato não casou, então o bot disse "terminou sem declarar"
 * sobre um agente que TINHA declarado. Diagnóstico errado sobre uma falha real
 * custa mais que a falha.
 *
 * Tirar crase, asterisco de negrito e marcador de lista é seguro: nenhum deles
 * pode aparecer num caminho de arquivo válido nem muda o sentido do motivo.
 */
function semEnfeite(linha: string): string {
  return linha.replace(/^[\s>*_`-]+/, '').replace(/[\s*_`]+$/, '');
}

function ultimaLinhaCasando(texto: string, re: RegExp): string | null {
  let achado: string | null = null;
  for (const linha of texto.split('\n')) {
    const m = semEnfeite(linha).match(re);
    if (m) achado = m[1].trim();
  }
  return achado;
}

/**
 * `exts` restringe as extensões aceitas — é o que impede um `dublar` de
 * responder com um `.txt` (ou com um caminho qualquer que o agente inventou).
 * Lança `SemContrato` quando o agente declarou `ERRO:` ou quando não declarou
 * nada; quem chama transforma isso em falha do job.
 */
/**
 * Contrato do trabalho DESTACADO (etapa 3): o agente não terminou o trabalho —
 * ele o disparou, e declara ONDE o artefato vai aparecer.
 *
 *   RENDER: /caminho/do/alvo.mp4
 *
 * Aceita `RESULT:` também, porque um agente que conseguiu terminar inline (um
 * vídeo curto, um cache quente) não deve ser punido por ter sido rápido demais —
 * quem espera pelo arquivo lida com os dois casos igual.
 */
export function extrairAlvo(bruto: string, exts: string[]): string {
  const texto = String(bruto ?? '');
  const alt = exts.map((e) => e.replace(/^\./, '')).join('|');
  const alvo = ultimaLinhaCasando(texto, new RegExp(`^\\s*(?:RENDER|RESULT):\\s*(\\S+\\.(?:${alt}))\\s*$`, 'i'));
  if (alvo) return alvo;

  const motivo = ultimaLinhaCasando(texto, /^\s*ERRO:\s*(.+)$/i);
  if (motivo) throw new SemContrato(`o agente reportou erro: ${motivo}`);
  throw new SemContrato(
    'o agente terminou sem declarar "RENDER: <caminho>" nem "ERRO: <motivo>" na última linha',
  );
}

export function extrairArtefato(bruto: string, exts: string[]): string {
  const texto = String(bruto ?? '');
  const alt = exts.map((e) => e.replace(/^\./, '')).join('|');
  const caminho = ultimaLinhaCasando(texto, new RegExp(`^\\s*RESULT:\\s*(\\S+\\.(?:${alt}))\\s*$`, 'i'));
  if (caminho) return caminho;

  const motivo = ultimaLinhaCasando(texto, /^\s*ERRO:\s*(.+)$/i);
  if (motivo) throw new SemContrato(`o agente reportou erro: ${motivo}`);

  // Um `RESULT:` com extensão errada é mais informativo que "não achei nada" —
  // sem esta distinção, um bug de extensão vira meia hora de leitura de log.
  const qualquer = ultimaLinhaCasando(texto, /^\s*RESULT:\s*(\S+)\s*$/i);
  if (qualquer) {
    throw new SemContrato(
      `o agente devolveu "${qualquer}", que não termina em ${exts.map((e) => `.${e}`).join(' ou ')}`,
    );
  }
  throw new SemContrato(
    'o agente terminou sem declarar "RESULT: <caminho>" nem "ERRO: <motivo>" na última linha',
  );
}

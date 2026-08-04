// Trocar a imagem de um segmento pela imagem QUE A PESSOA MANDOU no chat.
//
// Por que existe: as imagens do reel são decididas na fase de texto (a seção
// `## IMAGENS` de cada arquivo de público) e revisadas no portão. Quem revisa
// está no Telegram, não num terminal — pedir "edite o .md e acrescente uma
// linha" não é uma opção real. Então o bot escreve a linha.
//
// O formato é o que `preparar.py` (skill do reel) já lê:
//
//     IMAGEM 1 — "primeiras palavras do segmento" [ATENÇÃO/capa]
//     arquivo: /caminho/da/imagem.png
//     modo: cover
//     <prompt visual, que passa a ser ignorado>
//
// `modo` é opcional e só vale para imagem enviada: o default (`contain`) faz a
// imagem caber INTEIRA, com o resto preenchido por uma cópia borrada dela — uma
// capa já produzida não pode ser cortada. `cover` preenche cortando, para
// quando a imagem é só ambiente.

/** Uma linha `IMAGEM <n> — ...` dentro da seção `## IMAGENS`. */
const CABECALHO = /^\s*IMAGEM\s+(\d+)\s*[—-]/;
/** Linhas que ESTE código gerencia — reescrevê-las é idempotente. */
const GERENCIADA = /^\s*(arquivo|modo)\s*:/i;

export type PedidoCapa = {
  /** Número da imagem no roteiro visual. 1 é a capa do feed. */
  n: number;
  /** Caminho absoluto do arquivo já baixado. */
  arquivo: string;
  /** `contain` (default, não corta) ou `cover`. */
  modo?: 'contain' | 'cover';
};

export type ResultadoCapa =
  | { ok: true; texto: string; segmento: string; substituiu: boolean }
  | { ok: false; erro: string };

/**
 * Devolve o conteúdo do `.md` com a imagem `n` apontando para `arquivo`.
 *
 * Puro de propósito: quem lê e grava disco é o chamador. Isso deixa o caso
 * difícil (achar a seção, respeitar o que já existe, ser idempotente) coberto
 * por teste sem tocar em arquivo nenhum.
 *
 * Recusa em vez de adivinhar quando a seção ou a imagem não existem: escrever
 * uma linha órfã faria o `preparar.py` gerar a imagem normalmente e a pessoa
 * descobriria só no vídeo pronto que a capa dela foi ignorada.
 */
export function comCapa(md: string, pedido: PedidoCapa): ResultadoCapa {
  const linhas = md.split('\n');
  const iSecao = linhas.findIndex((l) => /^##\s*IMAGENS\s*$/.test(l));
  if (iSecao < 0) {
    return {
      ok: false,
      erro: 'este texto não tem seção `## IMAGENS` — ele foi gerado por uma versão '
        + 'anterior do prompt. Refaça a fase de texto para poder trocar a imagem.',
    };
  }

  // Onde a seção termina: o próximo `## ` ou o fim do arquivo.
  let fimSecao = linhas.length;
  for (let i = iSecao + 1; i < linhas.length; i += 1) {
    if (/^##\s/.test(linhas[i]!)) { fimSecao = i; break; }
  }

  const iCabecalho = linhas.findIndex((l, i) => {
    if (i <= iSecao || i >= fimSecao) return false;
    const m = CABECALHO.exec(l);
    return m !== null && Number(m[1]) === pedido.n;
  });
  if (iCabecalho < 0) {
    const existentes = linhas
      .slice(iSecao + 1, fimSecao)
      .map((l) => CABECALHO.exec(l)?.[1])
      .filter((x): x is string => Boolean(x));
    return {
      ok: false,
      erro: existentes.length
        ? `não existe IMAGEM ${pedido.n} neste público — há ${existentes.join(', ')}.`
        : 'a seção `## IMAGENS` está vazia.',
    };
  }

  // Tira as linhas gerenciadas que já estavam ali (troca de capa é comum: a
  // pessoa manda uma, olha, e manda outra). Sem isso acumularia `arquivo:`
  // duplicado e o parser da skill pegaria o primeiro — a imagem VELHA.
  const fim = (() => {
    for (let i = iCabecalho + 1; i < fimSecao; i += 1) {
      if (CABECALHO.test(linhas[i]!)) return i;
    }
    return fimSecao;
  })();
  const corpo = linhas.slice(iCabecalho + 1, fim);
  const substituiu = corpo.some((l) => GERENCIADA.test(l));
  const limpo = corpo.filter((l) => !GERENCIADA.test(l));

  const novas = [`arquivo: ${pedido.arquivo}`];
  if (pedido.modo === 'cover') novas.push('modo: cover');

  const texto = [
    ...linhas.slice(0, iCabecalho + 1),
    ...novas,
    ...limpo,
    ...linhas.slice(fim),
  ].join('\n');

  // O trecho entre aspas do cabeçalho é a frase da fala em que a imagem entra —
  // é o que permite responder "sua capa entra em qual momento do vídeo?".
  const segmento = /"([^"]*)"/.exec(linhas[iCabecalho]!)?.[1] ?? '';
  return { ok: true, texto, segmento, substituiu };
}

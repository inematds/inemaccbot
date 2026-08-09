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
  let achou = false;

  const saida = texto.split('\n').map((linha) => {
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
  const base = texto === '' || texto.endsWith('\n') ? texto : `${texto}\n`;
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

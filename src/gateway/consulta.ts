// CONSULTAS de domínio: `/musicavideo lista`, `/analisevideo busca rock`.
//
// Os domínios já sabiam responder — `lista`, `busca`, `estilos` existem nos CLIs
// deles há tempo. O que faltava era poder perguntar do celular sem abrir um
// terminal, e sem inventar um comando novo no bot para cada domínio: quem
// declara o que dá para perguntar é o `flow.json`.
//
// LEITURA por contrato. Não entram na fila, não geram artefato, não gastam: se
// uma consulta custa dinheiro ou demora, ela não é consulta — é fase.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Teto curto: consulta que demora não é consulta. E o chat espera por ela. */
const TETO_MS = 20_000;

/** O que cabe numa mensagem sem virar parede. O resto fica no CLI. */
const MAX_SAIDA = 3_000;

/** Aspas simples POSIX — o texto vem do chat. */
function aspar(s: string): string {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

export function resolverConsulta(molde: string, repo: string, entrada: string): string {
  return molde.replace(/\{\{(\w+)\}\}/g, (_, chave: string) => {
    if (chave === 'repo') return /^[\w/.@+-]+$/.test(repo) ? repo : aspar(repo);
    if (chave === 'input') return aspar(entrada);
    return aspar('');
  });
}

/**
 * Roda a consulta e devolve a saída para o chat.
 *
 * Erro do domínio volta como texto, não como exceção: quem perguntou "quais
 * estilos existem" merece a mensagem do CLI, não um "algo deu errado".
 */
export async function rodarConsulta(
  comando: string, cwd: string,
): Promise<string> {
  if (!existsSync(cwd)) return `o repo do domínio não existe nesta máquina: ${cwd}`;
  return new Promise<string>((resolve) => {
    execFile('bash', ['-c', comando], { cwd, timeout: TETO_MS, maxBuffer: 1_000_000 },
      (erro, out, err) => {
        const texto = (out || err || '').trim();
        if (erro && !texto) {
          resolve(`a consulta falhou: ${erro.message}`);
          return;
        }
        resolve(texto.length > MAX_SAIDA
          ? `${texto.slice(0, MAX_SAIDA)}\n\n[…cortado — o resto está no CLI do domínio]`
          : (texto || '(sem saída)'));
      });
  });
}

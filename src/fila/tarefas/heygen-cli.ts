// A rota de CRÉDITOS: gerar avatar pela CLI `heygen`, autenticada por OAuth.
//
// Por que uma rota separada, e não um parâmetro no POST: quem decide de onde sai
// o custo é a AUTENTICAÇÃO, não o corpo da requisição. A doc da HeyGen é
// explícita — chave de API (`x-api-key`) debita da carteira em dólar; OAuth
// "authenticates as the user's web account and draws on subscription credits".
//
// Medido em 2026-08-02 (`TESTE-CREDITOS-v1`, 8,67s, `avatar_iii`): créditos
// premium 200 → 199, carteira intacta em US$ 0,22. E a busca por título feita
// com a CHAVE DE API achou o vídeo gerado por OAuth — as duas credenciais veem a
// mesma conta, e é por isso que só a GERAÇÃO muda de rota aqui: `porTitulo`,
// `urlDe` e `baixar` continuam sendo os da API, e a fase `baixar` não muda.
import { execFile } from 'node:child_process';

import type { ClienteHeygen, PedidoDeGeracao } from './heygen.js';

/** Roda a CLI e devolve a saída (JSON). Injetável para o teste não tocar disco. */
export type RodarCli = (args: string[], sinal?: AbortSignal) => Promise<string>;

/**
 * A CLI de verdade.
 *
 * `HEYGEN_API_KEY` é APAGADA do ambiente do processo filho, e isso não é
 * paranoia: a própria CLI avisa que "the HEYGEN_API_KEY environment variable
 * always takes priority over any stored credential". Com ela setada, esta rota
 * cobraria da carteira em dólar em silêncio — exatamente o que ela existe para
 * não fazer.
 */
export function rodarCliReal(binario: string): RodarCli {
  return (args, sinal) => new Promise<string>((ok, nao) => {
    const { HEYGEN_API_KEY: _, ...ambiente } = process.env;
    execFile(
      binario, args,
      { env: { ...ambiente, HEYGEN_NONINTERACTIVE: '1' }, signal: sinal, maxBuffer: 8 * 1024 * 1024 },
      (erro, saida, saidaErro) => {
        if (erro) {
          // A saída da CLI entra no erro: "sem sessão", "rate limited" e "avatar
          // inexistente" são causas diferentes, e sem o texto sobra adivinhação.
          nao(new Error(`heygen cli: ${(saidaErro || saida || erro.message).toString().slice(0, 400)}`));
          return;
        }
        ok(saida.toString());
      },
    );
  });
}

/**
 * O mesmo `ClienteHeygen`, com a GERAÇÃO e o SALDO trocados pela CLI.
 *
 * Só esses dois: gerar é o que muda de bolso, e saldo é o que muda de unidade
 * (créditos, não dólares). Todo o resto delega ao cliente de API, que já é
 * testado e já funciona contra vídeos gerados por OAuth.
 */
export function clienteViaCli(base: ClienteHeygen, rodar: RodarCli): ClienteHeygen {
  return {
    ...base,
    async gerar(pedido: PedidoDeGeracao, sinal) {
      const corpo = JSON.stringify({
        type: 'avatar',
        avatar_id: pedido.avatarId,
        voice_id: pedido.voiceId,
        // Explícito SEMPRE: a CLI também usa Avatar IV quando o campo falta, e
        // Avatar IV custa 3 a 4× o Avatar III pelo mesmo minuto.
        engine: { type: pedido.engine },
        script: pedido.texto,
        title: pedido.titulo,
        aspect_ratio: '16:9',
        output_format: 'mp4',
      });
      const saida = await rodar(['video', 'create', '-d', corpo], sinal);
      const dados = JSON.parse(saida || '{}') as { data?: { video_id?: string; id?: string } };
      const id = dados.data?.video_id ?? dados.data?.id;
      if (!id) throw new Error(`heygen cli: resposta sem video_id: ${saida.slice(0, 200)}`);
      return id;
    },
    /**
     * Saldo em CRÉDITOS (premium + add-on), não em dólares.
     *
     * A unidade muda com a rota, mas o piso da tarefa (`PISO_POR_VIDEO`, 1) vale
     * para as duas: 1 crédito por vídeo aqui, ~US$ 1 por vídeo lá.
     *
     * Falha vira `null` — sessão expirada é problema real, mas quem tem que
     * reclamar dela é a geração, com a mensagem da CLI, não o medidor.
     */
    async saldo(sinal) {
      try {
        const saida = await rodar(['auth', 'status'], sinal);
        const d = JSON.parse(saida || '{}') as {
          data?: { subscription?: { credits?: Record<string, { remaining?: number }> } };
        };
        const creditos = d.data?.subscription?.credits;
        if (!creditos) return null;
        const total = Object.values(creditos)
          .reduce((soma, c) => soma + (typeof c.remaining === 'number' ? c.remaining : 0), 0);
        return total;
      } catch {
        return null;
      }
    },
  };
}

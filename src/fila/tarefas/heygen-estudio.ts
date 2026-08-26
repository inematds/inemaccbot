// `heygen.estudio` — a rota `| estudio`: o bot gera no estúdio do HeyGen por
// SCRIPT de navegador (Playwright), não por agente.
//
// Faz o MESMO que a fase `navega-avatar` (clona o `TEMPLATE-AVATAR`, herda
// cenário, avatar, voz e motor, debita dos créditos da assinatura) — a
// diferença é quem pilota. O `navega` continua no `flow.json` de propósito,
// como caminho de volta se o DOM do HeyGen mudar e o script quebrar.
//
// O contrato é o mesmo das outras três rotas: o resultado é o TÍTULO, e a fase
// `baixar` procura por ele sem saber de onde o vídeo veio.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClienteHeygen } from './heygen.js';
import type { ContextoTarefa } from '../types.js';
import type { Tarefa } from '../worker.js';

export interface EntradaEstudio {
  /** O mesmo título que a fase `baixar` procura depois. */
  titulo: string;
  /** A FALA — vai para um ARQUIVO, nunca para a linha de comando: texto
   *  acentuado dentro de aspas de shell é a classe de bug que a receita antiga
   *  de xclip/xdotool existia para evitar. */
  texto: string;
  /** Nome exato do projeto de origem no HeyGen. */
  template?: string;
  espera?: { intervalo: number; timeout: number };
}

export interface OpcoesEstudio {
  /** Perfil de Chromium JÁ LOGADO no HeyGen. */
  perfil: string;
  /** `scripts/heygen-estudio.mjs`. */
  script: string;
  /** Injetável para o teste não abrir navegador. Resolve com a saída. */
  rodar?: (args: string[], sinal: AbortSignal) => Promise<{ codigo: number; saida: string }>;
}

export function rodarNodeReal(node = process.execPath) {
  return (args: string[], sinal: AbortSignal): Promise<{ codigo: number; saida: string }> =>
    new Promise((resolver, rejeitar) => {
      const filho = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let saida = '';
      const juntar = (b: Buffer): void => { saida += b.toString(); };
      filho.stdout.on('data', juntar);
      filho.stderr.on('data', juntar);
      // O navegador é FILHO do serviço: quando o worker larga o job (restart,
      // lease perdido), ele tem que morrer junto. Ao contrário do render, aqui
      // deixar órfão não economiza nada — a retomada continua do rascunho.
      const largar = (): void => { filho.kill('SIGKILL'); };
      sinal.addEventListener('abort', largar, { once: true });
      filho.on('error', (e) => { sinal.removeEventListener('abort', largar); rejeitar(e); });
      filho.on('close', (codigo) => {
        sinal.removeEventListener('abort', largar);
        resolver({ codigo: codigo ?? -1, saida });
      });
    });
}

export function criarHeygenEstudio(cliente: ClienteHeygen, opts: OpcoesEstudio): Tarefa {
  const rodar = opts.rodar ?? rodarNodeReal();
  return async (ctx: ContextoTarefa): Promise<string> => {
    if (ctx.sinal.aborted) {
      throw ctx.sinal.reason instanceof Error
        ? ctx.sinal.reason
        : new Error(`heygen.estudio: abortado (${String(ctx.sinal.reason)})`);
    }
    const { titulo, texto, template, espera } =
      JSON.parse(ctx.job.input || '{}') as Partial<EntradaEstudio>;
    if (!titulo) throw new Error('heygen.estudio: input precisa de { titulo }');
    if (!texto?.trim()) throw new Error(`heygen.estudio: ${titulo} sem texto para falar`);

    // Procure ANTES de criar (§2.5), a mesma trava do `heygen.gerar`: se o
    // título já está no estúdio em qualquer status que não `draft`, a tentativa
    // anterior JÁ ENVIOU e já cobrou. Um `draft` é o oposto — é uma tentativa
    // que renomeou e não gerou, e o script continua dela.
    const jaEsta = (await cliente.porTitulo([titulo], ctx.sinal)).get(titulo);
    if (jaEsta && jaEsta.status !== 'draft') {
      ctx.log(`heygen.estudio: "${titulo}" já está no estúdio (${jaEsta.status})`);
      return titulo;
    }

    if (espera && ctx.agora() - ctx.job.criado_em > espera.timeout) {
      throw new Error(
        `heygen.estudio: "${titulo}" não foi enviado em ${Math.round(espera.timeout / 60)} min`,
      );
    }

    const pasta = mkdtempSync(join(tmpdir(), 'heygen-fala-'));
    const arquivoFala = join(pasta, 'fala.txt');
    writeFileSync(arquivoFala, texto, 'utf8');

    const { codigo, saida } = await rodar([
      opts.script,
      '--titulo', titulo,
      '--perfil', opts.perfil,
      '--fala-arquivo', arquivoFala,
      ...(template ? ['--template', template] : []),
    ], ctx.sinal);

    if (codigo !== 0) {
      // A última linha `ERRO:` do script é a mensagem útil (template ambíguo,
      // sessão deslogada, modal sem "Enviar"). Sem ela sobraria "exit 3".
      // A última linha `ERRO:` do script é a mensagem útil. Quando ela não
      // existe — o Playwright estourou sozinho, sem passar pelo `morrer` — o
      // que resta é o ÚLTIMO PASSO anunciado: "renomeando", "buscando X". Sem
      // isso, `locator.fill: Timeout` não diz QUAL campo, e a caçada começa do
      // zero (foi o C#110 em 2026-08-26: 36 fases com a mesma linha muda).
      // De trás para frente nas duas buscas — e por cópia, porque `reverse()`
      // mexe no array e a segunda busca herdaria a ordem virada da primeira.
      const linhas = saida.split('\n').map((l) => l.trim()).filter(Boolean);
      const deTras = [...linhas].reverse();
      const erro = deTras.find((l) => l.startsWith('ERRO:'));
      const ultimoPasso = deTras.find((l) => /^\d{2}:\d{2}:\d{2}\s/.test(l));
      const motivo = erro
        ?? `saiu com código ${codigo}${ultimoPasso ? ` (último passo: ${ultimoPasso})` : ''}`;
      throw new Error(`heygen.estudio: ${titulo} — ${motivo.replace(/^ERRO:\s*/, '')}`);
    }
    ctx.log(`heygen.estudio: ${titulo} enviado para gerar`);
    // O TÍTULO é o resultado, não um caminho: a fase `baixar` procura por ele.
    return titulo;
  };
}

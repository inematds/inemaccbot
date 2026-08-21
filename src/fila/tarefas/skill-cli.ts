// A rota de SKILL sem agente: o comando é declarado no `config/skills.json` e
// quem executa é o bot.
//
// A rota de fluxo perdeu o agente das fases mecânicas em 2026-08-21
// (`cli.rodar`); a de skill continuou como estava — `kind: agent` com a
// invocação escrita dentro de um prompt. O `analisevideo` era isso: um modelo
// pago para montar UMA linha de bash.
//
// O que aconteceu na prática, no mesmo dia: o agente rodou o script em SEGUNDO
// PLANO — que o prompt proíbe em negrito, com o motivo ao lado — e encerrou o
// turno dizendo "vou aguardar a notificação". O job terminou sem contrato, a
// árvore de processos foi morta e a análise morreu junto. Duas tentativas, dois
// downloads de 22 MB, nenhuma análise.
//
// Ele não desobedeceu por capricho: o trabalho passa do teto de 10 minutos da
// ferramenta dele, e destacar era a única saída que ele tinha. Quem sabe
// destacar E vigiar é o bot — é o que `espera` faz aqui, igual às fases
// `heygen.*` e ao clipe do musicavideo.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { rodarEntradaCli, type EntradaCli } from './cli.js';
import { disparoReal, type Disparo } from './reel.js';
import type { SkillDef } from '../../dominio/registry.js';
import type { ContextoTarefa } from '../types.js';
import type { Tarefa } from '../worker.js';

/** O que o gateway grava no `input` de um job de skill. */
interface EntradaSkill {
  entrada?: string;
  campos?: Record<string, string>;
}

export interface OpcoesSkillCli {
  raizArtefatos: string;
  projetosDir: string;
  disparar?: Disparo['disparar'];
  vigia?: Disparo['vigia'];
}

/**
 * Aspas simples POSIX. Tudo que vem do chat entra por aqui — é a mesma barreira
 * do `entrada-fase.ts`, e pelo mesmo motivo: o `{{input}}` de uma skill é texto
 * que o usuário digitou.
 */
function aspar(s: string): string {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Marcador → valor. `{{repo}}` sai sem aspas quando é caminho simples (fica
 * legível no log e no `/status`); o resto é sempre aspado. Marcador sem valor
 * vira string vazia ASPADA, nunca o marcador cru — que o shell interpretaria.
 */
export function resolverComandoSkill(
  molde: string, campos: Record<string, string>,
): string {
  return molde.replace(/\{\{(\w+)\}\}/g, (_, chave: string) => {
    const valor = campos[chave] ?? '';
    if (chave === 'repo' && /^[\w/.@+-]+$/.test(valor)) return valor;
    return aspar(valor);
  });
}

export function criarSkillCli(def: SkillDef, opts: OpcoesSkillCli): Tarefa {
  const disparar = opts.disparar ?? disparoReal();
  return async (ctx: ContextoTarefa): Promise<string> => {
    let e: EntradaSkill;
    try {
      e = JSON.parse(ctx.job.input || '{}') as EntradaSkill;
    } catch {
      throw new Error(`${def.command}: input do job não é JSON`);
    }
    // Determinístico por JOB, e não por conteúdo: uma retentativa nasce com
    // outro id e deve escrever outro recibo — ao contrário do artefato do
    // domínio, que o próprio domínio nomeia (e desambigua).
    const saida = join(opts.raizArtefatos, def.command, `${ctx.job.id}.txt`);
    const comando = resolverComandoSkill(def.comando ?? '', {
      repo: def.repo ? join(opts.projetosDir, def.repo) : '',
      input: e.entrada ?? '',
      saida,
      ...(e.campos ?? {}),
    });

    const entrada: EntradaCli = {
      comando,
      cwd: def.repo ? join(opts.projetosDir, def.repo) : opts.projetosDir,
      saida,
      timeout_segundos: def.timeout_segundos,
      // `aguarda_artefato` na skill é o mesmo pedido que `espera` na fase:
      // trabalho longo, dispare e vigie. O intervalo curto é suficiente porque
      // o custo do poll é um `statSync`.
      ...(def.aguarda_artefato
        ? { espera: { intervalo: 15, timeout: def.timeout_segundos } }
        : {}),
    };
    const recibo = await rodarEntradaCli(entrada, ctx, { disparar, vigia: opts.vigia });
    return artefatoOuRecibo(recibo, def);
  };
}

/**
 * O ARTEFATO que o domínio imprimiu, quando ele imprimiu — senão o recibo.
 *
 * Skill é de uma etapa só: o que a pessoa quer no chat é a ANÁLISE, não um
 * `.txt` dizendo onde ela está. E o contrato já existe e é declarado:
 * `artefato_exts` diz o que a skill produz, e o CLI do domínio imprime o
 * caminho na última linha (o `analisevideo.sh` faz isso desde sempre — era o
 * que o prompt mandava o agente copiar).
 *
 * Sem linha reconhecível, o recibo vale: ele tem a saída inteira, e é melhor
 * que falhar um trabalho que aconteceu.
 */
function artefatoOuRecibo(recibo: string, def: SkillDef): string {
  let texto: string;
  try {
    texto = readFileSync(recibo, 'utf8');
  } catch {
    return recibo;
  }
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  const exts = def.artefato_exts.map((e) => e.toLowerCase());
  for (const linha of [...linhas].reverse()) {
    // Uma linha que é SÓ um caminho: nada de garimpar caminho dentro de prosa,
    // que é adivinhação e erra quando o domínio muda uma mensagem.
    if (/\s/.test(linha)) continue;
    const ext = linha.split('.').pop()?.toLowerCase() ?? '';
    if (exts.includes(ext) && existsSync(linha)) return linha;
  }
  return recibo;
}

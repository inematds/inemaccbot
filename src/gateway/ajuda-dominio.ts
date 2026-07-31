// Ajuda de UM domínio — skill ou fluxo.
//
// REGRA DO SISTEMA: todo domínio que entra no catálogo é documentado. Não por
// disciplina (que falha), mas por construção:
//
//   1. quem entende do assunto escreve a ajuda no repo/arquivo do domínio;
//   2. se não escreveu, ela é DERIVADA do registro — e o derivado nunca mente,
//      porque sai da mesma fonte que o bot usa para executar;
//   3. um teste varre os dois catálogos e falha se algum domínio não responder
//      ajuda utilizável.
//
// O item 2 é o que torna o item 1 opcional sem virar buraco: o mínimo existe
// sempre. E o item 3 é o que impede alguém de acrescentar uma skill nova e
// deixá-la muda.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SkillDef } from '../dominio/registry.js';

/** Leitura tolerante: ajuda ausente é o caso NORMAL, não erro. */
export function lerAjuda(caminho: string): string | undefined {
  try {
    const t = readFileSync(caminho, 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ajuda de uma SKILL. O arquivo opcional fica ao lado do prompt dela
 * (`prompts/transcrever.help.md`) — mesmo lugar, mesma pessoa editando.
 */
export function ajudaDaSkill(def: SkillDef, raizRepo: string, ler = lerAjuda): string {
  const escrita = ler(join(raizRepo, def.prompt.replace(/\.md$/, '.help.md')));
  if (escrita) return escrita;

  const campos = Object.entries(def.campos);
  const linhas = [
    `${def.command} — ${def.descricao}`,
    '',
    `Uso: ${def.exemplo}`,
    '',
    `Fila: ${def.fila} · tentativas: ${def.max_tentativas} · `
    + `prazo: ${Math.round(def.timeout_segundos / 60)} min`,
    `Entrega: ${def.artefato_exts.map((e) => `.${e}`).join(' ou ')}`
    + `${def.aceita_destino ? ' · aceita destino (| livesN)' : ''}`,
  ];
  if (campos.length) {
    linhas.push('', 'Campos:');
    for (const [nome, c] of campos) {
      const uso = c.tipo === 'bandeira' ? `| ${nome}` : `| ${nome} <valor>`;
      linhas.push(`  ${uso.padEnd(18)}${c.descricao ?? (c.tipo === 'bandeira' ? 'liga/desliga' : 'texto sem espaço')}`);
    }
  }
  linhas.push('', 'Perfil: | modelo=opus · | esforco=high');
  return linhas.join('\n');
}

// A rota de skill SEM agente.
//
// O caso que motivou: o `analisevideo` pagava um modelo para montar uma linha de
// bash, e em 2026-08-21 o modelo mandou o script para segundo plano (o prompt
// proíbe, em negrito), encerrou o turno e o job morreu sem contrato — levando a
// análise junto. Duas tentativas, dois downloads de 22 MB, nenhuma análise.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarSkillCli, resolverComandoSkill } from './skill-cli.js';
import type { SkillDef } from '../../dominio/registry.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-skillcli-'));
  // O cwd do comando é o repo do domínio: ele tem que existir, e o teste do cwd
  // ausente vive por si mais abaixo.
  mkdirSync(join(dir, 'analisevideo'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function def(over: Partial<SkillDef> = {}): SkillDef {
  return {
    command: 'analisevideo', fila: 'io', kind: 'function', prompt: '',
    comando: 'bash {{repo}}/analisevideo.sh analisa {{input}}',
    repo: 'analisevideo', artefato_exts: ['md', 'json'],
    max_tentativas: 2, timeout_segundos: 60, aceita_destino: false,
    campos: {}, aguarda_artefato: false,
    descricao: 'x', exemplo: 'y',
    ...over,
  } as SkillDef;
}

function ctx(entrada: unknown): ContextoTarefa {
  return {
    job: { id: 42, input: JSON.stringify(entrada), criado_em: 1_000 },
    agora: () => 1_000,
    log: () => {},
    sinal: new AbortController().signal,
  } as unknown as ContextoTarefa;
}

describe('resolverComandoSkill', () => {
  it('aspa a entrada do usuário — texto do chat não vira comando', () => {
    expect(resolverComandoSkill('x {{input}}', { input: "o'brien; rm -rf /tmp/nao" }))
      .toBe("x 'o'\\''brien; rm -rf /tmp/nao'");
  });

  it('marcador sem valor vira string vazia ASPADA, nunca o marcador cru', () => {
    expect(resolverComandoSkill('x {{inexistente}}', {})).toBe("x ''");
  });

  it('{{repo}} entra sem aspas quando é caminho simples — para o log ficar legível', () => {
    expect(resolverComandoSkill('bash {{repo}}/x.sh', { repo: '/home/u/projetos/analisevideo' }))
      .toBe('bash /home/u/projetos/analisevideo/x.sh');
  });
});

describe('criarSkillCli', () => {
  it('roda o comando do domínio, com a URL aspada', async () => {
    const alvo = join(dir, 'analisevideo', 'analisevideo.sh');
    writeFileSync(join(dir, 'eco.sh'), '#!/bin/bash\necho "$@"\n');
    const t = criarSkillCli(
      def({ comando: `bash {{repo}}/../eco.sh analisa {{input}}` }),
      { raizArtefatos: join(dir, 'art'), projetosDir: dir },
    );
    const r = await t(ctx({ entrada: 'https://exemplo/v?a=1&b=2' }));
    expect(readFileSync(r, 'utf8')).toContain('analisa https://exemplo/v?a=1&b=2');
    expect(alvo).toBeTruthy();
  });

  // O que a pessoa quer no chat é a ANÁLISE, não um `.txt` dizendo onde ela
  // está. O contrato já existe e é declarado: `artefato_exts` diz o que a skill
  // produz, e o CLI imprime o caminho na última linha.
  it('devolve o ARTEFATO que o domínio imprimiu, não o recibo', async () => {
    const analise = join(dir, 'analise.md');
    writeFileSync(analise, '# análise');
    writeFileSync(join(dir, 'falso.sh'),
      `#!/bin/bash\necho "[analisevideo] pronto: slug"\necho "${analise}"\n`);
    const t = criarSkillCli(
      def({ comando: 'bash {{repo}}/../falso.sh {{input}}' }),
      { raizArtefatos: join(dir, 'art'), projetosDir: dir },
    );
    expect(await t(ctx({ entrada: 'url' }))).toBe(analise);
  });

  it('sem linha de caminho reconhecível, o recibo vale — trabalho feito não vira falha', async () => {
    writeFileSync(join(dir, 'mudo.sh'), '#!/bin/bash\necho "terminei, mas não digo onde"\n');
    const t = criarSkillCli(
      def({ comando: 'bash {{repo}}/../mudo.sh {{input}}' }),
      { raizArtefatos: join(dir, 'art'), projetosDir: dir },
    );
    const r = await t(ctx({ entrada: 'url' }));
    expect(r).toContain(join('art', 'analisevideo', '42.txt'));
    expect(readFileSync(r, 'utf8')).toContain('terminei');
  });

  it('caminho com extensão certa mas arquivo INEXISTENTE não engana', async () => {
    writeFileSync(join(dir, 'mentiroso.sh'), '#!/bin/bash\necho "/nao/existe/analise.md"\n');
    const t = criarSkillCli(
      def({ comando: 'bash {{repo}}/../mentiroso.sh {{input}}' }),
      { raizArtefatos: join(dir, 'art'), projetosDir: dir },
    );
    expect(await t(ctx({ entrada: 'url' }))).toContain('42.txt');
  });

  // Repo não clonado nesta máquina: `spawn` devolveria só `ENOENT`, sem dizer
  // qual caminho faltou nem que o problema era o cwd.
  it('repo ausente falha dizendo QUAL caminho não existe', async () => {
    const t = criarSkillCli(
      def({ repo: 'nao-clonado' }),
      { raizArtefatos: join(dir, 'art'), projetosDir: dir },
    );
    await expect(t(ctx({ entrada: 'url' }))).rejects.toThrow(/nao-clonado/);
  });

  it('exit != 0 é falha, com a cauda da saída do domínio', async () => {
    writeFileSync(join(dir, 'quebra.sh'), '#!/bin/bash\necho "yt-dlp: vídeo privado" >&2\nexit 1\n');
    const t = criarSkillCli(
      def({ comando: 'bash {{repo}}/../quebra.sh {{input}}' }),
      { raizArtefatos: join(dir, 'art'), projetosDir: dir },
    );
    await expect(t(ctx({ entrada: 'url' }))).rejects.toThrow(/vídeo privado/);
  });
});

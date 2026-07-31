import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acharSkill, carregarSkills, validarSkills } from './registry.js';

let raiz: string;

/** Registry mínimo válido; cada teste estraga UM campo. */
function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'transcrever',
    fila: 'texto',
    kind: 'agent',
    prompt: 'prompts/t.md',
    artefato_exts: ['txt'],
    max_tentativas: 2,
    timeout_segundos: 60,
    aceita_destino: false,
    descricao: 'transcreve',
    exemplo: 'transcrever: http://x',
    ...over,
  };
}

function escreverPrompt(rel: string, conteudo = 'oi {{input}}'): void {
  const alvo = join(raiz, rel);
  mkdirSync(dirname(alvo), { recursive: true });
  writeFileSync(alvo, conteudo);
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'inemaccbot-registry-'));
  escreverPrompt('prompts/t.md');
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

describe('validarSkills', () => {
  it('aceita uma entrada completa e normaliza as extensões', () => {
    const [d] = validarSkills([base({ artefato_exts: ['.TXT', 'srt'] })], raiz);
    expect(d.command).toBe('transcrever');
    expect(d.artefato_exts).toEqual(['txt', 'srt']);
    expect(d.aceita_destino).toBe(false);
  });

  it('recusa array vazio — um catálogo sem skill nenhuma é erro de config, não estado válido', () => {
    expect(() => validarSkills([], raiz)).toThrow(/vazio/);
  });

  it('recusa fila inexistente', () => {
    expect(() => validarSkills([base({ fila: 'gpu' })], raiz)).toThrow(/fila/);
  });

  it('recusa kind fora de agent|function', () => {
    expect(() => validarSkills([base({ kind: 'plan' })], raiz)).toThrow(/kind/);
  });

  it('recusa comando com espaço, ":" ou "|" — são os separadores da gramática', () => {
    for (const c of ['dois pontos', 'a:b', 'a|b', 'MAIUSCULO']) {
      expect(() => validarSkills([base({ command: c })], raiz)).toThrow(/command/);
    }
  });

  it('recusa comando duplicado', () => {
    expect(() => validarSkills([base(), base()], raiz)).toThrow(/duplicado/);
  });

  it('recusa prompt ausente no disco — o erro tem que aparecer no boot, não no primeiro job', () => {
    expect(() => validarSkills([base({ prompt: 'prompts/nao-existe.md' })], raiz)).toThrow(/ausente/);
  });

  it('recusa prompt vazio', () => {
    escreverPrompt('prompts/vazio.md', '');
    expect(() => validarSkills([base({ prompt: 'prompts/vazio.md' })], raiz)).toThrow(/ausente ou vazio/);
  });

  it('recusa prompt com ".." ou caminho absoluto (fuga da raiz do repo)', () => {
    expect(() => validarSkills([base({ prompt: '../fora.md' })], raiz)).toThrow(/relativo/);
    expect(() => validarSkills([base({ prompt: '/etc/passwd' })], raiz)).toThrow(/relativo/);
  });

  it('recusa artefato_exts vazio ou com extensão inválida', () => {
    expect(() => validarSkills([base({ artefato_exts: [] })], raiz)).toThrow(/artefato_exts/);
    expect(() => validarSkills([base({ artefato_exts: ['mp 4'] })], raiz)).toThrow(/artefato_exts/);
  });

  it('recusa max_tentativas/timeout não-inteiro-positivo', () => {
    expect(() => validarSkills([base({ max_tentativas: 0 })], raiz)).toThrow(/max_tentativas/);
    expect(() => validarSkills([base({ timeout_segundos: -1 })], raiz)).toThrow(/timeout_segundos/);
    expect(() => validarSkills([base({ timeout_segundos: '60' })], raiz)).toThrow(/timeout_segundos/);
  });

  it('aceita perfil parcial e ignora perfil vazio', () => {
    expect(validarSkills([base({ perfil: { modelo: 'opus' } })], raiz)[0].perfil).toEqual({ modelo: 'opus' });
    expect(validarSkills([base({ perfil: {} })], raiz)[0].perfil).toBeUndefined();
  });
});

describe('carregarSkills', () => {
  it('lê e valida o arquivo', () => {
    const arq = join(raiz, 'skills.json');
    writeFileSync(arq, JSON.stringify([base()]));
    expect(carregarSkills(arq, raiz)).toHaveLength(1);
  });

  it('erro claro em JSON inválido e em arquivo ausente', () => {
    const arq = join(raiz, 'skills.json');
    writeFileSync(arq, '{quebrado');
    expect(() => carregarSkills(arq, raiz)).toThrow(/JSON inválido/);
    expect(() => carregarSkills(join(raiz, 'nada.json'), raiz)).toThrow(/não consegui ler/);
  });
});

describe('o registry REAL do repo', () => {
  // Sem isto, `config/skills.json` poderia ficar inválido sem nada acusar até o
  // boot em produção — o teste do validador passaria verde sobre fixtures.
  const repo = new URL('../..', import.meta.url).pathname;
  const defs = carregarSkills(join(repo, 'config', 'skills.json'), repo);

  it('é válido e tem as skills das etapas 2 e 3, mais as da Agnes', () => {
    expect(defs.map((d) => d.command).sort()).toEqual(
      ['curso', 'demo', 'dublar', 'explicativo', 'historia', 'imagem',
        'reel', 'reelinematds', 'transcrever'],
    );
    expect(acharSkill(defs, 'transcrever')?.fila).toBe('texto');
    expect(acharSkill(defs, 'explicativo')?.fila).toBe('render');
    // `historia` fica na fila `cpu`, NÃO em `render`: ela roda de 30 min a
    // horas (rate limit de 5 req/min no vídeo da Agnes) e, em `render`, um
    // filme seguraria a fila dos reels do promoavatar a tarde inteira.
    expect(acharSkill(defs, 'historia')?.fila).toBe('cpu');
    // `imagem` é uma chamada de API de segundos — vai para `io`, que tem 10
    // simultâneos, e não fica atrás de um filme de duas horas.
    expect(acharSkill(defs, 'imagem')?.fila).toBe('io');
    expect(acharSkill(defs, 'inexistente')).toBeUndefined();
  });

  // Toda skill de render precisa esperar artefato: sem isso o agente seguraria
  // a sessão por 2h e um restart mataria o trabalho (plano da etapa 3, §1).
  it('toda skill da fila render espera artefato', () => {
    for (const d of defs.filter((x) => x.fila === 'render')) {
      expect(d.aguarda_artefato, d.command).toBe(true);
      expect(d.max_tentativas, d.command).toBeGreaterThanOrEqual(2);
    }
  });

  // Um teto de setup curto demais mata a skill antes de ela disparar qualquer
  // coisa. Em reel o agente roda o pipeline criativo INLINE — só o render final
  // é destacado —, então ele precisa de folga bem maior que o default.
  it('as skills que trabalham inline declaram teto de setup próprio', () => {
    for (const nome of ['reel', 'reelinematds']) {
      const d = acharSkill(defs, nome)!;
      expect(d.timeout_setup_segundos, nome).toBeGreaterThan(30 * 60);
      expect(d.timeout_setup_segundos!, nome).toBeLessThanOrEqual(d.timeout_segundos);
    }
  });

  // O contrato prometido no plano: declarar um campo e esquecê-lo no prompt é
  // erro de teste, não comportamento silencioso. Vale nos dois sentidos.
  for (const d of defs) {
    it(`${d.command}: campos declarados e variáveis do prompt batem`, () => {
      const template = readFileSync(join(repo, d.prompt), 'utf8');
      const usadas = new Set(
        [...template.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1]),
      );
      const declaradas = new Set(['input', 'saida', ...Object.keys(d.campos)]);

      for (const [nome, c] of Object.entries(d.campos)) {
        if (c.usa === 'entrega') {
          // O agente não move arquivo: campo de entrega no prompt é instrução
          // dada a quem não a executa.
          expect(usadas.has(nome), `campo de entrega "${nome}" não deveria estar em ${d.prompt}`).toBe(false);
          continue;
        }
        expect(usadas.has(nome), `campo "${nome}" declarado mas não usado em ${d.prompt}`).toBe(true);
      }
      for (const nome of usadas) {
        expect(declaradas.has(nome), `${d.prompt} usa {{${nome}}}, que a skill não declara`).toBe(true);
      }
      expect(usadas.has('saida'), `${d.prompt} não diz onde gravar`).toBe(true);
      expect(usadas.has('input'), `${d.prompt} não usa a entrada do usuário`).toBe(true);
    });

    if (d.aguarda_artefato) {
      it(`${d.command}: o prompt manda declarar RENDER: e criar o marcador .err`, () => {
        const template = readFileSync(join(repo, d.prompt), 'utf8');
        expect(template).toContain('RENDER: {{saida}}');
        // Sem o marcador, um passo que morre cedo deixa o serviço esperando o
        // timeout inteiro — o defeito que o mkivideos documenta.
        expect(template).toContain('{{saida}}.err');
        // O PID tem que ser gravado DE DENTRO do bash destacado (`echo $$`).
        // Num run real o `echo $!` de fora pegou o shell errado, e o
        // /cancelar passaria a depender de sorte para matar o render certo.
        expect(template).toContain('echo $$ > "{{saida}}.pid"');
        expect(template).not.toContain('echo $! >');
      });
    }
  }
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { validarSkills, type SkillDef } from '../dominio/registry.js';
import { CONCORRENCIAS, FILAS } from '../fila/filas.js';
import { FilaSqlite } from '../fila/store.js';
import { executar, parseComando, type DepsComando } from './comandos.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-comandos-'));
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  t = 1_000;
  fila = new FilaSqlite(db, () => t);
  prepararDefs();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(): DepsComando {
  return { fila, chatId: 42, agora: () => t };
}

/** Catálogo de teste: dois comandos, um deles aceitando destino. O prompt tem
 * que existir no disco porque o validador confere isso no boot. */
let defsTeste: SkillDef[];
function prepararDefs(): void {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'p.md'), '{{input}} {{saida}}');
  const comum = {
    fila: 'texto', kind: 'agent', prompt: 'prompts/p.md', artefato_exts: ['txt'],
    max_tentativas: 2, timeout_segundos: 60, descricao: 'd', exemplo: 'ex',
  };
  defsTeste = validarSkills([
    { ...comum, command: 'transcrever', aceita_destino: false },
    { ...comum, command: 'dublar', artefato_exts: ['mp4'], aceita_destino: true },
  ], dir);
}

function depsSkills(): DepsComando {
  return { ...deps(), defs: defsTeste };
}

describe('parseComando', () => {
  it('reconhece /ping', () => {
    expect(parseComando('/ping')).toEqual({ tipo: 'ping' });
  });

  it('reconhece /fila', () => {
    expect(parseComando('/fila')).toEqual({ tipo: 'fila' });
  });

  it('reconhece /status <id>', () => {
    expect(parseComando('/status 5')).toEqual({ tipo: 'status', id: 5 });
  });

  it('reconhece /cancelar <id>', () => {
    expect(parseComando('/cancelar 5')).toEqual({ tipo: 'cancelar', id: 5 });
  });

  it('reconhece /furar <id>', () => {
    expect(parseComando('/furar 5')).toEqual({ tipo: 'furar', id: 5 });
  });

  it('reconhece http <url>', () => {
    expect(parseComando('http https://exemplo.com')).toEqual({
      tipo: 'http',
      url: 'https://exemplo.com',
    });
  });

  it('reconhece thumb <caminho>', () => {
    expect(parseComando('thumb /media/video.mp4')).toEqual({
      tipo: 'thumb',
      entrada: '/media/video.mp4',
    });
  });

  it('reconhece /ajuda e /help como alias', () => {
    expect(parseComando('/ajuda')).toEqual({ tipo: 'ajuda' });
    expect(parseComando('/help')).toEqual({ tipo: 'ajuda' });
  });

  it('/ajuda tudo (e sinônimos) pede a ajuda COMPLETA', () => {
    expect(parseComando('/ajuda tudo')).toEqual({ tipo: 'ajuda', tudo: true });
    expect(parseComando('/ajuda comandos')).toEqual({ tipo: 'ajuda', tudo: true });
    expect(parseComando('/help all')).toEqual({ tipo: 'ajuda', tudo: true });
    // Nome de domínio NÃO é palavra reservada: continua sendo ajuda de um só.
    expect(parseComando('/ajuda reel')).toEqual({ tipo: 'ajuda' });
  });

  // Defeito real, achado no primeiro uso pelo chat: `/status` sozinho é a
  // pergunta mais comum que existe ("o que está rolando?"), e caía em
  // "comando não reconhecido".
  it('/status sem id lista os jobs; /jobs é alias', () => {
    expect(parseComando('/status')).toEqual({ tipo: 'lista' });
    expect(parseComando('/jobs')).toEqual({ tipo: 'lista' });
  });

  it('argumentos malformados caem em desconhecido', () => {
    expect(parseComando('/status abc')).toEqual({ tipo: 'desconhecido', texto: '/status abc' });
    expect(parseComando('http')).toEqual({ tipo: 'desconhecido', texto: 'http' });
    expect(parseComando('thumb')).toEqual({ tipo: 'desconhecido', texto: 'thumb' });
  });

  it('texto livre cai em desconhecido', () => {
    expect(parseComando('oi tudo bem?')).toEqual({ tipo: 'desconhecido', texto: 'oi tudo bem?' });
  });
});

describe('executar', () => {
  it('/ping responde algo curto de liveness', () => {
    const r = executar(parseComando('/ping'), deps());
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThan(60);
  });

  // A ajuda era uma lista corrida de 18 linhas, e `/status` aparecia DUAS vezes
  // com descrições que se contradiziam (uma dizendo que lista jobs — o que hoje
  // é o `/jobs`). Agrupar é o que faz uma lista desse tamanho ser lida.
  // A ajuda COMPLETA passou de 30 linhas com o catálogo de skills junto — uma
  // tela inteira no celular para quem só queria liberar um portão. Ela continua
  // existindo inteira, mas atrás de `/ajuda tudo`.
  describe('/ajuda curta (o padrão)', () => {
    const curta = () => executar(parseComando('/ajuda'), depsSkills());

    it('cabe em meia tela: no máximo 16 linhas', () => {
      expect(curta().split('\n').length).toBeLessThanOrEqual(16);
    });

    it('não despeja o catálogo de skills nem a manutenção', () => {
      const r = curta();
      expect(r).not.toContain('/furar');
      expect(r).not.toContain('/limpar');
      // `depsSkills` tem skills registradas: nenhuma pode vazar para o resumo.
      expect(r).not.toMatch(/^\s+transcrever —/m);
    });

    it('ensina os dois caminhos para o detalhe', () => {
      const r = curta();
      expect(r).toContain('/ajuda tudo');
      expect(r).toContain('/ajuda <nome>');
    });

    it('cabe na largura do chat', () => {
      for (const l of curta().split('\n')) expect(l.length).toBeLessThanOrEqual(42);
    });
  });

  describe('/ajuda agrupada', () => {
    const ajuda = () => executar(parseComando('/ajuda tudo'), deps());

    it('não descreve o mesmo comando duas vezes', () => {
      const usos = ajuda().split('\n')
        .filter((l) => l.trim().startsWith('/'))
        .map((l) => l.split(' — ')[0]!.trim());
      expect(new Set(usos).size).toBe(usos.length);
    });

    // O celular quebra por volta de 40 colunas: linha mais larga que isso volta
    // pela metade e a lista vira um bloco. Cada item tem que caber em UMA linha.
    it('cabe na largura do chat, sem quebrar em duas', () => {
      for (const l of ajuda().split('\n')) expect(l.length).toBeLessThanOrEqual(42);
    });

    it('a descrição da skill também é cortada na largura', () => {
      const r = executar(parseComando('/ajuda tudo'), depsSkills());
      for (const l of r.split('\n')) expect(l.length).toBeLessThanOrEqual(42);
    });

    it('separa em seções em vez de despejar tudo junto', () => {
      const r = ajuda();
      expect(r).toMatch(/^Ver:/m);
      expect(r).toMatch(/^Agir:/m);
      expect(r).toMatch(/^Manutenção:/m);
    });

    it('descreve /status como o painel dos fluxos, e /jobs como a fila de jobs', () => {
      const r = ajuda();
      const linhaStatus = r.split('\n').find((l) => l.trim().startsWith('/status ')) ?? '';
      expect(linhaStatus).toMatch(/fluxo/i);
      expect(r.split('\n').find((l) => l.trim().startsWith('/jobs'))).toMatch(/job/i);
    });
  });

  it('/ajuda tudo lista os comandos', () => {
    const r = executar(parseComando('/ajuda tudo'), deps());
    expect(r).toMatch(/ping/);
    expect(r).toMatch(/fila/);
    expect(r).toMatch(/status/);
    expect(r).toMatch(/cancelar/);
    expect(r).toMatch(/furar/);
    expect(r).toMatch(/http/);
    expect(r).toMatch(/thumb/);
  });

  // Guarda do risco 5 do handoff: o `/fila` tinha a PRÓPRIA lista de filas,
  // separada das concorrências do boot. Acrescentar uma fila deixava-a invisível
  // nas métricas. Agora as duas leem `fila/filas.ts`, e este teste falha se
  // alguém reintroduzir uma lista local aqui.
  it('/fila cobre exatamente as filas declaradas em fila/filas.ts', () => {
    // Fila ociosa é COLAPSADA, não sumida: ou tem linha própria (tem trabalho)
    // ou aparece em "ociosas:". Sumir de vez faria o painel esconder que ela
    // existe, e "não aparece" viraria "não sobe".
    const r = executar(parseComando('/fila'), deps());
    for (const f of FILAS) expect(r).toContain(f);
    expect(FILAS).toEqual(Object.keys(CONCORRENCIAS));
  });

  describe('porta de skills (§1.1)', () => {
    it('enfileira na fila e com as tentativas que o REGISTRY manda', () => {
      const r = executar(parseComando('transcrever: http://x', defsTeste), depsSkills());
      const job = fila.obter(1)!;
      expect(job.fila).toBe('texto');
      expect(job.kind).toBe('agent');
      expect(job.tarefa).toBe('transcrever');
      expect(job.max_tentativas).toBe(2);
      expect(JSON.parse(job.input)).toEqual({ entrada: 'http://x' });
      expect(r).toContain('job j1');
    });

    it('grava destino e override de perfil no input do job', () => {
      executar(parseComando('dublar: http://x | modelo=opus', defsTeste), depsSkills());
      expect(JSON.parse(fila.obter(1)!.input)).toEqual({ entrada: 'http://x', perfil: { modelo: 'opus' } });
    });

    // §1.5: sem isto as colunas ficavam nulas e o log mostrava `modelo=-` —
    // justamente a pergunta que o perfil em config existe para responder
    // ("com que modelo esse job rodou?"). Visto em produção no primeiro job real.
    it('grava o perfil EFETIVO no job e mostra no /status', () => {
      executar(parseComando('transcrever: http://x | modelo=opus', defsTeste), depsSkills());
      const job = fila.obter(1)!;
      expect({ motor: job.motor, modelo: job.modelo, esforco: job.esforco })
        .toEqual({ motor: 'claude', modelo: 'opus', esforco: 'low' });
      expect(executar(parseComando('/status 1'), depsSkills())).toContain('claude/opus/low');
    });

    it('perfil inválido é recusado no enfileiramento, sem queimar tentativa', () => {
      const r = executar(parseComando('transcrever: http://x | modelo=inventado', defsTeste), depsSkills());
      expect(r).toMatch(/modelo desconhecido/);
      expect(fila.listar()).toHaveLength(0);
    });

    it('/skills lista o catálogo', () => {
      expect(executar(parseComando('/skills'), depsSkills())).toContain('transcrever');
    });

    it('/ajuda inclui as skills do registry, não uma lista escrita à mão', () => {
      expect(executar(parseComando('/ajuda'), depsSkills())).toContain('transcrever');
    });

    // Sem catálogo, a segunda porta não existe: é o comportamento da etapa 1.
    it('sem registry, texto com ":" continua caindo em desconhecido', () => {
      expect(parseComando('transcrever: http://x').tipo).toBe('desconhecido');
    });

    it('erro de gramática responde a mensagem NOSSA (e não some)', () => {
      const r = executar(parseComando('transcrever: http://x | vertical', defsTeste), depsSkills());
      expect(r).toContain('vertical');
      expect(fila.listar()).toHaveLength(0);
    });

    it('texto livre não enfileira nada', () => {
      const c = parseComando('será que terminou?', defsTeste);
      expect(c.tipo).toBe('livre');
      executar(c, depsSkills());
      expect(fila.listar()).toHaveLength(0);
    });
  });

  describe('métricas do /fila', () => {
    /** Fecha `n` jobs de uma tarefa, cada um com a duração dada. */
    function historico(tarefa: string, duracoes: number[]): void {
      for (const d of duracoes) {
        const j = fila.enfileirar({ fila: 'render', kind: 'agent', tarefa, input: '{}' });
        fila.pegar('render', 600, 'w1');
        t += d;
        fila.concluir(j.id, '/tmp/v.mp4', 'w1');
      }
    }

    it('mostra a duração média por tarefa — é o que diz se vale mudar o perfil', () => {
      historico('explicativo', [600, 900, 1_200]);
      const r = executar(parseComando('/fila'), depsSkills());
      expect(r).toContain('Duração média');
      expect(r).toMatch(/explicativo: 15m \(3x\)/);
    });

    it('conta retentativas — job que rodou duas vezes custou o dobro em GPU', () => {
      const j = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'x', input: '{}', max_tentativas: 2 });
      fila.pegar('io', 60, 'w1');
      fila.falhar(j.id, 'erro', 'w1', 1);
      t += 60;
      fila.pegar('io', 60, 'w1');
      expect(executar(parseComando('/fila'), depsSkills())).toMatch(/io:[\s\S]*1 retentado/);
    });

    // O alarme que importa com render de 2h: "rodando" sozinho não distingue
    // trabalho legítimo de job preso.
    it('acusa job preso comparando com o histórico da MESMA tarefa', () => {
      historico('explicativo', [600, 600, 600]);
      const preso = fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'explicativo', input: '{}' });
      fila.pegar('render', 6_000, 'w1');
      t += 6_000; // muito além do triplo da média
      const r = executar(parseComando('/fila'), depsSkills());
      expect(r).toContain('possivelmente preso');
      expect(r).toContain(String(preso.id));
    });

    it('não acusa job dentro do normal da tarefa', () => {
      historico('explicativo', [600, 600, 600]);
      fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'explicativo', input: '{}' });
      fila.pegar('render', 6_000, 'w1');
      t += 300;
      expect(executar(parseComando('/fila'), depsSkills())).not.toContain('possivelmente preso');
    });

    // Sem histórico, inventar um limite geraria alarme falso — e alarme falso
    // ensina o operador a ignorar o painel.
    it('sem histórico suficiente, não acusa nada', () => {
      fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'novidade', input: '{}' });
      fila.pegar('render', 6_000, 'w1');
      t += 100_000;
      expect(executar(parseComando('/fila'), depsSkills())).not.toContain('possivelmente preso');
    });
  });

  // O painel estava escrito para máquina: `mais_antigo=3668s` (que é 1h01),
  // três filas zeradas ocupando o mesmo espaço da única que importava, e a
  // manchete real — 30 pendentes há uma hora — perdida no meio dos `key=value`.
  describe('/fila legível por gente', () => {
    /** Fecha jobs de uma tarefa na fila `render`, para haver média. */
    function historico(tarefa: string, duracoes: number[]): void {
      for (const d of duracoes) {
        const j = fila.enfileirar({ fila: 'render', kind: 'agent', tarefa, input: '{}' });
        fila.pegar('render', 600, 'w1');
        t += d;
        fila.concluir(j.id, '/tmp/v.mp4', 'w1');
      }
    }

    // Mesma régua do /ajuda: linha de painel que passa de ~40 colunas volta pela
    // metade no celular, e aí o alinhamento que faz o painel ser varrido com o
    // olho some. Caminho de arquivo e URL ficam de fora — esses não dá para
    // encurtar sem mentir.
    it('cada linha cabe na largura do chat', () => {
      historico('reel', [600, 600, 600]);
      for (let i = 0; i < 30; i += 1) {
        fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'reel', input: '{}' });
      }
      fila.pegar('render', 3_600, 'w1');
      t += 3_668;
      const linhas = executar(parseComando('/fila'), depsSkills()).split('\n')
        .filter((l) => !l.includes('http') && !l.includes('/'));
      for (const l of linhas) expect(l.length).toBeLessThanOrEqual(42);
    });

    it('idade em hora/minuto, não em segundos crus', () => {
      fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'reel', input: '{}' });
      t += 3_668;
      const r = executar(parseComando('/fila'), depsSkills());
      expect(r).toMatch(/1h1m/);
      expect(r).not.toMatch(/3668s/);
    });

    it('fila sem nada a dizer é colapsada numa linha só', () => {
      fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'reel', input: '{}' });
      const r = executar(parseComando('/fila'), depsSkills());
      expect(r).toMatch(/ociosas:/);
      // A que tem trabalho continua com linha própria e detalhe.
      expect(r).toMatch(/^render/m);
    });

    it('taxa de erro vem com o denominador — 50% de 2 não é 50% de 200', () => {
      const a = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'x', input: '{}' });
      const b = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'x', input: '{}' });
      fila.pegar('io', 60, 'w1'); fila.concluir(a.id, 'ok', 'w1');
      fila.pegar('io', 60, 'w1'); fila.falhar(b.id, 'erro', 'w1', 0);
      expect(executar(parseComando('/fila'), depsSkills())).toMatch(/50%.*\(1 de 2\)/);
    });

    // A linha existe pelo histórico de erro; "0 rodando · 0 na fila" ali é ruído.
    it('fila parada que só tem histórico diz "ocioso", não dois zeros', () => {
      const j = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'x', input: '{}' });
      fila.pegar('io', 60, 'w1'); fila.falhar(j.id, 'erro', 'w1', 0);
      const r = executar(parseComando('/fila'), depsSkills());
      expect(r).toMatch(/io: .*ocioso/);
      expect(r).not.toMatch(/0 rodando · 0 na fila/);
    });

    it('estima quanto a fila leva para vazar, usando a média da tarefa', () => {
      historico('reel', [600, 600, 600]);
      for (let i = 0; i < 6; i += 1) {
        fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'reel', input: '{}' });
      }
      // 6 pendentes × 10m ÷ concorrência 1 = ~1h
      expect(executar(parseComando('/fila'), depsSkills())).toMatch(/~1h/);
    });

    it('sem média da tarefa, não inventa estimativa', () => {
      fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'novidade', input: '{}' });
      expect(executar(parseComando('/fila'), depsSkills())).not.toMatch(/~\d/);
    });
  });

  describe('/status sem id (a lista)', () => {
    it('mostra o ID, a tarefa e um pedaço do pedido de cada job', () => {
      executar(parseComando('transcrever: https://exemplo.com/video-longo', defsTeste), depsSkills());
      const r = executar(parseComando('/status'), depsSkills());
      // O id é o que faltava: sem ele não dá para usar /status, /cancelar,
      // /furar nem /refazer — era um beco sem saída no chat.
      expect(r).toMatch(/\bj1\b/);
      expect(r).toContain('transcrever');
      expect(r).toContain('exemplo.com');
    });

    it('separa o que está na fila do que já terminou', () => {
      executar(parseComando('transcrever: http://a', defsTeste), depsSkills());
      executar(parseComando('transcrever: http://b', defsTeste), depsSkills());
      fila.pegar('texto', 60, 'w1');
      fila.concluir(1, '/tmp/a.txt', 'w1');

      const r = executar(parseComando('/status'), depsSkills());
      expect(r).toContain('Na fila agora');
      expect(r).toContain('Últimos');
    });

    it('fila vazia responde algo honesto, não uma lista em branco', () => {
      expect(executar(parseComando('/status'), depsSkills())).toContain('Nada na fila');
    });

    it('job com input fora do formato do gateway não quebra a lista', () => {
      fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: 'não-json' });
      expect(() => executar(parseComando('/status'), depsSkills())).not.toThrow();
    });
  });

  describe('/refazer e duração', () => {
    it('reenfileira um job terminado preservando entrada, perfil e tentativas', () => {
      executar(parseComando('transcrever: http://x | modelo=opus', defsTeste), depsSkills());
      // max_tentativas=2: a primeira falha só requeueia. Esgotar as duas é o
      // que leva o job a um estado terminal — que é o único refazível.
      fila.pegar('texto', 60, 'w1');
      fila.falhar(1, 'deu ruim', 'w1', 30);
      t += 120;
      fila.pegar('texto', 60, 'w1');
      fila.falhar(1, 'deu ruim de novo', 'w1', 30);
      expect(fila.obter(1)!.status).toBe('failed');

      const r = executar(parseComando('/refazer 1'), depsSkills());
      const novo = fila.obter(2)!;
      expect(novo.tarefa).toBe('transcrever');
      expect(novo.input).toBe(fila.obter(1)!.input);
      expect(novo.modelo).toBe('opus');
      expect(novo.max_tentativas).toBe(2);
      expect(r).toContain('job 2');
      // O velho continua lá: `jobs` é o histórico e nunca é deletado.
      expect(fila.obter(1)!.status).toBe('failed');
    });

    // Refazer um job vivo poria dois jobs no mesmo trabalho — em render, dois
    // processos na mesma GPU.
    it('recusa refazer job ainda na fila ou rodando', () => {
      executar(parseComando('transcrever: http://x', defsTeste), depsSkills());
      expect(executar(parseComando('/refazer 1'), depsSkills())).toMatch(/ainda está queued/);
      fila.pegar('texto', 60, 'w1');
      expect(executar(parseComando('/refazer 1'), depsSkills())).toMatch(/ainda está running/);
      expect(fila.listar()).toHaveLength(1);
    });

    it('/status mostra a duração de um job terminado', () => {
      executar(parseComando('transcrever: http://x', defsTeste), depsSkills());
      fila.pegar('texto', 60, 'w1');
      t += 90;
      fila.concluir(1, '/tmp/a.txt', 'w1');
      expect(executar(parseComando('/status 1'), depsSkills())).toContain('duração: 1m');
    });
  });

  it('desconhecido aponta para /ajuda e não ecoa o texto cru', () => {
    const texto = 'segredo-super-especifico-xyz';
    const r = executar(parseComando(texto), deps());
    expect(r).toMatch(/\/ajuda|\/help/);
    expect(r).not.toContain(texto);
  });

  it('http enfileira na fila io e responde com o id', () => {
    const r = executar(parseComando('http https://exemplo.com/a'), deps());
    const job = fila.obter(1)!;
    expect(job.fila).toBe('io');
    expect(job.kind).toBe('function');
    expect(job.tarefa).toBe('http.get');
    expect(JSON.parse(job.input)).toEqual({ url: 'https://exemplo.com/a' });
    expect(job.chat_id).toBe(42);
    expect(r).toContain('1');
  });

  it('thumb enfileira na fila cpu e responde com o id', () => {
    const r = executar(parseComando('thumb /media/v.mp4'), deps());
    const job = fila.obter(1)!;
    expect(job.fila).toBe('cpu');
    expect(job.tarefa).toBe('ffmpeg.thumb');
    expect(JSON.parse(job.input)).toEqual({ entrada: '/media/v.mp4' });
    expect(r).toContain('1');
  });

  describe('/status', () => {
    it('mostra status, tarefa, fila e tentativas de um job existente', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const r = executar(parseComando(`/status ${job.id}`), deps());
      expect(r).toMatch(/queued/);
      expect(r).toMatch(/http\.get/);
      expect(r).toMatch(/io/);
    });

    it('mostra o erro quando o job falhou', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      fila.falhar(job.id, 'timeout de rede', 'w1', 30);
      // segunda falha sem mais tentativas -> failed
      const r = executar(parseComando(`/status ${job.id}`), deps());
      expect(r).toMatch(/failed|queued/);
    });

    it('mostra o resultado quando o job terminou', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      fila.concluir(job.id, 'ok-resultado', 'w1');
      const r = executar(parseComando(`/status ${job.id}`), deps());
      expect(r).toMatch(/done/);
      expect(r).toContain('ok-resultado');
    });

    it('recusa id que não existe neste bot, sem agir em job algum', () => {
      const r = executar(parseComando('/status 999'), deps());
      expect(r).toMatch(/não é deste bot|não existe/i);
    });

    it('recusa id prefixado no formato do bot antigo (V#5), sem agir em job algum', () => {
      const antes = fila.listar();
      const r = executar(parseComando('/status V#5'), deps());
      expect(r).toMatch(/não reconhecido|não é deste bot|não existe/i);
      expect(fila.listar()).toEqual(antes);
    });

    it('recusa id prefixado no formato do bot antigo (T#7), sem agir em job algum', () => {
      const antes = fila.listar();
      const r = executar(parseComando('/status T#7'), deps());
      expect(r).toMatch(/não reconhecido|não é deste bot|não existe/i);
      expect(fila.listar()).toEqual(antes);
    });
  });

  describe('/cancelar', () => {
    it('cancela job pendente', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const r = executar(parseComando(`/cancelar ${job.id}`), deps());
      expect(r).toMatch(/cancelad/i);
      expect(fila.obter(job.id)!.status).toBe('canceled');
    });

    it('num job done não mente: diz que nada foi cancelado', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      fila.concluir(job.id, 'ok', 'w1');
      const r = executar(parseComando(`/cancelar ${job.id}`), deps());
      expect(r).toMatch(/não|nada/i);
      expect(r).not.toMatch(/^cancelad/i);
      expect(fila.obter(job.id)!.status).toBe('done');
    });

    it('recusa id inexistente', () => {
      const r = executar(parseComando('/cancelar 999'), deps());
      expect(r).toMatch(/não é deste bot|não existe/i);
    });
  });

  describe('/furar', () => {
    it('põe o job na frente da fila', () => {
      const a = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const b = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      executar(parseComando(`/furar ${b.id}`), deps());
      expect(fila.pegar('io', 60, 'w')!.id).toBe(b.id);
      expect(fila.pegar('io', 60, 'w')!.id).toBe(a.id);
    });

    it('em job já running não muda nada e avisa', () => {
      const a = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      const antes = fila.obter(a.id)!.prioridade;
      const r = executar(parseComando(`/furar ${a.id}`), deps());
      expect(r).toMatch(/não|nada/i);
      expect(fila.obter(a.id)!.prioridade).toBe(antes);
    });

    it('recusa id inexistente', () => {
      const r = executar(parseComando('/furar 999'), deps());
      expect(r).toMatch(/não é deste bot|não existe/i);
    });
  });

  describe('/fila', () => {
    it('numa fila vazia não divide por zero nem quebra', () => {
      expect(() => executar(parseComando('/fila'), deps())).not.toThrow();
      const r = executar(parseComando('/fila'), deps());
      expect(r.length).toBeGreaterThan(0);
    });

    it('resume rodando/pendentes/idade do mais antigo/taxa de erro', () => {
      fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const b = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      t = 2_000;
      const r = executar(parseComando('/fila'), deps());
      expect(r).toMatch(/io/);
      expect(r).toMatch(/1/); // 1 rodando
    });
  });
});

describe('verbo insensível a maiúsculas (teclado de celular capitaliza)', () => {
  it('/HELP, /Ping e /FILA são reconhecidos', () => {
    expect(parseComando('/HELP')).toEqual({ tipo: 'ajuda' });
    expect(parseComando('/Ping')).toEqual({ tipo: 'ping' });
    expect(parseComando('/FILA')).toEqual({ tipo: 'fila' });
  });

  it('o ARGUMENTO não é normalizado — caminho e URL diferenciam caixa', () => {
    expect(parseComando('HTTP https://Exemplo.test/Caminho')).toEqual({
      tipo: 'http', url: 'https://Exemplo.test/Caminho',
    });
    expect(parseComando('Thumb /home/Me/Video.MP4')).toEqual({
      tipo: 'thumb', entrada: '/home/Me/Video.MP4',
    });
  });

  it('/ajuda tudo lista o alias /help', () => {
    const r = executar(parseComando('/ajuda tudo'), { fila, chatId: 42, agora: () => 1_000 });
    expect(r).toContain('/help');
  });
});
